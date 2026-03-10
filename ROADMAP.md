# Ryngo Roadmap

## v0.1 — Foundation
- [x] Fork WezTerm, rebrand binary names (ryngo, ryngo-gui, ryngo-mux-server)
- [x] Agent detection (Claude Code, Codex) via PTY output parsing
- [x] Auto-approval of permission prompts (risk classification)
- [x] Status bar with agent state (thinking/writing/idle)
- [x] ryngo-ai and ryngo-agent crates
- [x] Ryngo color scheme (Google dark palette)
- [x] Config: ryngo.lua with wezterm.lua fallback

## v0.2 — Polish (Current)
- [x] Complete WezTerm → Ryngo rebrand (user-facing strings, env vars, paths)
- [x] Liquid glass UI (macOS NSVisualEffectView + Windows Acrylic)
- [x] Translucent tab bar and status bar with configurable opacity
- [x] GitHub repo renamed to MarshallDoyle/Ryngo
- [x] README with install instructions and architecture
- [x] Windows installer updated (Inno Setup)
- [ ] Screenshot and screen view for AI agent sharing

## v0.3 — Distribution
- [ ] macOS DMG with code signing + notarization
- [ ] Homebrew cask (`brew install --cask ryngo`)
- [ ] Windows installer (.exe) via Inno Setup
- [ ] WinGet package (`winget install ryngo`)
- [ ] GitHub Actions release pipeline
- [ ] Auto-update mechanism

## v0.4 — AI Features
- [ ] Gemma 3n model loading (GGUF compatibility)
- [ ] LLM-powered auto-approval (nuanced risk classification)
- [ ] Vision paste (Ctrl+Shift+V → image to text via Gemma 3n)
- [ ] First-run model download wizard with GPU detection
- [ ] :models command to show loaded models and VRAM

## v0.5 — Voice
- [ ] Orpheus TTS with SNAC decoding
- [ ] LLM-preprocessed TTS (summarize terminal output before speaking)
- [ ] Barge-in (STT interrupts TTS)
- [ ] Emotional tags in TTS output
- [ ] Whisper fine-tuning on terminal jargon

## v0.6 — Commands & Orchestration
- [ ] :spawn cc / :spawn codex — launch agents in new tabs
- [ ] :agents — list all detected agent sessions
- [ ] :kill — terminate agent by ID
- [ ] Semantic search of terminal scrollback via Gemma 3n

## v1.0 — Production
- [ ] Custom Ryngo icon and branding assets
- [ ] Linux packages (.deb, .rpm, Flatpak)
- [ ] Website with documentation
- [ ] Plugin system for custom agent detectors
- [ ] Multi-agent coordination (agents aware of each other)
