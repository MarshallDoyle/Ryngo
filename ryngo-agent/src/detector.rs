// RYNGO: PTY output pattern matching for Claude Code and Codex detection.
// Receives raw terminal output bytes, strips ANSI escapes, and matches patterns
// to identify agent type and current state.

use crate::auto_approve::ApprovalRequest;
use crate::status::{AgentInfo, AgentState};
use parking_lot::RwLock;
use regex::Regex;
use std::collections::HashMap;
use std::sync::mpsc;

lazy_static::lazy_static! {
    /// Global agent detector instance, shared between the PTY reader thread and the GUI.
    pub static ref GLOBAL_DETECTOR: AgentDetector = AgentDetector::new();
}

/// The type of AI agent detected in a pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentType {
    ClaudeCode,
    Codex,
}

impl AgentType {
    pub fn display_name(&self) -> &'static str {
        match self {
            AgentType::ClaudeCode => "Claude Code",
            AgentType::Codex => "Codex",
        }
    }
}

/// Rolling text buffer for a single pane. We keep recent output (stripped of ANSI)
/// for pattern matching. The buffer is bounded to avoid unbounded memory growth.
struct PaneBuffer {
    /// Accumulated text with ANSI escapes stripped.
    text: String,
    /// Maximum buffer size in bytes. Older text is dropped from the front.
    max_size: usize,
}

impl PaneBuffer {
    fn new() -> Self {
        Self {
            text: String::with_capacity(8192),
            max_size: 32768, // 32 KB rolling window per pane
        }
    }

    /// Append raw PTY bytes. Strips ANSI escape sequences to get plain text.
    fn push(&mut self, raw: &[u8]) {
        let text = String::from_utf8_lossy(raw);
        let clean = strip_ansi(&text);
        self.text.push_str(&clean);

        // Trim from front if over max size
        if self.text.len() > self.max_size {
            let excess = self.text.len() - self.max_size;
            // Find a safe char boundary to split at
            let drain_to = self.text.ceil_char_boundary(excess);
            self.text.drain(..drain_to);
        }
    }

    /// Get the last N bytes of the buffer for pattern matching.
    fn recent(&self, bytes: usize) -> &str {
        let start = self.text.len().saturating_sub(bytes);
        let start = self.text.ceil_char_boundary(start);
        &self.text[start..]
    }

    fn clear(&mut self) {
        self.text.clear();
    }
}

/// Strip ANSI/VT100 escape sequences from text, keeping only printable content.
fn strip_ansi(input: &str) -> String {
    lazy_static::lazy_static! {
        static ref ANSI_RE: Regex = Regex::new(
            r"(?x)
            \x1b\[[\x20-\x3f]*[a-zA-Z@-~]  |  # CSI sequences (incl. private ?/> modes)
            \x1b\][^\x07\x1b]*(?:\x07|\x1b\\) |  # OSC sequences
            \x1b[()][0-9A-B]           |  # Character set selection
            \x1b[=>Nc78]               |  # Simple escape sequences
            \x07                       |  # Bell
            \r                            # Carriage return
            "
        ).unwrap();
    }
    ANSI_RE.replace_all(input, "").into_owned()
}

/// Patterns for detecting Claude Code.
struct ClaudeCodePatterns {
    /// Claude Code banner / startup
    startup: Regex,
    /// Permission prompt (Allow/Deny)
    permission_prompt: Regex,
    /// Tool use blocks (box drawing characters)
    tool_use: Regex,
    /// Thinking indicator
    thinking: Regex,
    /// Prompt return (Claude Code is idle, waiting for input)
    idle_prompt: Regex,
    /// Error patterns
    error: Regex,
    /// Tool name extraction from tool use blocks
    tool_name: Regex,
}

