// RYNGO: LLM chat overlay — autonomous agent loop with Gemma 3n.
// ReAct pattern: Reason -> Act (tool call) -> Observe (result) -> Repeat.
// Streams tokens in real-time with markdown rendering. Google color palette.
// ASCII art only — no emoji anywhere.

use mux::tab::TabId;
use mux::termwiztermtab::TermWizTerminal;
use ryngo_ai::agent_prompt;
use ryngo_ai::tools::{self, Tool, ToolResult};
use termwiz::cell::{AttributeChange, CellAttributes, Intensity};
use termwiz::color::{ColorAttribute, SrgbaTuple};
use termwiz::input::{InputEvent, KeyCode, KeyEvent};
use termwiz::lineedit::*;
use termwiz::surface::Change;
use termwiz::terminal::Terminal;

// ---------------------------------------------------------------------------
// Google color palette (TrueColor)
// ---------------------------------------------------------------------------

// RYNGO: Core four Google colors
fn g_blue() -> ColorAttribute {
    // #4285F4
    ColorAttribute::TrueColorWithDefaultFallback(SrgbaTuple(0.259, 0.522, 0.957, 1.0))
}
fn g_red() -> ColorAttribute {
    // #EA4335
    ColorAttribute::TrueColorWithDefaultFallback(SrgbaTuple(0.918, 0.263, 0.208, 1.0))
}
fn g_yellow() -> ColorAttribute {
    // #CF9B07 — darkened for readability on light backgrounds
    ColorAttribute::TrueColorWithDefaultFallback(SrgbaTuple(0.808, 0.608, 0.027, 1.0))
}
fn g_green() -> ColorAttribute {
    // #34A853
    ColorAttribute::TrueColorWithDefaultFallback(SrgbaTuple(0.204, 0.659, 0.325, 1.0))
}
// RYNGO: Supporting neutrals
fn g_dark() -> ColorAttribute {
    // #202124 — primary text on light backgrounds
    ColorAttribute::TrueColorWithDefaultFallback(SrgbaTuple(0.125, 0.129, 0.141, 1.0))
}
fn g_secondary() -> ColorAttribute {
    // #5F6368 — secondary text
    ColorAttribute::TrueColorWithDefaultFallback(SrgbaTuple(0.373, 0.388, 0.412, 1.0))
}

// ---------------------------------------------------------------------------
// Octopus thinking animation frames (ASCII art, no emoji)
// ---------------------------------------------------------------------------

const OCTOPUS_FRAMES: &[&str] = &[
    // Frame 0 — neutral
    concat!(
        "    \x1b[38;2;66;133;244m,---,\x1b[0m\r\n",
        "   \x1b[38;2;66;133;244m( o o )\x1b[0m\r\n",
        "    \x1b[38;2;66;133;244m\\_~_/\x1b[0m\r\n",
        "   \x1b[38;2;234;67;53m/|\x1b[38;2;251;188;5m/|\x1b[38;2;52;168;83m/|\x1b[38;2;66;133;244m/|\x1b[0m\r\n",
    ),
    // Frame 1 — arms wave right
    concat!(
        "    \x1b[38;2;66;133;244m,---,\x1b[0m\r\n",
        "   \x1b[38;2;66;133;244m( o o )\x1b[0m\r\n",
        "    \x1b[38;2;66;133;244m\\_^_/\x1b[0m\r\n",
        "    \x1b[38;2;234;67;53m\\|\x1b[38;2;251;188;5m\\|\x1b[38;2;52;168;83m\\|\x1b[38;2;66;133;244m\\|\x1b[0m\r\n",
    ),
    // Frame 2 — happy squint
    concat!(
        "    \x1b[38;2;66;133;244m,---,\x1b[0m\r\n",
        "   \x1b[38;2;66;133;244m( ^ ^ )\x1b[0m\r\n",
        "    \x1b[38;2;66;133;244m\\_~_/\x1b[0m\r\n",
        "   \x1b[38;2;234;67;53m/|\x1b[38;2;251;188;5m/|\x1b[38;2;52;168;83m/|\x1b[38;2;66;133;244m/|\x1b[0m\r\n",
    ),
    // Frame 3 — arms wave left
    concat!(
        "    \x1b[38;2;66;133;244m,---,\x1b[0m\r\n",
        "   \x1b[38;2;66;133;244m( o o )\x1b[0m\r\n",
        "    \x1b[38;2;66;133;244m\\_~_/\x1b[0m\r\n",
        "    \x1b[38;2;234;67;53m\\|\x1b[38;2;251;188;5m\\|\x1b[38;2;52;168;83m\\|\x1b[38;2;66;133;244m\\|\x1b[0m\r\n",
    ),
];

