// RYNGO: Terminal command parsing for :spawn, :agents, :kill, :models, :voice, :tts.
// Commands are prefixed with ':' and typed directly in the terminal.
// The input handler intercepts these before they reach the shell.

use crate::detector::GLOBAL_DETECTOR;

/// A parsed Ryngo terminal command.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// :spawn cc [path] — Launch Claude Code in a new tab
    SpawnClaudeCode { working_dir: Option<String> },
    /// :spawn codex [path] — Launch Codex in a new tab
    SpawnCodex { working_dir: Option<String> },
    /// :agents — List all detected agent sessions
    ListAgents,
    /// :kill <id> — Kill an agent session by pane ID
    Kill { pane_id: usize },
    /// :models — Show loaded models and status
    Models,
    /// :voice <on|off> — Toggle voice features
    Voice { enabled: bool },
    /// :tts voice <name> — Switch TTS voice
    TtsVoice { voice: String },
}

/// Try to parse a line of input as a Ryngo command.
/// Returns None if the input doesn't start with ':' or isn't a recognized command.
pub fn parse_command(input: &str) -> Option<Command> {
    let trimmed = input.trim();
    if !trimmed.starts_with(':') {
        return None;
    }

    let parts: Vec<&str> = trimmed[1..].split_whitespace().collect();
    if parts.is_empty() {
        return None;
    }

    match parts[0] {
        "spawn" => {
            if parts.len() < 2 {
                return None;
            }
            let working_dir = parts.get(2).map(|s| s.to_string());
            match parts[1] {
                "cc" | "claude" | "claude-code" => {
                    Some(Command::SpawnClaudeCode { working_dir })
                }
                "codex" => Some(Command::SpawnCodex { working_dir }),
                _ => None,
            }
        }
        "agents" => Some(Command::ListAgents),
        "kill" => {
            let pane_id = parts.get(1)?.parse::<usize>().ok()?;
            Some(Command::Kill { pane_id })
        }
        "models" => Some(Command::Models),
        "voice" => {
            let enabled = match parts.get(1)?.to_lowercase().as_str() {
                "on" | "true" | "1" | "yes" => true,
                "off" | "false" | "0" | "no" => false,
                _ => return None,
            };
            Some(Command::Voice { enabled })
        }
        "tts" => {
            if parts.get(1)? == &"voice" {
                let voice = parts.get(2)?.to_string();
                Some(Command::TtsVoice { voice })
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Format the output of :agents command as terminal text.
pub fn format_agents_list() -> String {
    let agents = GLOBAL_DETECTOR.all_agents();
    if agents.is_empty() {
        return "No AI agents detected in any pane.\n\
                Tip: Run 'claude' or 'codex' in a tab to get started.\n"
            .to_string();
    }

    let mut output = String::new();
    output.push_str("Detected AI Agents:\n");
    output.push_str("-------------------\n");
    for (pane_id, info) in &agents {
        let elapsed = info.detected_at.elapsed().as_secs();
        let duration = if elapsed >= 3600 {
            format!("{}h {}m", elapsed / 3600, (elapsed % 3600) / 60)
        } else if elapsed >= 60 {
            format!("{}m {}s", elapsed / 60, elapsed % 60)
        } else {
            format!("{}s", elapsed)
        };

        output.push_str(&format!(
            "  Pane {:>3}  {}  {}  (running {})\n",
            pane_id,
            info.agent_type.display_name(),
            info.status_string(),
            duration,
        ));

        if let Some(ref dir) = info.working_dir {
            output.push_str(&format!("            cwd: {}\n", dir));
        }
    }
    output.push_str(&format!("\n{} agent(s) total\n", agents.len()));
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_spawn_cc() {
        assert_eq!(
            parse_command(":spawn cc"),
            Some(Command::SpawnClaudeCode { working_dir: None })
        );
        assert_eq!(
            parse_command(":spawn cc /tmp/project"),
            Some(Command::SpawnClaudeCode {
                working_dir: Some("/tmp/project".to_string())
            })
        );
        assert_eq!(
            parse_command(":spawn claude"),
            Some(Command::SpawnClaudeCode { working_dir: None })
        );
    }

    #[test]
    fn test_parse_spawn_codex() {
        assert_eq!(
            parse_command(":spawn codex"),
            Some(Command::SpawnCodex { working_dir: None })
        );
    }

    #[test]
    fn test_parse_agents() {
        assert_eq!(parse_command(":agents"), Some(Command::ListAgents));
    }

    #[test]
    fn test_parse_kill() {
        assert_eq!(
            parse_command(":kill 42"),
            Some(Command::Kill { pane_id: 42 })
        );
        assert_eq!(parse_command(":kill"), None);
        assert_eq!(parse_command(":kill abc"), None);
    }

    #[test]
    fn test_parse_models() {
        assert_eq!(parse_command(":models"), Some(Command::Models));
    }

    #[test]
    fn test_parse_voice() {
        assert_eq!(
            parse_command(":voice on"),
            Some(Command::Voice { enabled: true })
        );
        assert_eq!(
            parse_command(":voice off"),
            Some(Command::Voice { enabled: false })
        );
    }

    #[test]
    fn test_parse_tts_voice() {
        assert_eq!(
            parse_command(":tts voice tara"),
            Some(Command::TtsVoice {
                voice: "tara".to_string()
            })
        );
    }

    #[test]
    fn test_not_a_command() {
        assert_eq!(parse_command("ls -la"), None);
        assert_eq!(parse_command(":unknown"), None);
        assert_eq!(parse_command(":spawn"), None);
        assert_eq!(parse_command(":spawn unknown"), None);
    }
}
