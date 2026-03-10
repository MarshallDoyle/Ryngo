// RYNGO: Agent detection and orchestration crate.
// Monitors PTY output to detect Claude Code and Codex sessions,
// tracks their state, and provides terminal commands for agent management.
// Auto-approval system classifies permission prompts and responds automatically.

pub mod auto_approve;
pub mod commands;
pub mod detector;
pub mod status;

pub use auto_approve::{ApprovalDecision, ApprovalRequest};
pub use commands::Command;
pub use detector::{AgentDetector, AgentType, GLOBAL_DETECTOR};
pub use status::{AgentInfo, AgentState};