impl ClaudeCodePatterns {
    fn new() -> Self {
        Self {
            startup: Regex::new(r"(?i)claude[\s_-]*code|╭─.*claude|Claude Code").unwrap(),
            permission_prompt: Regex::new(
                // RYNGO: Claude Code TUI renders via cursor positioning, so spaces
                // may be missing. Match spaceless and spaced variants.
                // Key patterns: "Do you want to proceed", "Yes, and don't ask again",
                // and the 1/2/3 numbered menu items.
                r"(?i)Do\s*you\s*want\s*to\s*proceed|Yes,?\s*and\s*don.?t\s*ask\s*again|don.?taskagain|1\.?\s*Yes\s*2\.?\s*Yes|allowtool"
            ).unwrap(),
            tool_use: Regex::new(r"[╭╰│├┤┬┴┼─]").unwrap(),
            thinking: Regex::new(
                r"(?i)thinking|Thinking\.\.\.|processing|generating"
            ).unwrap(),
            idle_prompt: Regex::new(r"(?m)^>\s*$|╰─.*$|Tokens remaining").unwrap(),
            error: Regex::new(
                r"(?i)error|Error:|failed|panic|FATAL|aborted|timed? ?out"
            ).unwrap(),
            tool_name: Regex::new(
                r"(?i)(Read|Edit|Write|Bash|Glob|Grep|WebFetch|WebSearch|Task|NotebookEdit)\b"
            ).unwrap(),
        }
    }
}

/// Patterns for detecting Codex.
struct CodexPatterns {
    startup: Regex,
    thinking: Regex,
    writing: Regex,
    idle: Regex,
    error: Regex,
}

impl CodexPatterns {
    fn new() -> Self {
        Self {
            startup: Regex::new(r"(?i)codex|openai").unwrap(),
            thinking: Regex::new(r"(?i)thinking|processing|searching").unwrap(),
            writing: Regex::new(r"(?i)writing|editing|applying|patching").unwrap(),
            idle: Regex::new(r"(?i)ready|waiting|idle|\$\s*$").unwrap(),
            error: Regex::new(r"(?i)error|failed|aborted").unwrap(),
        }
    }
}

/// The main agent detector. Holds per-pane buffers and detected agent state.
/// Thread-safe via RwLock — PTY reader threads write, GUI reads.
pub struct AgentDetector {
    /// Per-pane rolling text buffers (pane_id -> buffer).
    buffers: RwLock<HashMap<usize, PaneBuffer>>,
    /// Per-pane detected agent info (pane_id -> agent info).
    agents: RwLock<HashMap<usize, AgentInfo>>,
    /// Compiled regex patterns (computed once).
    claude_patterns: ClaudeCodePatterns,
    codex_patterns: CodexPatterns,
    /// Channel sender for approval requests — consumed by the auto-approve thread.
    approval_tx: RwLock<Option<mpsc::Sender<ApprovalRequest>>>,
}

impl AgentDetector {
    pub fn new() -> Self {
        Self {
            buffers: RwLock::new(HashMap::new()),
            agents: RwLock::new(HashMap::new()),
            claude_patterns: ClaudeCodePatterns::new(),
            codex_patterns: CodexPatterns::new(),
            approval_tx: RwLock::new(None),
        }
    }

    /// Set the channel for sending approval requests to the auto-approve thread.
    /// Call this once during startup from main.rs.
    pub fn set_approval_channel(&self, tx: mpsc::Sender<ApprovalRequest>) {
        *self.approval_tx.write() = Some(tx);
    }

    /// Called from the PTY reader thread when new output arrives for a pane.
    /// This is the main entry point — it accumulates text and runs detection.
    pub fn on_output(&self, pane_id: usize, raw: &[u8]) {
        // Append to the rolling buffer
        {
            let mut buffers = self.buffers.write();
            let buf = buffers.entry(pane_id).or_insert_with(PaneBuffer::new);
            buf.push(raw);
        }

        // Run detection on recent output
        let recent = {
            let buffers = self.buffers.read();
            match buffers.get(&pane_id) {
                Some(buf) => buf.recent(4096).to_string(),
                None => return,
            }
        };

        self.detect_and_update(pane_id, &recent);
    }

