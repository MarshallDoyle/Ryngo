// RYNGO: Bottom status bar rendering — shows AI status and agent detection.
// This is a separate bar from the tab bar, always rendered at the bottom of the window.
// Layout: [left: mic/agent status] ... [right: model status / agent state]

use crate::quad::TripleLayerQuadAllocator;
use crate::termwindow::render::RenderScreenLineParams;
use mux::renderable::RenderableDimensions;
use ryngo_agent::AgentState;
use termwiz::cell::CellAttributes;
use termwiz::color::ColorSpec;
use termwiz::surface::SEQ_ZERO;
use wezterm_term::color::ColorAttribute;
use wezterm_term::Line;
use window::color::LinearRgba;

impl crate::TermWindow {
    /// Build the status bar Line from RYNGO_STATE and agent detector.
    /// Returns a Line that can be rendered with render_screen_line.
    pub fn build_ryngo_status_line(&self) -> Line {
        let cols = self.dimensions.pixel_width / self.render_metrics.cell_size.width as usize;
        let mut line = Line::with_width(cols, SEQ_ZERO);

        // RYNGO: Google color palette constants — light mode
        let gc_blue = termwiz::color::SrgbaTuple(0.259, 0.522, 0.957, 1.0); // #4285F4
        let gc_red = termwiz::color::SrgbaTuple(0.918, 0.263, 0.208, 1.0); // #EA4335
        let gc_yellow = termwiz::color::SrgbaTuple(0.808, 0.608, 0.027, 1.0); // #CF9B07
        let gc_green = termwiz::color::SrgbaTuple(0.204, 0.659, 0.325, 1.0); // #34A853
        let gc_dark_text = termwiz::color::SrgbaTuple(0.125, 0.129, 0.141, 1.0); // #202124
        let gc_secondary = termwiz::color::SrgbaTuple(0.373, 0.388, 0.412, 1.0); // #5F6369
        let gc_bg = termwiz::color::SrgbaTuple(0.973, 0.976, 0.980, 1.0); // #F8F9FA

        // RYNGO: Get the active pane ID for agent detection lookup.
        let active_pane_id = self.get_active_pane_or_overlay().map(|p| p.pane_id());
        let agent_info = active_pane_id
            .and_then(|pid| ryngo_agent::GLOBAL_DETECTOR.get_agent(pid));

        // RYNGO: If command mode is active, show the command buffer in the status bar
        if self.ryngo_command_active {
            let cmd_text = format!(" {}_", self.ryngo_command_buffer);
            let hint = "ESC to cancel | ENTER to execute ";

            let mut cmd_attr = CellAttributes::default();
            cmd_attr.set_foreground(ColorSpec::TrueColor(gc_blue));
            cmd_attr.set_background(ColorSpec::TrueColor(gc_bg));

            let mut hint_attr = CellAttributes::default();
            hint_attr.set_foreground(ColorSpec::TrueColor(gc_secondary));
            hint_attr.set_background(ColorSpec::TrueColor(gc_bg));

            let mut bg_attr = CellAttributes::default();
            bg_attr.set_foreground(ColorSpec::TrueColor(gc_dark_text));
            bg_attr.set_background(ColorSpec::TrueColor(gc_bg));

            for i in 0..cols {
                line.set_cell(i, termwiz::cell::Cell::new(' ', bg_attr.clone()), SEQ_ZERO);
            }
            let mut x = 0;
            for c in cmd_text.chars() {
                if x >= cols { break; }
                line.set_cell(x, termwiz::cell::Cell::new(c, cmd_attr.clone()), SEQ_ZERO);
                x += 1;
            }
            let hint_len = hint.chars().count();
            if hint_len < cols {
                let hint_start = cols - hint_len;
                let mut x = hint_start;
                for c in hint.chars() {
                    if x >= cols { break; }
                    line.set_cell(x, termwiz::cell::Cell::new(c, hint_attr.clone()), SEQ_ZERO);
                    x += 1;
                }
            }
            return line;
        }

        let (left_text, left_color, right_text, right_color) = {
            if let Ok(state) = crate::ryngo_state::RYNGO_STATE.lock() {
                let llm_active = state.llm_mode_active;

                // RYNGO: Build the right side — model status + agent state
                let (mut right, mut rc) = if state.model_healthy && state.context_total > 0 {
                    let used_pct =
                        (state.context_used as f64 / state.context_total as f64 * 100.0) as u32;
                    (
                        format!("Model ready [ok] | Context: {}% ", used_pct),
                        gc_green,
                    )
                } else if state.model_healthy {
                    ("Model ready [ok] ".to_string(), gc_green)
                } else if state.model_loading {
                    ("Loading model into GPU... ".to_string(), gc_yellow)
                } else if state.model_loaded && !state.model_healthy {
                    ("Model loaded (health check failed) ".to_string(), gc_red)
                } else if state.model_downloading {
                    let eta = state.download_eta_string();
                    (
                        format!("Downloading: {}% (ETA: {}) ", state.download_pct, eta),
                        gc_yellow,
                    )
                } else {
                    (String::new(), gc_secondary)
                };

                // RYNGO: If an agent is detected, prepend its status to the right side.
                if let Some(ref info) = agent_info {
                    let agent_status = info.status_string();
                    let separator = if right.is_empty() { "" } else { " | " };
                    right = format!("{}{}{}", agent_status, separator, right);
                    // Color the right side based on agent state
                    rc = match info.state {
                        AgentState::Idle => gc_green,
                        AgentState::Thinking => gc_blue,
                        AgentState::Writing => gc_blue,
                        AgentState::WaitingForApproval => gc_yellow,
                        AgentState::Errored => gc_red,
                        AgentState::Exited => gc_secondary,
                    };
                }

                // RYNGO: Build the left side — mode indicators
                let (left, lc) = if llm_active {
                    (
                        " <*> LLM Mode | Shift+Cmd+L to exit".to_string(),
                        gc_blue,
                    )
                } else if state.mic_active {
                    (
                        " [REC] Recording... release to transcribe".to_string(),
                        gc_red,
                    )
                } else if agent_info.is_some() {
                    // RYNGO: When an agent is detected, show agent-aware left text
                    let agent = agent_info.as_ref().unwrap();
                    let hint = match agent.state {
                        AgentState::WaitingForApproval => {
                            format!(" {} is waiting for your input", agent.agent_type.display_name())
                        }
                        AgentState::Thinking => {
                            format!(" {} is thinking...", agent.agent_type.display_name())
                        }
                        AgentState::Writing => {
                            let tool = agent.last_tool.as_deref().unwrap_or("code");
                            format!(" {} is writing {}", agent.agent_type.display_name(), tool)
                        }
                        _ => {
                            format!(" {} active | [mic] Shift+Space to speak",
                                    agent.agent_type.display_name())
                        }
                    };
                    (hint, gc_dark_text)
                } else {
                    let left = if state.model_downloading {
                        let eta = state.download_eta_string();
                        format!(
                            " [mic] Shift+Space | Downloading Gemma 3n: {}% ({})",
                            state.download_pct, eta
                        )
                    } else if state.model_loading {
                        " [mic] Shift+Space | Loading model...".to_string()
                    } else {
                        " [mic] Shift+Space to speak".to_string()
                    };
                    (left, gc_dark_text)
                };

                (left, lc, right, rc)
            } else {
                (
                    " Ryngo Terminal".to_string(),
                    gc_dark_text,
                    String::new(),
                    gc_secondary,
                )
            }
        };

        // RYNGO: Google light-mode styling — #F8F9FA off-white background
        let mut left_attr = CellAttributes::default();
        left_attr.set_foreground(ColorSpec::TrueColor(left_color));
        left_attr.set_background(ColorSpec::TrueColor(gc_bg));

        let mut right_attr = CellAttributes::default();
        right_attr.set_foreground(ColorSpec::TrueColor(right_color));
        right_attr.set_background(ColorSpec::TrueColor(gc_bg));

        // Background-only attr for filling empty cells
        let mut bg_attr = CellAttributes::default();
        bg_attr.set_foreground(ColorSpec::TrueColor(gc_dark_text));
        bg_attr.set_background(ColorSpec::TrueColor(gc_bg));

        // Fill the entire line with background
        for i in 0..cols {
            line.set_cell(i, termwiz::cell::Cell::new(' ', bg_attr.clone()), SEQ_ZERO);
        }

        // Write left text
        let mut x = 0;
        for c in left_text.chars() {
            if x >= cols {
                break;
            }
            line.set_cell(x, termwiz::cell::Cell::new(c, left_attr.clone()), SEQ_ZERO);
            x += 1;
        }

        // Write right text, right-aligned
        let right_len = right_text.chars().count();
        if right_len < cols {
            let right_start = cols - right_len;
            let mut x = right_start;
            for c in right_text.chars() {
                if x >= cols {
                    break;
                }
                line.set_cell(
                    x,
                    termwiz::cell::Cell::new(c, right_attr.clone()),
                    SEQ_ZERO,
                );
                x += 1;
            }
        }

        line
    }

