# Ryngo — Build Guide for Claude Code

> A GPU-accelerated terminal for the modern workflow. Local AI models for voice, vision,
> and natural language — a better way to interact with agents like Claude Code and Codex.

**Repo**: https://github.com/MarshallDoyle/Marshall
**Base**: Fork of [WezTerm](https://github.com/wezterm/wezterm) (Rust, MIT license)
**Platforms**: macOS (Apple Silicon), Windows
**Product Name**: Ryngo

---

## Project Overview

Ryngo is a terminal emulator that treats AI agents as first-class citizens. It ships
with embedded local models for:
- **Speech-to-Text (STT)**: whisper-rs (whisper.cpp Rust bindings) — speak commands althought gemma 3N can do audio transcription natively. 
- **Text-to-Speech (TTS)**: Orpheus 3B via llama-cpp-2 — hear summarized output
- **LLM + Vision**: Gemma 3n (E4B or E2B) via llama-cpp-2 — parse images, summarize
  output before TTS, route intents, smart completions

**No cloud, no accounts, no Ollama dependency.** All inference is embedded via native
Rust bindings. Models are downloaded on first run and stored in `~/.ryngo/models/`.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Ryngo GUI                      │
│         (wezterm-gui, renamed ryngo-gui)         │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Terminal  │  │ Status   │  │  Agent        │  │
│  │ Emulator  │  │ Bar      │  │  Detector     │  │
│  │ (xterm)   │  │          │  │  (PTY parser) │  │
│  └──────────┘  └──────────┘  └───────────────┘  │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │          ryngo-ai crate (NEW)            │    │
│  │                                          │    │
│  │  ┌─────────┐ ┌─────────┐ ┌───────────┐  │    │
│  │  │whisper-rs│ │llama-cpp│ │llama-cpp  │  │    │
│  │  │  (STT)  │ │(Gemma3n)│ │(Orpheus)  │  │    │
│  │  └─────────┘ └─────────┘ └───────────┘  │    │
│  │                                          │    │
│  │  ┌─────────┐ ┌──────────────────────┐   │    │
│  │  │  cpal   │ │  Model Manager       │   │    │
│  │  │ (audio) │ │  (download, cache)   │   │    │
│  │  └─────────┘ └──────────────────────┘   │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │        ryngo-agent crate (NEW)           │    │
│  │  Agent detection, :spawn, :agents, PTY   │    │
│  │  output monitoring, status aggregation   │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

### Key Dependencies

| Component | Crate | Purpose | Platform Notes |
|-----------|-------|---------|----------------|
| STT | `whisper-rs` | Speech-to-text via whisper.cpp | Metal on macOS, CUDA/CPU on Windows |
| LLM/Vision | `llama-cpp-2` | Gemma 3n inference | Metal on macOS, CUDA/Vulkan on Windows |
| TTS | `llama-cpp-2` | Orpheus 3B inference + SNAC decode | Same as above |
| Audio I/O | `cpal` | Microphone capture + speaker output | Cross-platform |
| Audio decode | `rodio` or `hound` | WAV/PCM playback | Cross-platform |
| HTTP | `reqwest` | Model downloads from HuggingFace | — |
| Terminal | existing WezTerm | VT100/ANSI emulation | Already in codebase |
| GUI | existing WezTerm | GPU-accelerated rendering (wgpu) | Already in codebase |

### New Crates to Create

1. **`ryngo-ai/`** — All AI inference (STT, TTS, LLM, Vision)
   - `Cargo.toml` with `whisper-rs`, `llama-cpp-2`, `cpal`, `reqwest`
   - `src/stt.rs` — Whisper integration, audio capture, transcription
   - `src/llm.rs` — Gemma 3n text inference, output summarization
   - `src/vision.rs` — Gemma 3n image-to-text
   - `src/tts.rs` — Orpheus inference + SNAC audio decoding
   - `src/models.rs` — Model download manager (HuggingFace → `~/.ryngo/models/`)
   - `src/lib.rs` — Public API

2. **`ryngo-agent/`** — Agent orchestration
   - `src/detector.rs` — Parse PTY output to detect Claude Code / Codex patterns
   - `src/status.rs` — Agent status tracking (idle/thinking/writing/waiting/error)
   - `src/commands.rs` — `:spawn`, `:agents`, `:kill` command implementations
   - `src/lib.rs` — Public API

---

## Models

### Gemma 3n (Primary LLM + Vision)

| Variant | Params | VRAM (Q4) | Use Case |
|---------|--------|-----------|----------|
| **E4B** | ~4B effective | ~3.9 GB | Recommended — better vision, summarization |
| **E2B** | ~2B effective | ~2.0 GB | Low-VRAM option, still capable |

- Format: GGUF (via llama.cpp)
- Download: HuggingFace (bartowski or official Google quantized)
- Capabilities: Text generation, image understanding, output summarization
- Context: 32K tokens

### Whisper (STT)

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| `base.en` | ~150 MB | Fastest | Good for commands |
| `small.en` | ~500 MB | Fast | Better for natural speech |
| `large-v3-turbo` | ~800 MB | Medium | Near-human accuracy |

- Default: `small.en` (good balance)
- Format: GGML (loaded by whisper-rs)
- Can be fine-tuned on terminal jargon (kubectl, chmod, JSON, etc.)

### Orpheus TTS (Text-to-Speech)

| Model | Size (Q4) | Latency | Quality |
|-------|-----------|---------|---------|
| `orpheus-3b-0.1-ft` | ~2.0 GB | ~200ms streaming | Natural, emotional |

- Format: GGUF (via llama.cpp — same backend as Gemma 3n)
- 8 built-in voices: tara, leah, leo, dan, mia, zac, zoe, jess
- Supports emotional tags: `<laugh>`, `<sigh>`, `<gasp>`, `<chuckle>`
- **IMPORTANT**: Orpheus outputs SNAC audio tokens, NOT raw audio. You must decode
  SNAC tokens → audio samples. See [SNAC Decoding](#snac-decoding) section.

---

## Hotkeys

| Hotkey | Action | Implementation |
|--------|--------|----------------|
| `Ctrl+Shift+Space` | Push-to-talk (hold to record, release to transcribe) | ryngo-ai STT |
| `Ctrl+Shift+Alt` | Toggle TTS on/off (speaks summarized output) | ryngo-ai TTS |
| `Ctrl+Shift+V` | Paste image → Gemma 3n vision → text into terminal | ryngo-ai Vision |

These are registered in the WezTerm keybinding system at:
- `config/src/keyassignment.rs` — Add new `KeyAssignment` variants
- `wezterm-gui/src/inputmap.rs` — Add default bindings

---

## Commands (Terminal-Native)

Ryngo commands are prefixed with `:` and typed directly in the terminal:

| Command | Action |
|---------|--------|
| `:spawn cc [path]` | Launch new Claude Code instance in a new tab |
| `:spawn codex [path]` | Launch new Codex instance in a new tab |
| `:agents` | List all detected AI agent sessions with status |
| `:kill <id>` | Kill an agent session by ID |
| `:models` | Show loaded models and VRAM usage |
| `:voice <on\|off>` | Toggle voice features |
| `:tts voice <name>` | Switch TTS voice (tara, leo, mia, etc.) |

Implementation: `:` prefix is intercepted by the input handler before being sent to
the shell. This lives in `wezterm-gui/src/termwindow/` input handling.

---

## Milestones

### Milestone 1: Terminal App (Mac + Windows)
> Goal: Rebrand WezTerm → Ryngo, verify it builds and runs on both platforms.

- [ ] **Rebrand core binaries**
  - Rename `wezterm` → `ryngo`, `wezterm-gui` → `ryngo-gui`,
    `wezterm-mux-server` → `ryngo-mux-server`
  - Update `Cargo.toml` workspace members and all crate names
  - Update `Cargo.lock` (regenerate after renames)
- [ ] **Update user-facing strings**
  - `wezterm/src/main.rs` line 26: `"Wez's Terminal Emulator"` → `"Ryngo Terminal"`
  - `wezterm-gui-subcommands/src/lib.rs` line 7: `DEFAULT_WINDOW_CLASS` →
    `"dev.ryngo.terminal"`
  - Window title, about dialog, version strings
- [ ] **Update config paths**
  - `config/src/lib.rs` and `config/src/config.rs`: Change config resolution from
    `wezterm.lua` → `ryngo.lua`, `.wezterm` → `.ryngo`,
    `XDG wezterm/` → `XDG ryngo/`
  - Environment variables: `WEZTERM_CONFIG_FILE` → `RYNGO_CONFIG_FILE`, etc.
  - **Keep backward compat**: Check for `wezterm.lua` as fallback during transition
- [ ] **Update platform assets**
  - macOS: `assets/macos/WezTerm.app/Contents/Info.plist` — bundle ID →
    `dev.ryngo.terminal`, display name → `Ryngo`
  - Windows: `wezterm-gui/build.rs` — product name, company, description, icon
  - Desktop/AppData files: `assets/wezterm.desktop` → `assets/ryngo.desktop`
- [ ] **Update Lua API module name**
  - `config/src/lua.rs` line 59: `get_or_create_module(lua, "wezterm")` — the Lua
    module is `wezterm`. Rename to `ryngo` but also register `wezterm` as alias
    for backward compatibility with existing WezTerm configs people might adapt.
- [ ] **Verify builds**
  - `cargo build --release` on macOS (Apple Silicon)
  - `cargo build --release` on Windows
  - Run the binary, open a shell, execute commands, verify tabs/splits work
- [ ] **Update README.md** with Ryngo branding and description
- [ ] **Create `~/.ryngo/` directory structure on first run**

### Milestone 2: Gemma 3n + STT
> Goal: Load local AI models, enable speech-to-text and image paste.

- [ ] **Create `ryngo-ai` crate**
  - Add to workspace `Cargo.toml` members
  - Set up `Cargo.toml` with dependencies:
    ```toml
    [dependencies]
    whisper-rs = { version = "0.13", features = ["metal"] }  # macOS
    llama-cpp-2 = "0.1"
    cpal = "0.15"
    reqwest = { version = "0.12", features = ["stream"] }
    tokio = { version = "1", features = ["rt-multi-thread", "fs"] }
    hound = "3.5"  # WAV writing
    ```
  - Use feature flags: `features = ["metal"]` on macOS, `features = ["cuda"]` on Windows
- [ ] **Model manager** (`ryngo-ai/src/models.rs`)
  - Download GGUF/GGML files from HuggingFace to `~/.ryngo/models/`
  - Show download progress in status bar
  - Verify checksums
  - Support both Gemma 3n E4B and E2B (user choice at first run)
- [ ] **STT integration** (`ryngo-ai/src/stt.rs`)
  - Initialize whisper-rs with model from `~/.ryngo/models/`
  - Audio capture via `cpal` (default input device)
  - Ctrl+Shift+Space: start recording → on release: transcribe → inject text into terminal
  - Visual indicator in status bar while recording (waveform or pulsing dot)
- [ ] **Gemma 3n text** (`ryngo-ai/src/llm.rs`)
  - Load GGUF via `llama-cpp-2`
  - Expose `summarize(text: &str) -> String` for output summarization
  - Expose `parse_intent(text: &str) -> Intent` for command routing
- [ ] **Vision pipeline** (`ryngo-ai/src/vision.rs`)
  - Ctrl+Shift+V: intercept paste, detect image in clipboard
  - Send image to Gemma 3n vision → get text description
  - Inject description into terminal as text (for Claude Code / Codex to consume)
  - Support: PNG, JPEG, screenshot data from clipboard
- [ ] **First-run wizard**
  - Detect GPU (Metal on macOS, CUDA/Vulkan on Windows)
  - Show VRAM estimate
  - Let user choose: E4B (~6 GB total with Orpheus) vs E2B (~4 GB total)
  - Let user choose Whisper model size
  - Download selected models
  - Option to skip AI features entirely (just use as a terminal)
- [ ] **Wire into GUI**
  - Add `ryngo-ai` as dependency of `ryngo-gui`
  - Initialize AI subsystem on startup (in background thread)
  - Register hotkeys in keybinding system

### Milestone 3: Power Features
> Goal: Agent detection, status tracking, orchestration commands.

- [ ] **Create `ryngo-agent` crate**
  - Add to workspace
- [ ] **Agent detector** (`ryngo-agent/src/detector.rs`)
  - Monitor PTY output streams for known patterns:
    - Claude Code: permission prompts, tool use indicators, thinking indicators
    - Codex: status patterns
  - Classify agent state: idle / thinking / writing / waiting-for-approval / errored
- [ ] **Status bar integration**
  - Add agent status indicators to the existing WezTerm tab bar / status bar area
  - Show: model name, VRAM usage, agent states, STT active, TTS on/off
  - Implementation: extend `wezterm-gui/src/termwindow/render/tab_bar.rs`
- [ ] **`:spawn` command**
  - `:spawn cc` → open new tab, run `claude` CLI
  - `:spawn cc /path/to/project` → open new tab with working dir, run `claude`
  - `:spawn codex` → same for Codex
  - Parse in input handler, create new tab via mux API
- [ ] **`:agents` command**
  - List all detected agent sessions: ID, type, status, tab, working dir
  - Output in terminal as formatted text
- [ ] **`:kill` command**
  - Kill agent by ID (sends SIGTERM to PTY process)
- [ ] **`:models` command**
  - Show loaded models, VRAM usage, download status
- [ ] **Semantic search of scrollback** (stretch)
  - Use Gemma 3n to search terminal history with natural language
  - "Find where the build failed" → highlights relevant output

### Milestone 4: TTS + Ship
> Goal: Add text-to-speech, polish, package for distribution.

- [ ] **Orpheus TTS integration** (`ryngo-ai/src/tts.rs`)
  - Load Orpheus GGUF via `llama-cpp-2` (same backend as Gemma 3n)
  - Generate SNAC audio tokens from text
  - Decode SNAC tokens to audio samples (see SNAC Decoding below)
  - Stream audio output via `cpal` (default output device)
- [ ] **LLM-preprocessed TTS pipeline**
  - Before speaking terminal output, run it through Gemma 3n to:
    - Strip ANSI escape codes
    - Collapse repeated warnings/errors ("47 warnings" not each one)
    - Summarize build output ("Build succeeded with 3 warnings")
    - Make technical output speakable ("slash etc slash nginx" not "/etc/nginx")
  - This is the killer feature — nobody else does this
- [ ] **TTS controls**
  - Ctrl+Shift+Alt toggles TTS on/off
  - `:tts voice tara` switches voice
  - Barge-in: if user starts speaking (STT activates), stop TTS immediately
  - Stream output (start speaking before full response is generated)
- [ ] **Emotional tags**
  - Gemma 3n can insert Orpheus emotional tags contextually:
    - Build failed → `<sigh> Build failed with 47 errors`
    - Build succeeded → `Build succeeded! <chuckle>`
    - Permission prompt → careful, clear tone
- [ ] **Packaging**
  - macOS: `.dmg` with Ryngo.app bundle (code-signed if possible)
  - Windows: `.msi` installer via `ci/windows-installer.iss` (updated for Ryngo)
  - Include model download on first launch (not bundled — keeps installer small)
- [ ] **README and docs**
  - Installation guide
  - Model requirements (GPU, VRAM)
  - Hotkey reference
  - Configuration guide (`ryngo.lua`)

---

## SNAC Decoding

**Critical implementation detail for Orpheus TTS.**

Orpheus outputs token IDs that encode audio via the SNAC (Structured Noise-Aware Codec)
scheme. These are NOT directly playable audio. The decoding pipeline is:

1. Orpheus generates tokens like: `<custom_token_10348>`, `<custom_token_12567>`, ...
2. Extract the numeric part: `10348`, `12567`, ...
3. Map tokens to 3 SNAC codebook layers:
   - Tokens 10048–10048+4096 → Layer 0 (coarse, 12 Hz)
   - Tokens 10048+4096–10048+8192 → Layer 1 (medium, 24 Hz)
   - Tokens 10048+8192–10048+12288 → Layer 2 (fine, 48 Hz)
4. Subtract offset to get codebook indices
5. Feed the 3 layers into the SNAC decoder (a small neural network) to produce 24kHz audio

**Options for SNAC decoding in Rust:**
- Use `candle` (Rust ML framework) to load the SNAC decoder weights
- Use `ort` (ONNX Runtime Rust bindings) with a pre-exported SNAC ONNX model
- Pre-compute a lookup table if the codebook is static (fastest, but lower quality)

The SNAC decoder model is small (~10MB). Ship it alongside Orpheus.

---

## Codebase Map (Existing WezTerm Structure)

Understanding where things live in the WezTerm codebase:

### Entry Points
- `wezterm/src/main.rs` — CLI wrapper, spawns GUI binary
- `wezterm-gui/src/main.rs` — Main GUI application
- `wezterm-mux-server/src/main.rs` — Background multiplexer daemon

### Configuration
- `config/src/lib.rs` — Config crate root (modules: lua, keys, font, color, etc.)
- `config/src/config.rs` — Main `Config` struct with all settings
- `config/src/lua.rs` — Lua interpreter setup, `wezterm` module registration
- `config/src/keyassignment.rs` — All keybinding actions (`KeyAssignment` enum)
- `config/src/keys.rs` — Default keybinding definitions

### GUI & Rendering
- `wezterm-gui/src/termwindow/` — Main window implementation
  - `mod.rs` — TermWindow struct, event loop
  - `render/mod.rs` — Rendering pipeline
  - `render/paint.rs` — Low-level GPU painting
  - `render/tab_bar.rs` — Tab bar rendering (extend for status bar)
  - `render/fancy_tab_bar.rs` — Fancy tab bar variant
- `wezterm-gui/src/inputmap.rs` — Keybinding → action mapping
- `wezterm-gui/src/overlay/` — Overlay UIs (search, launcher, etc.)
- `window/` — Cross-platform window abstraction (Cocoa, Win32, X11, Wayland)

### Terminal Emulation
- `term/` — Core terminal emulation (`wezterm-term` crate)
- `termwiz/` — Terminal abstraction library (escape parsing, input handling)
- `pty/` — Pseudo-terminal abstraction (`portable-pty`)

### Multiplexing
- `mux/` — Multiplexer core (tabs, panes, domains)
- `wezterm-client/` — Client for remote mux connections
- `wezterm-mux-server-impl/` — Server implementation

### Assets
- `assets/icon/` — App icons (SVG, PNG, ICO, ICNS)
- `assets/macos/WezTerm.app/` — macOS app bundle template
- `assets/windows/` — Windows resources (ANGLE DLLs, ConPTY, icons)
- `assets/shell-integration/` — Shell integration scripts
- `assets/shell-completion/` — Bash/Zsh/Fish completions

### Build & CI
- `Cargo.toml` — Workspace root
- `Makefile` — Build targets (`make build`, `make test`)
- `ci/` — CI scripts, installers, packaging
- `.github/workflows/` — GitHub Actions

---

## Rebranding Reference

### Naming Convention
When modifying WezTerm code, use this comment convention to mark Ryngo additions:

```rust
// RYNGO: description of addition/change
```

This makes it easy to track what we've changed vs. original WezTerm code.

### What to Rename vs. What to Keep

**RENAME** (user-facing, affects UX):
- Binary names: `wezterm` → `ryngo`, `wezterm-gui` → `ryngo-gui`
- Window titles and about strings
- Config file names: `wezterm.lua` → `ryngo.lua`
- Config directories: `.wezterm` → `.ryngo`, `XDG wezterm/` → `XDG ryngo/`
- Environment variables: `WEZTERM_*` → `RYNGO_*`
- Bundle IDs: `com.github.wez.wezterm` → `dev.ryngo.terminal`
- Desktop/AppData files
- Lua module name: `wezterm` → `ryngo` (keep `wezterm` as alias)

**DO NOT RENAME** (internal, would break too much):
- Internal crate directory names (`wezterm-font/`, `wezterm-cell/`, etc.) — renaming
  18 directories causes massive churn. Keep internal names as-is for now.
- Internal module references and import paths
- Cargo package names in Cargo.toml for internal crates (except the 3 binaries)
- Test files and test data

**Rationale**: Speed to market. Renaming 855 files for cosmetic internal consistency
would take days and create merge conflicts with upstream WezTerm. Focus energy on
the AI features that differentiate Ryngo.

### Critical Files for Rebranding (Priority Order)

1. `wezterm/src/main.rs` — CLI about string, binary behavior
2. `wezterm-gui/src/main.rs` — GUI about string
3. `wezterm-gui-subcommands/src/lib.rs` — `DEFAULT_WINDOW_CLASS`
4. `config/src/lib.rs` + `config/src/config.rs` — Config file paths
5. `config/src/lua.rs` — Lua module name
6. `config/src/version.rs` — Version string functions
7. `assets/macos/WezTerm.app/Contents/Info.plist` — macOS bundle
8. `wezterm-gui/build.rs` — Windows resource metadata
9. `assets/wezterm.desktop` — Linux desktop entry
10. `README.md` — User-facing docs
11. `Cargo.toml` (workspace root) — Binary crate names only
12. `wezterm/Cargo.toml`, `wezterm-gui/Cargo.toml`, `wezterm-mux-server/Cargo.toml` —
    Binary names only

---

## Build Instructions

### macOS (Apple Silicon)

```bash
# Prerequisites
brew install cmake pkg-config

# Build
cargo build --release

# The binaries will be at:
# target/release/wezterm (→ rename to ryngo in Cargo.toml)
# target/release/wezterm-gui (→ rename to ryngo-gui)
# target/release/wezterm-mux-server (→ rename to ryngo-mux-server)

# Run
./target/release/wezterm-gui  # (or ryngo-gui after rename)
```

Metal acceleration is enabled by default for:
- `whisper-rs`: Metal backend via whisper.cpp
- `llama-cpp-2`: Metal backend via llama.cpp

### Windows

```powershell
# Prerequisites: Visual Studio 2022 Build Tools, CMake, Rust

# Build
cargo build --release

# Note: CUDA support requires CUDA Toolkit 12.x installed
# Vulkan is a fallback that requires no extra install
```

---

## Code Style

- Follow existing WezTerm patterns — if WezTerm does it one way, do it that way
- Use `// RYNGO:` comments for all new code and modifications
- Keep WezTerm modifications minimal — add Ryngo features in new crates where possible
- Prefer `anyhow::Result` for error handling (WezTerm convention)
- Use `log` crate for logging (WezTerm convention)
- Run `cargo fmt` before committing
- Run `cargo clippy` and fix warnings

---

## Implementation Notes

### 1. GPU Memory Budget
Both Gemma 3n and Orpheus run on the same `llama-cpp-2` backend. They share GPU memory.
Budget for Apple Silicon (8GB unified memory Mac):
- Gemma 3n E2B Q4: ~2.0 GB
- Orpheus 3B Q4: ~2.0 GB
- Whisper small.en: ~0.5 GB (CPU is fine, GPU optional)
- OS + Terminal: ~2-3 GB
- **Total: ~6.5 GB** — fits on 8GB Mac with E2B, needs 16GB for E4B

### 2. Threading Model
- AI inference runs on dedicated background threads, never blocking the GUI
- Audio capture/playback runs on `cpal` audio threads
- PTY I/O runs on async tasks (existing WezTerm `smol` runtime)
- Model loading happens at startup in background, terminal is usable immediately
- Status bar shows "Loading models..." until ready

### 3. Whisper Fine-Tuning (Optional, Post-Launch)
Can fine-tune Whisper on terminal jargon for better recognition of:
- Commands: `kubectl`, `chmod`, `grep`, `nginx`
- Programming terms: `async`, `mutex`, `HashMap`, `Vec<String>`
- Path separators: `/etc/nginx/conf.d`

Process: Fine-tune with HuggingFace Transformers (PyTorch), then convert to GGML
with `convert-h5-to-ggml.py` for whisper-rs to load. Even 50-100 synthetic samples
(generated via Piper TTS from text corpus) make a difference.

### 4. Gemma 3n Vision GGUF Status
As of early 2025, Gemma 3n text works in GGUF/llama.cpp. Multimodal (vision) GGUF
support is being actively developed. If vision GGUF is not ready when we hit Milestone 2:
- **Fallback**: Use `candle` (Rust ML) or `ort` (ONNX Runtime) for vision inference
- **Or**: Wait — llama.cpp multimodal support ships frequently
- Check: https://github.com/ggerganov/llama.cpp/issues for Gemma 3n vision status

### 5. Config Schema Extension
Ryngo extends WezTerm's Lua config. Users write `ryngo.lua`:

```lua
local ryngo = require 'ryngo'
local config = ryngo.config_builder()

-- Standard terminal config (all WezTerm options work)
config.font_size = 14.0
config.color_scheme = 'Catppuccin Mocha'

-- Ryngo AI config
config.ryngo_ai = {
  enabled = true,
  gemma_model = 'e4b',        -- or 'e2b'
  whisper_model = 'small.en',
  tts_voice = 'tara',
  tts_enabled = false,         -- off by default, toggle with Ctrl+Shift+Alt
}

return config
```

### 6. The : Command Parser
The `:` command system intercepts input before it reaches the shell. Implementation:
- In `wezterm-gui/src/termwindow/` input handling, check if the current input line
  starts with `:` when Enter is pressed
- If it matches a known Ryngo command, handle it internally
- If not, pass through to the shell as normal
- Display command output in the terminal (not a separate UI — stay terminal-native)

### 7. Agent Detection Patterns
Parse PTY output for these patterns (regex or string matching):

**Claude Code:**
- `╭─` / `╰─` box drawing (tool use blocks)
- `Allow` / `Deny` (permission prompts)
- Thinking indicators
- `$ ` prompt return (idle)

**Codex:**
- Status line patterns (research needed — parse actual Codex output)

Store detected state per-tab in `ryngo-agent` crate.

---

## User System Requirements

### Minimum
- **macOS**: Apple Silicon (M1+), macOS 13+, 8 GB RAM
- **Windows**: Windows 10+, 8 GB RAM, GPU with 4+ GB VRAM (NVIDIA recommended)
- **Disk**: ~5 GB for models + app

### Recommended
- 16 GB RAM (for E4B model + comfortable headroom)
- NVIDIA GPU with 8+ GB VRAM (Windows) or M1 Pro/Max (macOS)
