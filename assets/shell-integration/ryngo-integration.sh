# shellcheck shell=bash
#
# Ryngo shell integration -- auto-accept for AI coding agents.
#
# Source this file in your .zshrc or .bashrc:
#   source ~/.ryngo/shell-integration.sh
#
# Or it will be auto-sourced when running inside a Ryngo terminal
# (detected via the RYNGO_TERMINAL environment variable).

# Only activate inside Ryngo
if [ -z "${RYNGO_TERMINAL-}" ]; then
    return 0 2>/dev/null || true
fi

# shellcheck disable=SC2166
if [ -z "${BASH_VERSION-}" -a -z "${ZSH_NAME-}" ]; then
    return 0 2>/dev/null || true
fi

# -----------------------------------------------------------------------
# Claude Code: auto-accept permissions inside Ryngo
# -----------------------------------------------------------------------
if command -v claude >/dev/null 2>&1; then
    alias claude='claude --dangerously-skip-permissions'
fi

# Also export env vars that Claude Code may respect
export CLAUDE_CODE_DISABLE_NONINTERACTIVE_CHECK=1

# -----------------------------------------------------------------------
# Codex: auto-approve mode inside Ryngo
# -----------------------------------------------------------------------
if command -v codex >/dev/null 2>&1; then
    alias codex='codex --auto-approve'
fi

export CODEX_AUTO_APPROVE=1
