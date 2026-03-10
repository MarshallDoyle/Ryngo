// RYNGO: Auto-approval system for Claude Code and Codex permission prompts.
//
// When an agent asks for permission, this module decides how to respond:
//   - ALLOW_ALWAYS ("yes, and don't ask again") — the default for most actions
//   - ALLOW_ONCE ("yes, just this once") — for sensitive but reasonable actions
//   - DENY ("no") — only for truly destructive actions (drop database, rm -rf /, etc.)
//
// Decision flow:
//   1. Fast heuristic check against deny-list patterns
//   2. If Gemma 3n is loaded, ask the LLM for a nuanced decision
//   3. If Gemma isn't loaded, use heuristic classification

use regex::Regex;

/// The decision made by the auto-approval system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    /// Allow and don't ask again — the most common response.
    AllowAlways,
    /// Allow this one time.
    AllowOnce,
    /// Deny the action.
    Deny,
}

impl ApprovalDecision {
    pub fn label(&self) -> &'static str {
        match self {
            ApprovalDecision::AllowAlways => "allow-always",
            ApprovalDecision::AllowOnce => "allow-once",
            ApprovalDecision::Deny => "deny",
        }
    }
}

/// Patterns that should ALWAYS be denied — truly destructive operations.
/// IMPORTANT: These are used as regex patterns against ~2KB of buffer text,
/// so they must be specific enough to avoid false positives.
const DENY_PATTERNS: &[&str] = &[
    // Database destruction — require SQL-like context
    r"DROP\s+DATABASE",
    r"DROP\s+SCHEMA",
    r"DROP\s+TABLE\s+.*CASCADE",
    r"TRUNCATE\s+.*CASCADE",
    // Filesystem destruction — must be exact command patterns
    r"rm\s+-rf\s+/$",        // rm -rf / (root)
    r"rm\s+-rf\s+/\*",       // rm -rf /*
    r"rm\s+-rf\s+~/?$",      // rm -rf ~ or rm -rf ~/
    r"rm\s+-rf\s+\$HOME",    // rm -rf $HOME
    r"rm\s+-rf\s+\.\.$",     // rm -rf .. (parent dir)
    r"mkfs\s+/dev/",         // formatting a device
    r"dd\s+if=.*\s+of=/dev/", // writing to raw device
    // System destruction
    r":\(\)\{\s*:\|:&\s*\};:", // fork bomb
    // Git destruction (force push to main/master)
    r"git\s+push\s+.*--force\s+.*\b(main|master)\b",
    r"git\s+push\s+.*-f\s+.*\b(main|master)\b",
];

/// Patterns that warrant ALLOW_ONCE instead of ALLOW_ALWAYS.
/// These must be specific enough to avoid false matches against the full
/// ~2KB PTY buffer which includes Claude Code UI chrome, previous output, etc.
const SENSITIVE_PATTERNS: &[&str] = &[
    // Elevated privileges — require command-like context
    r"\bsudo\s+\S",
    // Git operations that modify remote
    r"git\s+push\b",
    r"git\s+reset\s+--hard",
    // File deletion (non-catastrophic but notable)
    r"rm\s+-rf\s+\S",
    r"rm\s+-r\s+\S",
];

/// Fast heuristic classification of a permission prompt.
/// Returns the decision based on pattern matching alone.
pub fn heuristic_classify(prompt_text: &str) -> ApprovalDecision {
    let _upper = prompt_text.to_uppercase();
    let lower = prompt_text.to_lowercase();

    // Check deny patterns first — these are non-negotiable.
    // Patterns use regex syntax (e.g. .* for wildcards).
    for pattern in DENY_PATTERNS {
        if let Ok(re) = Regex::new(&format!("(?i){}", pattern)) {
            if re.is_match(prompt_text) {
                log::warn!(
                    "RYNGO auto-approve: DENY — matched destructive pattern: {}",
                    pattern
                );
                return ApprovalDecision::Deny;
            }
        }
    }

    // Check sensitive patterns — these get AllowOnce.
    // Some patterns use regex syntax (export.*KEY), others are literal substrings.
    for pattern in SENSITIVE_PATTERNS {
        if let Ok(re) = Regex::new(&format!("(?i){}", pattern)) {
            if re.is_match(prompt_text) {
                log::info!(
                    "RYNGO auto-approve: ALLOW_ONCE — matched sensitive pattern: {}",
                    pattern
                );
                return ApprovalDecision::AllowOnce;
            }
        }
    }

    // Everything else is safe — AllowAlways
    log::info!("RYNGO auto-approve: ALLOW_ALWAYS — no concerning patterns found");
    ApprovalDecision::AllowAlways
}

