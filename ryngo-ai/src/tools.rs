// RYNGO: Tool definitions and executor for the autonomous agent loop.
// Gemma 3n outputs <tool>JSON</tool> tags; this module parses and executes them.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/// A tool call parsed from LLM output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "name", rename_all = "lowercase")]
pub enum Tool {
    Bash {
        command: String,
    },
    Read {
        path: String,
    },
    Write {
        path: String,
        content: String,
    },
    Ls {
        path: String,
    },
    Grep {
        pattern: String,
        path: String,
    },
}

impl Tool {
    /// Human-readable name for display in the overlay.
    pub fn display_name(&self) -> &str {
        match self {
            Tool::Bash { .. } => "bash",
            Tool::Read { .. } => "read",
            Tool::Write { .. } => "write",
            Tool::Ls { .. } => "ls",
            Tool::Grep { .. } => "grep",
        }
    }

    /// Short summary for display (truncated command/path).
    pub fn summary(&self) -> String {
        match self {
            Tool::Bash { command } => {
                let trunc = if command.len() > 60 {
                    format!("{}...", &command[..57])
                } else {
                    command.clone()
                };
                format!("$ {}", trunc)
            }
            Tool::Read { path } => format!("read {}", path),
            Tool::Write { path, .. } => format!("write {}", path),
            Tool::Ls { path } => format!("ls {}", path),
            Tool::Grep { pattern, path } => format!("grep '{}' {}", pattern, path),
        }
    }
}

/// Result of executing a tool.
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub tool: String,
    pub success: bool,
    pub output: String,
}

// ---------------------------------------------------------------------------
// Tool call parsing
// ---------------------------------------------------------------------------

/// Extract all `<tool>JSON</tool>` blocks from LLM output.
/// Returns the parsed tools and the text segments between them.
pub fn parse_tool_calls(text: &str) -> Vec<Tool> {
    let mut tools = Vec::new();
    let mut search_from = 0;

    while let Some(start) = text[search_from..].find("<tool>") {
        let abs_start = search_from + start + 6; // skip "<tool>"
        if let Some(end) = text[abs_start..].find("</tool>") {
            let json_str = text[abs_start..abs_start + end].trim();
            match serde_json::from_str::<Tool>(json_str) {
                Ok(tool) => tools.push(tool),
                Err(e) => {
                    log::warn!("Failed to parse tool call JSON: {} -- input: {}", e, json_str);
                }
            }
            search_from = abs_start + end + 7; // skip "</tool>"
        } else {
            break;
        }
    }

    tools
}

/// Check if the LLM response contains any tool calls.
pub fn has_tool_calls(text: &str) -> bool {
    text.contains("<tool>") && text.contains("</tool>")
}

// ---------------------------------------------------------------------------
// Dangerous command detection
// ---------------------------------------------------------------------------

/// Patterns that require explicit user confirmation before execution.
const DANGEROUS_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $HOME",
    "rm -rf /*",
    "sudo ",
    "mkfs",
    "dd if=",
    ":(){ :|:&};:",
    "> /dev/sda",
    "chmod -R 777 /",
    "chown -R",
    "kill -9 1",
    "shutdown",
    "reboot",
    "halt",
    "init 0",
    "init 6",
    "format c:",
    "del /f /s /q",
    "rf -rf",
];

