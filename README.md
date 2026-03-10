# Ryngo

A GPU-accelerated terminal emulator for the modern workflow. Built on [WezTerm](https://github.com/wezterm/wezterm), implemented in [Rust](https://www.rust-lang.org/).

Local AI models for voice, vision, and natural language — a better way to interact with agents like Claude Code and Codex.

## Features

- GPU-accelerated rendering via wgpu
- Cross-platform: macOS (Apple Silicon) and Windows
- Embedded local AI models (no cloud, no accounts):
  - **Speech-to-Text**: whisper.cpp via whisper-rs
  - **LLM + Vision**: Gemma 3n via llama.cpp
  - **Text-to-Speech**: Orpheus 3B via llama.cpp
- Agent-aware: detects and tracks Claude Code / Codex sessions
- Full terminal emulation (tabs, splits, multiplexing)
- Lua-based configuration (`ryngo.lua`)

## Building

### Prerequisites

```bash
# macOS
brew install cmake pkg-config

# Windows: Visual Studio 2022 Build Tools, CMake, Rust
```

### Build

```bash
cargo build --release -p ryngo -p ryngo-gui -p ryngo-mux-server
```

### Run

```bash
./target/release/ryngo-gui
```

## Configuration

Ryngo uses Lua configuration files. Create `~/.config/ryngo/ryngo.lua`:

```lua
local ryngo = require 'ryngo'
local config = ryngo.config_builder()

config.font_size = 14.0
config.color_scheme = 'Catppuccin Mocha'

return config
```

Existing WezTerm configurations are supported via backward compatibility (`local wezterm = require 'wezterm'` still works).

## License

MIT
