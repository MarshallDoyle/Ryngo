// RYNGO: Per-pane agent state tracking.
// Each pane can have at most one detected agent. State transitions are driven
// by pattern matches in detector.rs.

use crate::detector::AgentType;
use std::time::Instant;

/// The lifecycle state of a detected AI agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentState {
    /// Agent process is running but no active operation detected.
    Idle,
    /// Agent is processing / generating a response.
    Thinking,
    /// Agent is actively writing code or editing files.
    Writing,
    /// Agent is waiting for user approval (e.g. Claude Code permission prompt).
    WaitingForApproval,
    /// Agent encountered an error.
    Errored,
    /// Agent process has exited.
    Exited,
}

impl AgentState {
    /// Short label for display in the status bar.
    pub fn label(&self) -> &'static str {
        match self {
            AgentState::Idle => "idle",
            AgentState::Thinking => "thinking",
            AgentState::Writing => "writing",
            AgentState::WaitingForApproval => "awaiting approval",
            AgentState::Errored => "error",
            AgentState::Exited => "exited",
        }
    }

    /// Status bar indicator symbol.
    pub fn indicator(&self) -> &'static str {
        match self {
            AgentState::Idle => "[-]",
            AgentState::Thinking => "[~]",
            AgentState::Writing => "[>]",
            AgentState::WaitingForApproval => "[?]",
            AgentState::Errored => "[!]",
            AgentState::Exited => "[x]",
        }
    }
}

/// Information about a detected agent in a specific pane.
#[derive(Debug, Clone)]
pub struct AgentInfo {
    /// What type of agent was detected.
    pub agent_type: AgentType,
    /// Current state of the agent.
    pub state: AgentState,
    /// When the agent was first detected in this pane.
    pub detected_at: Instant,
    /// When the state last changed.
    pub state_changed_at: Instant,
    /// The last tool or action the agent mentioned (e.g. "Read", "Edit", "Bash").
    pub last_tool: Option<String>,
    /// Working directory if detected from agent output.
    pub working_dir: Option<String>,
}

impl AgentInfo {
    pub fn new(agent_type: AgentType) -> Self {
        let now = Instant::now();
        Self {
            agent_type,
            state: AgentState::Idle,
            detected_at: now,
            state_changed_at: now,
            last_tool: None,
            working_dir: None,
        }
    }

    /// Update the agent state, recording when the transition happened.
    pub fn set_state(&mut self, new_state: AgentState) {
        if self.state != new_state {
            log::debug!(
                "Agent {:?} state: {:?} -> {:?}",
                self.agent_type,
                self.state,
                new_state
            );
            self.state = new_state;
            self.state_changed_at = Instant::now();
        }
    }

    /// Status bar display string like "Claude Code [~] thinking"
    pub fn status_string(&self) -> String {
        let tool_suffix = if let Some(ref tool) = self.last_tool {
            format!(" ({})", tool)
        } else {
            String::new()
        };
        format!(
            "{} {} {}{}",
            self.agent_type.display_name(),
            self.state.indicator(),
            self.state.label(),
            tool_suffix,
        )
    }
}