    /// Paint the Ryngo status bar at the bottom of the window.
    pub fn paint_ryngo_status_bar(
        &mut self,
        layers: &mut TripleLayerQuadAllocator,
    ) -> anyhow::Result<()> {
        let border = self.get_os_border();
        let status_bar_height = self.render_metrics.cell_size.height as f32;

        // Position at the very bottom, above the OS border
        let status_bar_y = ((self.dimensions.pixel_height as f32)
            - (status_bar_height + border.bottom.get() as f32))
            .max(0.);

        let palette = self.palette().clone();
        let window_is_transparent =
            !self.window_background.is_empty() || self.config.window_background_opacity != 1.0;
        let gl_state = self.render_state.as_ref().unwrap();
        let white_space = gl_state.util_sprites.white_space.texture_coords();
        let filled_box = gl_state.util_sprites.filled_box.texture_coords();
        let default_bg = palette
            .resolve_bg(ColorAttribute::Default)
            .to_linear()
            .mul_alpha(if window_is_transparent {
                0.
            } else {
                self.config.text_background_opacity
            });

        let line = self.build_ryngo_status_line();

        self.render_screen_line(
            RenderScreenLineParams {
                top_pixel_y: status_bar_y,
                left_pixel_x: 0.,
                pixel_width: self.dimensions.pixel_width as f32,
                stable_line_idx: None,
                line: &line,
                selection: 0..0,
                cursor: &Default::default(),
                palette: &palette,
                dims: &RenderableDimensions {
                    cols: self.dimensions.pixel_width
                        / self.render_metrics.cell_size.width as usize,
                    physical_top: 0,
                    scrollback_rows: 0,
                    scrollback_top: 0,
                    viewport_rows: 1,
                    dpi: self.terminal_size.dpi,
                    pixel_height: self.render_metrics.cell_size.height as usize,
                    pixel_width: self.terminal_size.pixel_width,
                    reverse_video: false,
                },
                config: &self.config,
                cursor_border_color: LinearRgba::default(),
                foreground: palette.foreground.to_linear(),
                pane: None,
                is_active: true,
                selection_fg: LinearRgba::default(),
                selection_bg: LinearRgba::default(),
                cursor_fg: LinearRgba::default(),
                cursor_bg: LinearRgba::default(),
                cursor_is_default_color: true,
                white_space,
                filled_box,
                window_is_transparent,
                default_bg,
                style: None,
                font: None,
                use_pixel_positioning: self.config.experimental_pixel_positioning,
                render_metrics: self.render_metrics,
                shape_key: None,
                password_input: false,
            },
            layers,
        )?;

        Ok(())
    }

    /// Height of the Ryngo status bar in pixels (one cell tall).
    pub fn ryngo_status_bar_pixel_height(&self) -> f32 {
        self.render_metrics.cell_size.height as f32
    }
}