/// Check if a tool call is dangerous and needs user confirmation.
pub fn is_dangerous(tool: &Tool) -> bool {
    match tool {
        Tool::Bash { command } => {
            let lower = command.to_lowercase();
            DANGEROUS_PATTERNS
                .iter()
                .any(|pat| lower.contains(&pat.to_lowercase()))
        }
        Tool::Write { path, .. } => {
            // Writing to system paths is dangerous
            let p = path.to_lowercase();
            p.starts_with("/etc/")
                || p.starts_with("/usr/")
                || p.starts_with("/bin/")
                || p.starts_with("/sbin/")
                || p.starts_with("/boot/")
                || p.starts_with("/sys/")
                || p.starts_with("/proc/")
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

/// Execute a tool call in the given working directory.
/// Returns the result with captured output.
pub fn execute_tool(tool: &Tool, cwd: &str) -> Result<ToolResult> {
    match tool {
        Tool::Bash { command } => execute_bash(command, cwd),
        Tool::Read { path } => execute_read(path, cwd),
        Tool::Write { path, content } => execute_write(path, content, cwd),
        Tool::Ls { path } => execute_ls(path, cwd),
        Tool::Grep { pattern, path } => execute_grep(pattern, path, cwd),
    }
}

fn resolve_path(path: &str, cwd: &str) -> String {
    if Path::new(path).is_absolute() {
        path.to_string()
    } else {
        format!("{}/{}", cwd, path)
    }
}

fn execute_bash(command: &str, cwd: &str) -> Result<ToolResult> {
    let output = Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .output()
        .context("failed to execute bash command")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let mut result = String::new();
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str("[stderr] ");
        result.push_str(&stderr);
    }

    // Truncate very long output
    if result.len() > 4000 {
        result.truncate(4000);
        result.push_str("\n... (output truncated)");
    }

    Ok(ToolResult {
        tool: "bash".to_string(),
        success: output.status.success(),
        output: if result.is_empty() {
            "(no output)".to_string()
        } else {
            result
        },
    })
}

fn execute_read(path: &str, cwd: &str) -> Result<ToolResult> {
    let resolved = resolve_path(path, cwd);
    match std::fs::read_to_string(&resolved) {
        Ok(content) => {
            // Cap at 500 lines with line numbers
            let mut output = String::new();
            for (i, line) in content.lines().take(500).enumerate() {
                output.push_str(&format!("{:>4} | {}\n", i + 1, line));
            }
            let total_lines = content.lines().count();
            if total_lines > 500 {
                output.push_str(&format!("... ({} more lines)\n", total_lines - 500));
            }
            Ok(ToolResult {
                tool: "read".to_string(),
                success: true,
                output,
            })
        }
        Err(e) => Ok(ToolResult {
            tool: "read".to_string(),
            success: false,
            output: format!("Error reading {}: {}", resolved, e),
        }),
    }
}

fn execute_write(path: &str, content: &str, cwd: &str) -> Result<ToolResult> {
    let resolved = resolve_path(path, cwd);

    // Create parent directories if needed
    if let Some(parent) = Path::new(&resolved).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create directory {}", parent.display()))?;
        }
    }

    match std::fs::write(&resolved, content) {
        Ok(()) => {
            let line_count = content.lines().count();
            Ok(ToolResult {
                tool: "write".to_string(),
                success: true,
                output: format!("Wrote {} lines to {}", line_count, resolved),
            })
        }
        Err(e) => Ok(ToolResult {
            tool: "write".to_string(),
            success: false,
            output: format!("Error writing {}: {}", resolved, e),
        }),
    }
}

fn execute_ls(path: &str, cwd: &str) -> Result<ToolResult> {
    let resolved = resolve_path(path, cwd);
    match std::fs::read_dir(&resolved) {
        Ok(entries) => {
            let mut items: Vec<String> = Vec::new();
            for entry in entries {
                if let Ok(entry) = entry {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                    if is_dir {
                        items.push(format!("  {}/", name));
                    } else {
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        items.push(format!("  {} ({})", name, format_size(size)));
                    }
                }
            }
            items.sort();
            let output = if items.is_empty() {
                "(empty directory)".to_string()
            } else {
                items.join("\n")
            };
            Ok(ToolResult {
                tool: "ls".to_string(),
                success: true,
                output,
            })
        }
        Err(e) => Ok(ToolResult {
            tool: "ls".to_string(),
            success: false,
            output: format!("Error listing {}: {}", resolved, e),
        }),
    }
}

