// RYNGO: System prompt and context builder for the autonomous agent loop.
// Instructs Gemma 3n to use <tool>JSON</tool> format for tool calls.

/// Build the system prompt that tells Gemma 3n how to act as a terminal agent.
pub fn build_agent_system_prompt(cwd: &str) -> String {
    format!(
        r#"You are Ryngo, a terminal assistant. You help users by executing commands and editing files.

Current directory: {cwd}

You have these tools:
- bash: Run a shell command. Use: <tool>{{"name":"bash","command":"..."}}</tool>
- read: Read a file. Use: <tool>{{"name":"read","path":"..."}}</tool>
- write: Write a file. Use: <tool>{{"name":"write","path":"...","content":"..."}}</tool>
- ls: List directory. Use: <tool>{{"name":"ls","path":"..."}}</tool>
- grep: Search files. Use: <tool>{{"name":"grep","pattern":"...","path":"..."}}</tool>

Rules:
1. Think step by step. Explain your plan briefly, then use tools.
2. After each tool call, review the result and decide next action.
3. When done, give a final summary WITHOUT tool calls.
4. For dangerous operations (deleting files, system commands), warn the user first.
5. Keep responses concise. Show only relevant output.
6. Use ONE tool call per response. Wait for the result before the next action.
7. Always use the exact <tool>JSON</tool> format shown above."#
    )
}

/// Build the initial context string for the agent loop.
/// Uses Gemma 3n chat template format.
pub fn build_initial_context(system_prompt: &str, user_message: &str) -> String {
    format!(
        "<start_of_turn>user\n{}\n\nUser request: {}\n<end_of_turn>\n<start_of_turn>model\n",
        system_prompt, user_message
    )
}

/// Append a tool result to the context and set up for the next model turn.
pub fn append_tool_result(context: &mut String, tool_result: &str) {
    // End the current model turn, add tool result as user turn, start new model turn
    context.push_str("<end_of_turn>\n<start_of_turn>user\n");
    context.push_str("Tool result:\n");
    context.push_str(tool_result);
    context.push_str("\n<end_of_turn>\n<start_of_turn>model\n");
}

/// Estimate token count from a string (rough approximation: ~4 chars per token).
pub fn estimate_tokens(text: &str) -> usize {
    text.len() / 4
}

/// Maximum context tokens before we need to summarize earlier turns.
pub const MAX_CONTEXT_TOKENS: usize = 3500;

/// Trim context if it exceeds the token budget.
/// Keeps the system prompt and most recent turns, drops middle turns.
pub fn trim_context_if_needed(context: &str, system_prompt: &str, latest_user_msg: &str) -> String {
    let estimated = estimate_tokens(context);
    if estimated <= MAX_CONTEXT_TOKENS {
        return context.to_string();
    }

    // Rebuild with just the system prompt and latest message
    log::info!(
        "Context too long (~{} tokens), trimming to last turn",
        estimated
    );
    build_initial_context(system_prompt, latest_user_msg)
}