/// Build a Gemma 3n prompt to classify a permission request.
/// The LLM returns one of: ALLOW_ALWAYS, ALLOW_ONCE, DENY
pub fn build_llm_classification_prompt(prompt_text: &str) -> String {
    format!(
        "<start_of_turn>user\n\
You are a security classifier for an AI coding terminal. An AI coding agent (Claude Code) is asking for permission to perform an action. Your job is to classify the risk level.

RULES:
- ALLOW_ALWAYS: Safe operations. File reads, edits, code generation, running tests, git status, git add, git commit, searching files, creating files, running build commands, linting, formatting. This is the DEFAULT — most actions are safe.
- ALLOW_ONCE: Sensitive but reasonable. Installing packages (npm/pip/brew install), network requests (curl/wget), sudo commands, git push, deleting files (rm -rf on project dirs), modifying environment variables with secrets.
- DENY: Truly destructive and illogical. Dropping entire databases, rm -rf / (root filesystem), force pushing to main/master, fork bombs, formatting disks, shutting down the system, piping unknown remote scripts to shell. These are actions that could cause irreversible damage to the system or data beyond the current project.

Respond with EXACTLY one word: ALLOW_ALWAYS or ALLOW_ONCE or DENY

Permission prompt from Claude Code:
---
{prompt_text}
---
<end_of_turn>
<start_of_turn>model\n"
    )
}

/// Parse the LLM's response into a decision.
pub fn parse_llm_response(response: &str) -> ApprovalDecision {
    let trimmed = response.trim().to_uppercase();

    if trimmed.contains("DENY") {
        ApprovalDecision::Deny
    } else if trimmed.contains("ALLOW_ONCE") || trimmed.contains("ALLOW ONCE") {
        ApprovalDecision::AllowOnce
    } else if trimmed.contains("ALLOW_ALWAYS") || trimmed.contains("ALLOW ALWAYS") || trimmed.contains("ALLOW") {
        ApprovalDecision::AllowAlways
    } else {
        // If we can't parse the response, default to AllowOnce (safe middle ground)
        log::warn!(
            "RYNGO auto-approve: couldn't parse LLM response '{}', defaulting to ALLOW_ONCE",
            response
        );
        ApprovalDecision::AllowOnce
    }
}

/// The keystrokes to send to Claude Code for each decision.
/// Claude Code has two permission prompt formats:
///   3-option: 1. Yes | 2. Yes, and don't ask again | 3. No
///   2-option: 1. Yes | 2. No
/// We detect which format from the prompt text and adjust accordingly.
pub fn decision_to_keystrokes(decision: ApprovalDecision, prompt_text: &str) -> &'static [u8] {
    // RYNGO: Detect if this is a 3-option menu (has "don't ask again" / "don.taskagain")
    let has_dont_ask_again = prompt_text.contains("don't ask again")
        || prompt_text.contains("don\u{2019}t ask again")  // smart quote
        || prompt_text.contains("don.taskagain")            // spaces stripped
        || prompt_text.contains("don'taskagain");           // partial strip

    if has_dont_ask_again {
        // 3-option menu: 1=Yes, 2=Yes+don't ask again, 3=No
        match decision {
            ApprovalDecision::AllowAlways => b"2",
            ApprovalDecision::AllowOnce => b"1",
            ApprovalDecision::Deny => b"3",
        }
    } else {
        // 2-option menu: 1=Yes, 2=No
        match decision {
            ApprovalDecision::AllowAlways => b"1",  // Can't "don't ask again", just Yes
            ApprovalDecision::AllowOnce => b"1",
            ApprovalDecision::Deny => b"2",
        }
    }
}