    /// Run pattern matching on recent output and update agent state.
    fn detect_and_update(&self, pane_id: usize, recent: &str) {
        // First, try to detect which agent is running (if not already known)
        let mut agents = self.agents.write();
        let prev_state = agents.get(&pane_id).map(|a| a.state);
        let agent_type = agents.get(&pane_id).map(|a| a.agent_type);

        match agent_type {
            None => {
                // Try to identify the agent from output patterns
                if self.claude_patterns.startup.is_match(recent) {
                    log::info!("Detected Claude Code in pane {}", pane_id);
                    let mut info = AgentInfo::new(AgentType::ClaudeCode);
                    self.classify_claude_state(&mut info, recent);
                    agents.insert(pane_id, info);
                } else if self.codex_patterns.startup.is_match(recent) {
                    log::info!("Detected Codex in pane {}", pane_id);
                    let mut info = AgentInfo::new(AgentType::Codex);
                    self.classify_codex_state(&mut info, recent);
                    agents.insert(pane_id, info);
                }
            }
            Some(AgentType::ClaudeCode) => {
                if let Some(info) = agents.get_mut(&pane_id) {
                    self.classify_claude_state(info, recent);
                }
            }
            Some(AgentType::Codex) => {
                if let Some(info) = agents.get_mut(&pane_id) {
                    self.classify_codex_state(info, recent);
                }
            }
        }

        // RYNGO: If state just transitioned TO WaitingForApproval, fire an approval request.
        let new_state = agents.get(&pane_id).map(|a| a.state);
        if new_state == Some(AgentState::WaitingForApproval)
            && prev_state != Some(AgentState::WaitingForApproval)
        {
            // Extract the prompt text from the last ~2KB of the buffer
            let prompt_text = {
                let buffers = self.buffers.read();
                buffers
                    .get(&pane_id)
                    .map(|b| b.recent(2048).to_string())
                    .unwrap_or_default()
            };

            if let Some(tx) = self.approval_tx.read().as_ref() {
                let req = ApprovalRequest {
                    pane_id,
                    prompt_text,
                };
                log::info!(
                    "RYNGO: Sending auto-approval request for pane {} ({} bytes of context)",
                    pane_id,
                    req.prompt_text.len()
                );
                if let Err(e) = tx.send(req) {
                    log::error!("RYNGO: Failed to send approval request: {}", e);
                }
            } else {
                log::debug!(
                    "RYNGO: No approval channel set — skipping auto-approve for pane {}",
                    pane_id
                );
            }
        }
    }

    /// Classify Claude Code state from recent output.
    /// Priority: permission prompt > error > thinking > writing (tool use) > idle
    fn classify_claude_state(&self, info: &mut AgentInfo, recent: &str) {
        // Use the last ~1KB for state classification (most recent activity)
        let tail = if recent.len() > 1024 {
            let start = recent.len() - 1024;
            let start = recent.ceil_char_boundary(start);
            &recent[start..]
        } else {
            recent
        };

        // Extract tool name if present
        if let Some(m) = self.claude_patterns.tool_name.find(tail) {
            info.last_tool = Some(m.as_str().to_string());
        }

        // Classify state — check most specific patterns first.
        let has_permission = self.claude_patterns.permission_prompt.is_match(tail);
        let has_tool_use = self.claude_patterns.tool_use.is_match(tail);
        let has_thinking = self.claude_patterns.thinking.is_match(tail);
        let has_idle = self.claude_patterns.idle_prompt.is_match(tail);
        let has_error = self.claude_patterns.error.is_match(tail) && !has_tool_use;

        // Only log on state changes or permission detection to avoid log spam
        let new_state_hint = if has_permission && !has_idle {
            Some("WaitingForApproval")
        } else if has_error {
            Some("Errored")
        } else if has_thinking {
            Some("Thinking")
        } else if has_tool_use && !has_permission {
            Some("Writing")
        } else if has_idle {
            Some("Idle")
        } else {
            None
        };
        let prev_state = info.state;
        let state_changing = new_state_hint.map_or(false, |hint| {
            format!("{:?}", prev_state) != hint
        });
        if state_changing || has_permission {
            log::info!(
                "RYNGO classify pane: permission={} tool_use={} thinking={} idle={} error={} (current={:?} -> {})",
                has_permission, has_tool_use, has_thinking, has_idle, has_error, info.state,
                new_state_hint.unwrap_or("unchanged")
            );
        }

        if has_permission && !has_idle {
            // Permission prompt detected — but only if we're not also seeing idle
            // (which means the prompt was already answered)
            info.set_state(AgentState::WaitingForApproval);
        } else if has_error {
            info.set_state(AgentState::Errored);
        } else if has_thinking {
            info.set_state(AgentState::Thinking);
        } else if has_tool_use && !has_permission {
            info.set_state(AgentState::Writing);
        } else if has_idle {
            info.set_state(AgentState::Idle);
        }
        // If none match, keep current state
    }