/// Number of rows the octopus animation occupies.
const OCTOPUS_HEIGHT: usize = 4;

/// Maximum number of agent loop iterations before forced stop.
const MAX_AGENT_TURNS: usize = 10;

// ---------------------------------------------------------------------------
// LineEditor host (same pattern as prompt.rs)
// ---------------------------------------------------------------------------

struct LlmChatHost {
    history: BasicHistory,
}

impl LlmChatHost {
    fn new() -> Self {
        Self {
            history: BasicHistory::default(),
        }
    }
}

impl LineEditorHost for LlmChatHost {
    fn history(&mut self) -> &mut dyn History {
        &mut self.history
    }

    fn resolve_action(
        &mut self,
        event: &InputEvent,
        editor: &mut LineEditor<'_>,
    ) -> Option<Action> {
        let (line, _cursor) = editor.get_line_and_cursor();
        if line.is_empty()
            && matches!(
                event,
                InputEvent::Key(KeyEvent {
                    key: KeyCode::Escape,
                    ..
                })
            )
        {
            Some(Action::Cancel)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Streaming markdown renderer — Google palette, token-by-token
// ---------------------------------------------------------------------------

struct MarkdownStreamer {
    // Block-level state
    in_code_block: bool,
    at_line_start: bool,
    in_header: bool,
    line_start_buf: String,
    // Inline state
    in_inline_code: bool,
    in_bold: bool,
    pending_star: bool,
    // Tool call accumulator
    in_tool_tag: bool,
    tool_buf: String,
}

impl MarkdownStreamer {
    fn new() -> Self {
        Self {
            in_code_block: false,
            at_line_start: true,
            in_header: false,
            line_start_buf: String::new(),
            in_inline_code: false,
            in_bold: false,
            pending_star: false,
            in_tool_tag: false,
            tool_buf: String::new(),
        }
    }

    /// Push a token — renders immediately except for tiny line-start buffer.
    /// Accumulates <tool>...</tool> content silently (not rendered).
    fn push(&mut self, term: &mut TermWizTerminal, token: &str) -> anyhow::Result<()> {
        // Handle tool tag accumulation
        for ch in token.chars() {
            if self.in_tool_tag {
                self.tool_buf.push(ch);
                // Check if we've closed the tag
                if self.tool_buf.ends_with("</tool>") {
                    self.in_tool_tag = false;
                    // Don't render tool calls — they'll be parsed separately
                }
                continue;
            }

            // Check for opening <tool> tag
            self.tool_buf.push(ch);
            if self.tool_buf.ends_with("<tool>") {
                self.in_tool_tag = true;
                // Remove the "<tool>" prefix text and render it
                let prefix_len = self.tool_buf.len() - 6;
                if prefix_len > 0 {
                    let prefix = self.tool_buf[..prefix_len].to_string();
                    self.push_rendered(term, &prefix)?;
                }
                self.tool_buf.clear();
                self.tool_buf.push_str("<tool>");
                continue;
            }

            // If we've accumulated enough chars and it's not a tag start, flush
            if self.tool_buf.len() > 6 || (!self.tool_buf.ends_with('<')
                && !self.tool_buf.starts_with('<'))
            {
                let text = std::mem::take(&mut self.tool_buf);
                self.push_rendered(term, &text)?;
            }
        }

        Ok(())
    }

    /// Render text (non-tool content) through the markdown pipeline.
    fn push_rendered(&mut self, term: &mut TermWizTerminal, text: &str) -> anyhow::Result<()> {
        let mut first = true;
        for segment in text.split('\n') {
            if !first {
                self.flush_line_start(term)?;
                self.end_line(term)?;
            }
            first = false;

            if segment.is_empty() {
                continue;
            }

            if self.at_line_start {
                self.line_start_buf.push_str(segment);
                self.try_resolve_line_start(term)?;
            } else {
                self.render_segment(term, segment)?;
            }
        }
        Ok(())
    }

    /// Flush remaining content at end of generation.
    fn flush(&mut self, term: &mut TermWizTerminal) -> anyhow::Result<()> {
        // Flush any remaining tool_buf as text
        if !self.tool_buf.is_empty() && !self.in_tool_tag {
            let text = std::mem::take(&mut self.tool_buf);
            self.push_rendered(term, &text)?;
        }
        self.flush_line_start(term)?;
        if self.pending_star {
            self.pending_star = false;
            self.emit_styled_text(term, "*")?;
        }
        self.in_header = false;
        term.render(&[
            Change::AllAttributes(CellAttributes::default()),
            Change::Text("\r\n\r\n".to_string()),
        ])?;
        Ok(())
    }

    // -- Line-start detection -----------------------------------------------

    fn try_resolve_line_start(&mut self, term: &mut TermWizTerminal) -> anyhow::Result<()> {
        let buf = &self.line_start_buf;

        // Code fence
        if buf.starts_with("```") {
            self.in_code_block = !self.in_code_block;
            let text = std::mem::take(&mut self.line_start_buf);
            term.render(&[
                AttributeChange::Foreground(g_secondary()).into(),
                AttributeChange::Intensity(Intensity::Half).into(),
                Change::Text(text),
                Change::AllAttributes(CellAttributes::default()),
            ])?;
            self.at_line_start = false;
            return Ok(());
        }
        if buf.len() < 3 && buf.chars().all(|c| c == '`') {
            return Ok(());
        }

        // Header
        if buf.starts_with('#') && !self.in_code_block {
            let after = buf.trim_start_matches('#');
            if after.is_empty() {
                return Ok(());
            }
            if after.starts_with(' ') {
                let content = after[1..].to_string();
                self.line_start_buf.clear();
                self.in_header = true;
                self.at_line_start = false;
                term.render(&[
                    AttributeChange::Foreground(g_yellow()).into(),
                    AttributeChange::Intensity(Intensity::Bold).into(),
                ])?;
                if !content.is_empty() {
                    term.render(&[Change::Text(content)])?;
                }
                return Ok(());
            }
        }

        // List item — ASCII bullet
        if !self.in_code_block {
            if buf.starts_with("- ") || buf.starts_with("* ") {
                let content = buf[2..].to_string();
                self.line_start_buf.clear();
                self.at_line_start = false;
                term.render(&[
                    AttributeChange::Foreground(g_red()).into(),
                    Change::Text("* ".to_string()),
                    Change::AllAttributes(CellAttributes::default()),
                ])?;
                if !content.is_empty() {
                    self.render_segment(term, &content)?;
                }
                return Ok(());
            }
            if buf.len() == 1 && (buf == "-" || buf == "*") {
                return Ok(());
            }
        }

        // Horizontal rule — ASCII dashes
        if !self.in_code_block
            && buf.len() >= 3
            && (buf.starts_with("---") || buf.starts_with("***"))
            && buf.chars().all(|c| c == '-' || c == '*')
        {
            self.line_start_buf.clear();
            self.at_line_start = false;
            term.render(&[
                AttributeChange::Foreground(g_secondary()).into(),
                AttributeChange::Intensity(Intensity::Half).into(),
                Change::Text("-".repeat(40)),
                Change::AllAttributes(CellAttributes::default()),
            ])?;
            return Ok(());
        }

        // Not special — flush as regular text
        let text = std::mem::take(&mut self.line_start_buf);
        self.at_line_start = false;
        self.render_segment(term, &text)?;
        Ok(())
    }

    fn flush_line_start(&mut self, term: &mut TermWizTerminal) -> anyhow::Result<()> {
        if !self.line_start_buf.is_empty() {
            let text = std::mem::take(&mut self.line_start_buf);
            self.at_line_start = false;
            self.render_segment(term, &text)?;
        }
        Ok(())
    }

    fn end_line(&mut self, term: &mut TermWizTerminal) -> anyhow::Result<()> {
        if self.pending_star {
            self.pending_star = false;
            self.emit_styled_text(term, "*")?;
        }
        if self.in_header {
            self.in_header = false;
        }
        term.render(&[
            Change::AllAttributes(CellAttributes::default()),
            Change::Text("\r\n".to_string()),
        ])?;
        self.at_line_start = true;
        self.line_start_buf.clear();
        Ok(())
    }

    // -- Inline rendering ---------------------------------------------------

    fn render_segment(&mut self, term: &mut TermWizTerminal, text: &str) -> anyhow::Result<()> {
        if self.in_code_block {
            term.render(&[
                AttributeChange::Foreground(g_dark()).into(),
                Change::Text(text.to_string()),
            ])?;
            return Ok(());
        }
        if self.in_header {
            term.render(&[Change::Text(text.to_string())])?;
            return Ok(());
        }

        let mut buf = String::new();
        for c in text.chars() {
            if c == '`' {
                if !buf.is_empty() {
                    self.emit_styled_text(term, &std::mem::take(&mut buf))?;
                }
                if self.pending_star {
                    self.pending_star = false;
                    self.emit_styled_text(term, "*")?;
                }
                self.in_inline_code = !self.in_inline_code;
                continue;
            }

            if c == '*' && !self.in_inline_code {
                if self.pending_star {
                    self.pending_star = false;
                    if !buf.is_empty() {
                        self.emit_styled_text(term, &std::mem::take(&mut buf))?;
                    }
                    self.in_bold = !self.in_bold;
                    continue;
                }
                self.pending_star = true;
                continue;
            }

            if self.pending_star {
                self.pending_star = false;
                buf.push('*');
            }
            buf.push(c);
        }

        if !buf.is_empty() {
            self.emit_styled_text(term, &buf)?;
        }
        Ok(())
    }

    fn emit_styled_text(&self, term: &mut TermWizTerminal, text: &str) -> anyhow::Result<()> {
        let color = if self.in_inline_code {
            g_green() // Google Green for inline code
        } else {
            g_blue() // Google Blue for response text
        };
        let intensity = if self.in_bold && !self.in_inline_code {
            Intensity::Bold
        } else {
            Intensity::Normal
        };
        term.render(&[
            AttributeChange::Foreground(color).into(),
            AttributeChange::Intensity(intensity).into(),
            Change::Text(text.to_string()),
        ])?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn reset_llm_mode_flag() {
    if let Ok(mut state) = crate::ryngo_state::RYNGO_STATE.lock() {
        state.llm_mode_active = false;
    }
}

/// Show the dancing octopus animation while waiting for the first token.
/// Returns once a token arrives or the sender disconnects.
/// Returns the first token (if any) so the caller can process it.
fn animate_octopus_thinking(
    term: &mut TermWizTerminal,
    rx: &std::sync::mpsc::Receiver<String>,
) -> anyhow::Result<Option<String>> {
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Duration;

    let frame_duration = Duration::from_millis(400);
    let mut frame_idx: usize = 0;

    // Draw initial frame
    term.render(&[Change::Text(OCTOPUS_FRAMES[0].to_string())])?;

    loop {
        match rx.recv_timeout(frame_duration) {
            Ok(token) => {
                // First token arrived — erase the octopus and return
                erase_octopus(term)?;
                return Ok(Some(token));
            }
            Err(RecvTimeoutError::Timeout) => {
                // Advance animation frame
                frame_idx = (frame_idx + 1) % OCTOPUS_FRAMES.len();
                erase_octopus(term)?;
                term.render(&[Change::Text(
                    OCTOPUS_FRAMES[frame_idx].to_string(),
                )])?;
            }
            Err(RecvTimeoutError::Disconnected) => {
                // Generation finished with no output
                erase_octopus(term)?;
                return Ok(None);
            }
        }
    }
}

/// Move cursor up and clear the lines occupied by the octopus.
fn erase_octopus(term: &mut TermWizTerminal) -> anyhow::Result<()> {
    for _ in 0..OCTOPUS_HEIGHT {
        term.render(&[
            Change::CursorPosition {
                x: termwiz::surface::Position::Absolute(0),
                y: termwiz::surface::Position::Relative(-1),
            },
            Change::ClearToEndOfLine(Default::default()),
        ])?;
    }
    Ok(())
}

/// Collect all streamed tokens into a string, showing the octopus animation while waiting.
fn stream_with_animation(
    term: &mut TermWizTerminal,
    rx: &std::sync::mpsc::Receiver<String>,
    render: bool,
) -> anyhow::Result<String> {
    let first_token = animate_octopus_thinking(term, rx)?;

    let mut full_response = String::new();
    let mut streamer = if render {
        Some(MarkdownStreamer::new())
    } else {
        None
    };

    if let Some(token) = first_token {
        full_response.push_str(&token);
        if let Some(ref mut s) = streamer {
            s.push(term, &token)?;
        }
    }

    for token in rx.iter() {
        full_response.push_str(&token);
        if let Some(ref mut s) = streamer {
            s.push(term, &token)?;
        }
    }

    if let Some(ref mut s) = streamer {
        if !full_response.is_empty() {
            s.flush(term)?;
        }
    }

    Ok(full_response)
}

/// Render a tool call header in the overlay.
fn render_tool_header(term: &mut TermWizTerminal, tool: &Tool) -> anyhow::Result<()> {
    term.render(&[
        Change::AllAttributes(CellAttributes::default()),
        AttributeChange::Foreground(g_blue()).into(),
        AttributeChange::Intensity(Intensity::Bold).into(),
        Change::Text(format!("  [{}] ", tool.display_name())),
        Change::AllAttributes(CellAttributes::default()),
        AttributeChange::Foreground(g_secondary()).into(),
        Change::Text(format!("{}\r\n", tool.summary())),
        Change::AllAttributes(CellAttributes::default()),
    ])?;
    Ok(())
}

/// Render a tool result in the overlay.
fn render_tool_result(term: &mut TermWizTerminal, result: &ToolResult) -> anyhow::Result<()> {
    let status_color = if result.success { g_green() } else { g_red() };
    let status_text = if result.success { "[ok]" } else { "[err]" };

    // Show first ~20 lines of output
    let lines: Vec<&str> = result.output.lines().take(20).collect();
    let truncated = result.output.lines().count() > 20;

    term.render(&[
        AttributeChange::Foreground(status_color).into(),
        Change::Text(format!("  {} ", status_text)),
        Change::AllAttributes(CellAttributes::default()),
    ])?;

    for line in &lines {
        term.render(&[
            AttributeChange::Foreground(g_dark()).into(),
            Change::Text(format!("  {}\r\n", line)),
        ])?;
    }

    if truncated {
        term.render(&[
            AttributeChange::Foreground(g_secondary()).into(),
            Change::Text("  ... (output truncated)\r\n".to_string()),
        ])?;
    }

    term.render(&[
        Change::AllAttributes(CellAttributes::default()),
        Change::Text("\r\n".to_string()),
    ])?;

    Ok(())
}

/// Show a dangerous command warning and wait for user confirmation.
/// Returns true if the user confirmed, false if rejected.
fn confirm_dangerous(term: &mut TermWizTerminal, tool: &Tool) -> anyhow::Result<bool> {
    term.render(&[
        Change::AllAttributes(CellAttributes::default()),
        AttributeChange::Foreground(g_red()).into(),
        AttributeChange::Intensity(Intensity::Bold).into(),
        Change::Text("  !! DANGEROUS COMMAND !!\r\n".to_string()),
        Change::AllAttributes(CellAttributes::default()),
        AttributeChange::Foreground(g_red()).into(),
        Change::Text(format!("  {}\r\n", tool.summary())),
        Change::AllAttributes(CellAttributes::default()),
        AttributeChange::Foreground(g_yellow()).into(),
        Change::Text("  Press 'y' to confirm, any other key to reject: ".to_string()),
        Change::AllAttributes(CellAttributes::default()),
    ])?;

    loop {
        match term.poll_input(None) {
            Ok(Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Char(c),
                ..
            }))) => {
                let confirmed = c == 'y' || c == 'Y';
                let msg = if confirmed { "Confirmed.\r\n\r\n" } else { "Rejected.\r\n\r\n" };
                term.render(&[
                    AttributeChange::Foreground(if confirmed { g_green() } else { g_red() }).into(),
                    Change::Text(msg.to_string()),
                    Change::AllAttributes(CellAttributes::default()),
                ])?;
                return Ok(confirmed);
            }
            Ok(Some(InputEvent::Key(_))) => {
                term.render(&[
                    AttributeChange::Foreground(g_red()).into(),
                    Change::Text("Rejected.\r\n\r\n".to_string()),
                    Change::AllAttributes(CellAttributes::default()),
                ])?;
                return Ok(false);
            }
            Ok(_) => continue,
            Err(_) => return Ok(false),
        }
    }
}

/// Get the current working directory of the active pane (best effort).
fn get_pane_cwd() -> String {
    // Try to get CWD from the active pane via the mux
    if let Some(mux) = mux::Mux::try_get() {
        let workspace = mux.active_workspace();
        let window_ids = mux.iter_windows_in_workspace(&workspace);
        for window_id in window_ids {
            if let Some(tab) = mux.get_active_tab_for_window(window_id) {
                if let Some(pane) = tab.get_active_pane() {
                    if let Some(url) =
                        pane.get_current_working_dir(mux::pane::CachePolicy::AllowStale)
                    {
                        if let Ok(path) = url.to_file_path() {
                            return path.to_string_lossy().to_string();
                        }
                    }
                }
            }
        }
    }
    // Fallback to process CWD
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "/".to_string())
}

// ---------------------------------------------------------------------------
// Main overlay entry point — Agent Loop
// ---------------------------------------------------------------------------

pub fn run_llm_chat(mut term: TermWizTerminal, _tab_id: TabId) -> anyhow::Result<()> {
    term.no_grab_mouse_in_raw_mode();

    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            term.render(&[
                Change::AllAttributes(CellAttributes::default()),
                AttributeChange::Foreground(g_red()).into(),
                Change::Text(format!("Failed to create async runtime: {}\r\n", e)),
                Change::AllAttributes(CellAttributes::default()),
            ])?;
            reset_llm_mode_flag();
            return Ok(());
        }
    };

    let is_loaded = rt.block_on(crate::ryngo_state::LLM_HANDLE.is_loaded());
    if !is_loaded {
        term.render(&[
            Change::AllAttributes(CellAttributes::default()),
            AttributeChange::Foreground(g_yellow()).into(),
            Change::Text(
                "Model is not loaded yet. Please wait for model loading to complete.\r\n"
                    .to_string(),
            ),
            Change::Text(
                "The status bar will show \"Model ready\" when it's available.\r\n\r\n"
                    .to_string(),
            ),
            Change::AllAttributes(CellAttributes::default()),
            Change::Text("Press any key to close...\r\n".to_string()),
        ])?;
        loop {
            match term.poll_input(None) {
                Ok(Some(InputEvent::Key(_))) => break,
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        reset_llm_mode_flag();
        return Ok(());
    }

    // Welcome banner — ASCII octopus art, no emoji
    term.render(&[
        Change::Title("LLM Chat".to_string()),
        Change::AllAttributes(CellAttributes::default()),
        AttributeChange::Foreground(g_blue()).into(),
        Change::Text("  ,---,\r\n".to_string()),
        Change::Text(" ( o o )   ".to_string()),
        AttributeChange::Intensity(Intensity::Bold).into(),
        Change::Text("Ryngo LLM Chat -- Gemma 3n\r\n".to_string()),
        AttributeChange::Intensity(Intensity::Normal).into(),
        AttributeChange::Foreground(g_blue()).into(),
        Change::Text("  \\_~_/\r\n".to_string()),
        Change::AllAttributes(CellAttributes::default()),
        AttributeChange::Foreground(g_secondary()).into(),
        Change::Text(
            "Type a request and press Enter. The agent will use tools to help you.\r\n"
                .to_string(),
        ),
        Change::Text("Escape on empty line to exit.\r\n\r\n".to_string()),
        Change::AllAttributes(CellAttributes::default()),
    ])?;

    let cwd = get_pane_cwd();
    let mut host = LlmChatHost::new();

    loop {
        let mut editor = LineEditor::new(&mut term);
        editor.set_prompt("> ");

        let line = match editor.read_line(&mut host)? {
            Some(line) => line,
            None => break,
        };

        if line.is_empty() {
            continue;
        }

        // Run the agent loop for this user request
        if let Err(e) = run_agent_turn(&mut term, &rt, &line, &cwd) {
            term.render(&[
                Change::AllAttributes(CellAttributes::default()),
                AttributeChange::Foreground(g_red()).into(),
                Change::Text(format!("Agent error: {:#}\r\n\r\n", e)),
                Change::AllAttributes(CellAttributes::default()),
            ])?;
        }
    }

    reset_llm_mode_flag();
    Ok(())
}

/// Run a single agent turn: user request -> LLM -> tool calls -> repeat until done.
fn run_agent_turn(
    term: &mut TermWizTerminal,
    rt: &tokio::runtime::Runtime,
    user_input: &str,
    cwd: &str,
) -> anyhow::Result<()> {
    let system_prompt = agent_prompt::build_agent_system_prompt(cwd);
    let mut context = agent_prompt::build_initial_context(&system_prompt, user_input);

    for turn in 0..MAX_AGENT_TURNS {
        // Trim context if it's getting too long
        context = agent_prompt::trim_context_if_needed(&context, &system_prompt, user_input);

        // Stream LLM response
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let handle = crate::ryngo_state::LLM_HANDLE.clone();
        let prompt = context.clone();

        rt.spawn(async move {
            if let Err(e) = handle.generate_raw_streaming(prompt, tx).await {
                log::error!("LLM agent streaming error: {:#}", e);
            }
        });

        // Show octopus while thinking, collect full response
        let response = stream_with_animation(term, &rx, true)?;

        if response.is_empty() {
            term.render(&[
                Change::AllAttributes(CellAttributes::default()),
                AttributeChange::Foreground(g_yellow()).into(),
                Change::Text("No response received from model.\r\n\r\n".to_string()),
                Change::AllAttributes(CellAttributes::default()),
            ])?;
            break;
        }

        // Parse tool calls from the response
        let tool_calls = tools::parse_tool_calls(&response);

        if tool_calls.is_empty() {
            // No tool calls — this is the final answer, we're done
            break;
        }

        // Append the model's response to context
        context.push_str(&response);

        // Execute each tool call
        for tool_call in &tool_calls {
            render_tool_header(term, tool_call)?;

            // Safety check for dangerous commands
            if tools::is_dangerous(tool_call) {
                if !confirm_dangerous(term, tool_call)? {
                    let reject_msg = "Tool rejected by user.";
                    agent_prompt::append_tool_result(&mut context, reject_msg);
                    term.render(&[
                        AttributeChange::Foreground(g_yellow()).into(),
                        Change::Text("  Skipped.\r\n\r\n".to_string()),
                        Change::AllAttributes(CellAttributes::default()),
                    ])?;
                    continue;
                }
            }

            // Execute the tool
            let result = tools::execute_tool(tool_call, cwd)?;

            // Show result in overlay
            render_tool_result(term, &result)?;

            // Append result to context for next LLM turn
            let formatted = tools::format_tool_result_for_context(&result);
            agent_prompt::append_tool_result(&mut context, &formatted);
        }

        // If this was the last allowed turn, inform the user
        if turn == MAX_AGENT_TURNS - 1 {
            term.render(&[
                AttributeChange::Foreground(g_yellow()).into(),
                Change::Text(
                    "  (Agent reached maximum turns. Type another request to continue.)\r\n\r\n"
                        .to_string(),
                ),
                Change::AllAttributes(CellAttributes::default()),
            ])?;
        }
    }

    Ok(())
}