/// Pending approval request — queued by the detector, consumed by the auto-approve thread.
#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    /// The pane that needs approval
    pub pane_id: usize,
    /// The permission prompt text (extracted from rolling buffer)
    pub prompt_text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deny_rm_rf_root() {
        assert_eq!(
            heuristic_classify("Claude wants to run: rm -rf /"),
            ApprovalDecision::Deny
        );
    }

    #[test]
    fn test_deny_drop_database() {
        assert_eq!(
            heuristic_classify("Execute SQL: DROP DATABASE production"),
            ApprovalDecision::Deny
        );
    }

    #[test]
    fn test_deny_force_push_main() {
        assert_eq!(
            heuristic_classify("Run: git push --force origin main"),
            ApprovalDecision::Deny
        );
    }

    #[test]
    fn test_allow_once_sudo() {
        assert_eq!(
            heuristic_classify("Run: sudo apt update"),
            ApprovalDecision::AllowOnce
        );
    }

    #[test]
    fn test_allow_always_npm_install() {
        // npm install is safe — not in sensitive patterns anymore
        assert_eq!(
            heuristic_classify("Run: npm install express"),
            ApprovalDecision::AllowAlways
        );
    }

    #[test]
    fn test_allow_always_file_read() {
        assert_eq!(
            heuristic_classify("Read file: src/main.rs"),
            ApprovalDecision::AllowAlways
        );
    }

    #[test]
    fn test_allow_always_cargo_build() {
        assert_eq!(
            heuristic_classify("Run: cargo build --release"),
            ApprovalDecision::AllowAlways
        );
    }

    #[test]
    fn test_allow_always_git_commit() {
        assert_eq!(
            heuristic_classify("Run: git commit -m 'fix bug'"),
            ApprovalDecision::AllowAlways
        );
    }

    #[test]
    fn test_allow_always_edit_file() {
        assert_eq!(
            heuristic_classify("Edit file: config/src/config.rs"),
            ApprovalDecision::AllowAlways
        );
    }

    #[test]
    fn test_parse_llm_allow_always() {
        assert_eq!(parse_llm_response("ALLOW_ALWAYS"), ApprovalDecision::AllowAlways);
        assert_eq!(parse_llm_response("ALLOW_ALWAYS\n"), ApprovalDecision::AllowAlways);
        assert_eq!(parse_llm_response(" allow_always "), ApprovalDecision::AllowAlways);
    }

    #[test]
    fn test_parse_llm_allow_once() {
        assert_eq!(parse_llm_response("ALLOW_ONCE"), ApprovalDecision::AllowOnce);
    }

    #[test]
    fn test_parse_llm_deny() {
        assert_eq!(parse_llm_response("DENY"), ApprovalDecision::Deny);
    }

    #[test]
    fn test_parse_llm_garbage() {
        // Unknown response defaults to AllowOnce (safe middle ground)
        assert_eq!(parse_llm_response("I think maybe"), ApprovalDecision::AllowOnce);
    }

    #[test]
    fn test_no_false_positive_on_buffer_content() {
        // Realistic Claude Code buffer content — should NOT trigger deny or sensitive
        let buffer = "Runshellcommand\n\nCommandcontainsquotedcharactersinflagnames\n\nDoyouwanttoproceed?\n❯1.Yes\n2.No\n\nEsctocancel·Tabtoamend·ctrl+etoexplain\n";
        assert_eq!(heuristic_classify(buffer), ApprovalDecision::AllowAlways);
    }

    #[test]
    fn test_no_false_positive_shortcuts() {
        // The word "shortcuts" should not match anything
        let buffer = "?forshortcuts\n◐ medium · /effort\n";
        assert_eq!(heuristic_classify(buffer), ApprovalDecision::AllowAlways);
    }

    #[test]
    fn test_allow_once_rm_rf_dir() {
        assert_eq!(
            heuristic_classify("Run: rm -rf ./node_modules"),
            ApprovalDecision::AllowOnce
        );
    }

    #[test]
    fn test_allow_once_git_push() {
        assert_eq!(
            heuristic_classify("Run: git push origin feature-branch"),
            ApprovalDecision::AllowOnce
        );
    }
}