    /// Classify Codex state from recent output.
    fn classify_codex_state(&self, info: &mut AgentInfo, recent: &str) {
        let tail = if recent.len() > 1024 {
            let start = recent.len() - 1024;
            let start = recent.ceil_char_boundary(start);
            &recent[start..]
        } else {
            recent
        };

        if self.codex_patterns.error.is_match(tail) {
            info.set_state(AgentState::Errored);
        } else if self.codex_patterns.thinking.is_match(tail) {
            info.set_state(AgentState::Thinking);
        } else if self.codex_patterns.writing.is_match(tail) {
            info.set_state(AgentState::Writing);
        } else if self.codex_patterns.idle.is_match(tail) {
            info.set_state(AgentState::Idle);
        }
    }

    /// Get the agent info for a specific pane (called by GUI for status bar).
    pub fn get_agent(&self, pane_id: usize) -> Option<AgentInfo> {
        self.agents.read().get(&pane_id).cloned()
    }

    /// Get all detected agents (for :agents command).
    pub fn all_agents(&self) -> Vec<(usize, AgentInfo)> {
        self.agents
            .read()
            .iter()
            .map(|(id, info)| (*id, info.clone()))
            .collect()
    }

    /// Remove tracking for a pane (called when pane is closed).
    pub fn remove_pane(&self, pane_id: usize) {
        self.buffers.write().remove(&pane_id);
        self.agents.write().remove(&pane_id);
    }

    /// Mark an agent as exited (called when the pane's child process exits).
    pub fn mark_exited(&self, pane_id: usize) {
        if let Some(info) = self.agents.write().get_mut(&pane_id) {
            info.set_state(AgentState::Exited);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_ansi() {
        let input = "\x1b[32mHello\x1b[0m World";
        assert_eq!(strip_ansi(input), "Hello World");
    }

    #[test]
    fn test_strip_ansi_osc() {
        let input = "\x1b]0;title\x07visible text";
        assert_eq!(strip_ansi(input), "visible text");
    }

    #[test]
    fn test_detect_claude_code() {
        let detector = AgentDetector::new();
        let output = b"Welcome to Claude Code!\n> ";
        detector.on_output(1, output);
        let agent = detector.get_agent(1);
        assert!(agent.is_some());
        assert_eq!(agent.unwrap().agent_type, AgentType::ClaudeCode);
    }

    #[test]
    fn test_detect_permission_prompt_3option() {
        let detector = AgentDetector::new();
        detector.on_output(1, b"Claude Code v1.0\n");
        // Realistic 3-option permission prompt (spaces stripped as in real TUI output)
        detector.on_output(1, b"Doyouwanttoproceed?\n\xe2\x9d\xaf1.Yes\n2.Yes,anddon'taskagainfor:Bash\n3.No\n");
        let agent = detector.get_agent(1).unwrap();
        assert_eq!(agent.state, AgentState::WaitingForApproval);
    }

    #[test]
    fn test_detect_permission_prompt_2option() {
        let detector = AgentDetector::new();
        detector.on_output(1, b"Claude Code v1.0\n");
        // Realistic 2-option permission prompt
        detector.on_output(1, b"Doyouwanttoproceed?\n\xe2\x9d\xaf1.Yes\n2.No\n");
        let agent = detector.get_agent(1).unwrap();
        assert_eq!(agent.state, AgentState::WaitingForApproval);
    }

    #[test]
    fn test_detect_thinking() {
        let detector = AgentDetector::new();
        detector.on_output(1, b"Claude Code\n");
        detector.on_output(1, b"Thinking...\n");
        let agent = detector.get_agent(1).unwrap();
        assert_eq!(agent.state, AgentState::Thinking);
    }

    #[test]
    fn test_no_detection_for_regular_shell() {
        let detector = AgentDetector::new();
        detector.on_output(1, b"$ ls -la\ntotal 42\ndrwxr-xr-x  5 user staff\n");
        assert!(detector.get_agent(1).is_none());
    }

    #[test]
    fn test_pane_removal() {
        let detector = AgentDetector::new();
        detector.on_output(1, b"Claude Code\n");
        assert!(detector.get_agent(1).is_some());
        detector.remove_pane(1);
        assert!(detector.get_agent(1).is_none());
    }
}