fn execute_grep(pattern: &str, path: &str, cwd: &str) -> Result<ToolResult> {
    let resolved = resolve_path(path, cwd);
    let p = Path::new(&resolved);

    let mut matches = Vec::new();
    let max_matches = 50;

    if p.is_file() {
        grep_file(p, pattern, &mut matches, max_matches)?;
    } else if p.is_dir() {
        grep_directory(p, pattern, &mut matches, max_matches)?;
    } else {
        return Ok(ToolResult {
            tool: "grep".to_string(),
            success: false,
            output: format!("Path does not exist: {}", resolved),
        });
    }

    let output = if matches.is_empty() {
        "No matches found.".to_string()
    } else {
        let truncated = matches.len() >= max_matches;
        let mut out = matches.join("\n");
        if truncated {
            out.push_str("\n... (results truncated)");
        }
        out
    };

    Ok(ToolResult {
        tool: "grep".to_string(),
        success: true,
        output,
    })
}

fn grep_file(path: &Path, pattern: &str, matches: &mut Vec<String>, max: usize) -> Result<()> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Ok(()), // Skip binary/unreadable files
    };
    let re = regex::Regex::new(pattern).unwrap_or_else(|_| {
        // Fall back to literal match if pattern is invalid regex
        regex::Regex::new(&regex::escape(pattern)).unwrap()
    });
    let display_path = path.display().to_string();
    for (i, line) in content.lines().enumerate() {
        if matches.len() >= max {
            break;
        }
        if re.is_match(line) {
            matches.push(format!("{}:{}: {}", display_path, i + 1, line));
        }
    }
    Ok(())
}

fn grep_directory(
    dir: &Path,
    pattern: &str,
    matches: &mut Vec<String>,
    max: usize,
) -> Result<()> {
    if matches.len() >= max {
        return Ok(());
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        if matches.len() >= max {
            break;
        }
        if let Ok(entry) = entry {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden dirs and common non-text dirs
            if name.starts_with('.')
                || name == "node_modules"
                || name == "target"
                || name == "__pycache__"
                || name == ".git"
            {
                continue;
            }
            if path.is_file() {
                grep_file(&path, pattern, matches, max)?;
            } else if path.is_dir() {
                grep_directory(&path, pattern, matches, max)?;
            }
        }
    }
    Ok(())
}

fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

// ---------------------------------------------------------------------------
// Format tool results for LLM context
// ---------------------------------------------------------------------------

/// Format a tool result for inclusion in the LLM context.
pub fn format_tool_result_for_context(result: &ToolResult) -> String {
    let status = if result.success { "ok" } else { "error" };
    format!(
        "Tool [{}] ({}): {}\n",
        result.tool, status, result.output
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_tool_calls_single() {
        let text = r#"I'll list the files. <tool>{"name":"ls","path":"."}</tool>"#;
        let tools = parse_tool_calls(text);
        assert_eq!(tools.len(), 1);
        assert!(matches!(&tools[0], Tool::Ls { path } if path == "."));
    }

    #[test]
    fn test_parse_tool_calls_multiple() {
        let text = r#"First read, then list. <tool>{"name":"read","path":"foo.txt"}</tool> Now ls: <tool>{"name":"ls","path":"."}</tool>"#;
        let tools = parse_tool_calls(text);
        assert_eq!(tools.len(), 2);
    }

    #[test]
    fn test_parse_tool_calls_bash() {
        let text = r#"<tool>{"name":"bash","command":"echo hello"}</tool>"#;
        let tools = parse_tool_calls(text);
        assert_eq!(tools.len(), 1);
        assert!(matches!(&tools[0], Tool::Bash { command } if command == "echo hello"));
    }

    #[test]
    fn test_is_dangerous() {
        assert!(is_dangerous(&Tool::Bash {
            command: "sudo rm -rf /".to_string()
        }));
        assert!(is_dangerous(&Tool::Bash {
            command: "rm -rf /".to_string()
        }));
        assert!(!is_dangerous(&Tool::Bash {
            command: "echo hello".to_string()
        }));
        assert!(!is_dangerous(&Tool::Ls {
            path: ".".to_string()
        }));
    }

    #[test]
    fn test_has_tool_calls() {
        assert!(has_tool_calls(r#"<tool>{"name":"ls","path":"."}</tool>"#));
        assert!(!has_tool_calls("Just a regular response"));
    }
}
