# Ryngo

> A GPU-accelerated terminal built for AI coding agents.

Ryngo is a terminal emulator that treats AI agents like Claude Code and Codex as first-class citizens. Built on [WezTerm](https://github.com/wezterm/wezterm), it auto-detects running agents, handles permission prompts intelligently, and ships with optional local AI models for voice and vision — all with a translucent glass UI.

## Install

### macOS (Apple Silicon)

Download the latest release:

```
https://github.com/MarshallDoyle/Ryngo/releases
```

### Windows

Download the installer from [Releases](https://github.com/MarshallDoyle/Ryngo/releases).

### Build from Source

```bash
# Prerequisites (macOS)
brew install cmake pkg-config

# Clone and build
git clone https://github.com/MarshallDoyle/Ryngo.git
cd Ryngo
cargo build --release -p ryngo -p ryngo-gui -p ryngo-mux-server

# Run
./target/release/ryngo-gui
```

## Quick Start

1. Open Ryngo
2. Run `claude` — Claude Code launches with auto-approved permissions
3. Work normally — Ryngo handles permission prompts automatically
4. The status bar at the bottom shows agent state (thinking / writing / idle)

## How It Works

Ryngo monitors PTY output to detect AI agents running in each tab, then:

- **Auto-approves** safe operations (file reads, edits, builds, tests)
- **Asks once** for sensitive operations (sudo, git push, destructive commands)
- **Denies** truly dangerous actions (rm -rf /, DROP DATABASE)

The agent detector recognizes Claude Code and Codex session patterns automatically — no configuration needed.

## Features

- **Agent Detection** — Claude Code and Codex recognized automatically via PTY output parsing
- **Auto-Approval** — Permission prompts answered intelligently based on risk classification
- **Glass UI** — Native translucent vibrancy blur (NSVisualEffectView on macOS, Acrylic on Windows 11)
- **Status Bar** — Always-visible bar showing agent state, model status, and command mode
- **Local AI** (optional) — Gemma 3n + Whisper STT, downloaded on first run to `~/.ryngo/models/`
- **Push-to-Talk** — Shift+Space to speak commands via local Whisper model
- **LLM Chat** — Shift+Cmd+L for local AI overlay powered by Gemma 3n
- **Screenshot & Screen View** — Native screen capture for sharing with AI agents
- **Full WezTerm Compatibility** — All WezTerm configs, keybindings, and features work
- **GPU Accelerated** — wgpu-based rendering with Metal (macOS) and DirectX 12 (Windows)
- **Tabs, Splits, Multiplexing** — Full terminal multiplexer built in

## Configuration

Ryngo uses Lua configuration files. Create `~/.config/ryngo/ryngo.lua`:

```lua
local ryngo = require 'ryngo'
local config = ryngo.config_builder()

config.font_size = 14.0
config.color_scheme = 'Catppuccin Mocha'

-- Glass UI (enabled by default)
config.ryngo_blur_enabled = true
config.ryngo_background_opacity = 0.85
config.ryngo_tab_bar_opacity = 0.9
config.ryngo_status_bar_opacity = 0.95

return config
```

Existing WezTerm configurations are supported — `local wezterm = require 'wezterm'` still works as a backward-compatible alias.

### Glass UI Options

| Option | Default | Description |
|--------|---------|-------------|
| `ryngo_blur_enabled` | `true` | Master switch for glass/blur effect |
| `ryngo_blur_radius` | `20` | macOS blur radius (ignored on Windows) |
| `ryngo_background_opacity` | `0.85` | Terminal area opacity |
| `ryngo_tab_bar_opacity` | `0.9` | Tab bar opacity |
| `ryngo_status_bar_opacity` | `0.95` | Status bar opacity |

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
│  │          ryngo-ai crate                  │    │
│  │  whisper-rs (STT) │ llama-cpp (Gemma 3n) │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │        ryngo-agent crate                 │    │
│  │  Agent detection, auto-approval, status  │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

## Requirements

- **macOS**: Apple Silicon (M1+), macOS 13+, 8 GB RAM
- **Windows**: Windows 10+, 8 GB RAM, GPU with 4+ GB VRAM
- **Disk**: ~50 MB for app, ~5 GB for optional AI models
- **Recommended**: 16 GB RAM for comfortable AI model usage

## License

MIT — forked from [WezTerm](https://github.com/wezterm/wezterm)
