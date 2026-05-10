# Plinth — MVP

Paste a GitHub repo URL, get a node editor of its import graph.

This is a deliberate single-feature MVP. Files are nodes, npm packages are nodes, imports are edges. Everything heavier — typed edges, cross-service resolution, PR-diffed graphs, the things in `../spec/` and `../design/` — comes later.

## Run

Requires **Node 20+** and **git** on your `PATH`.

```bash
cd mvp
npm install
npm run dev
```

Open <http://localhost:5173>. Vite serves the SPA on `:5173` and proxies `/api/*` to the Express server on `:3000`. Both processes are watched.

## How it works

1. **Clone** — `git clone --depth=1 --single-branch` into a temp directory.
2. **Walk** — recursive `readdir`, sorted, capped at 1500 files. Skips `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `coverage`, `target`, `__pycache__`, `.venv`, etc. Skips files larger than 1 MB.
3. **Parse** — for `.ts/.tsx/.js/.jsx/.mjs/.cjs` files, regex-extract `import`, `export … from`, `require()`, and dynamic `import()` specifiers. Cap source size at 500 KB.
4. **Resolve** — relative imports walk against the file index (with the standard extension and `index.*` fallbacks). External specifiers bucket by package name (`@scope/pkg` keeps the scope; `node:fs` stays distinct).
5. **Render** — file nodes (gray) and package nodes (amber dashed) laid out left-to-right with dagre, drawn in React Flow.

The temp clone is removed on the way out, success or failure.

## Production

```bash
cd mvp
npm install
npm run build
npm start
```

This builds the SPA into `dist/` and runs a single Express process on `:3000` that serves both the static frontend and the API.

## Smoke test

```bash
npm run smoke                                # uses vercel/ms (small)
npm run smoke -- https://github.com/expressjs/express
```

Calls `analyzeRepo` directly (no HTTP) and asserts the IR shape, then prints a one-line summary. Doubles as a check that `git` and Node are wired up correctly.

## Limits and known cuts

- **Languages**: TS/JS only. Python, Go, Rust, etc. are not analyzed; they show up in the file count but emit no edges.
- **Imports parsing**: regex-based. Catches >95% of real-world cases. Misses on purpose: comment stripping, conditional imports inside `eval`, fancy macros, nested `require` re-exports.
- **Cross-repo**: never. Public repos only.
- **Cap**: 1500 files. Bigger repos surface a `truncated: true` flag in stats and stop walking.
- **No auth**: GitHub anonymous clone only. Private repos / SSH URLs / non-`github.com` hosts are rejected.
- **No persistence**: nothing is cached. Every analyze is a fresh clone.
- **No rate limiting** beyond a per-IP concurrency cap (2). Don't expose this directly to the public internet without a real reverse proxy.

## File layout

```
mvp/
├── package.json           — deps, scripts
├── server.js              — Express: /api/analyze, /api/health, static dist/ in prod
├── lib/
│   └── analyze.js         — clone + walk + parse + IR builder
├── scripts/
│   └── smoke.js           — `node scripts/smoke.js` end-to-end check
├── vite.config.js         — Vite + React, /api proxied to :3000 in dev
├── index.html             — SPA entry
└── src/
    ├── main.jsx           — React root
    ├── App.jsx            — URL input + React Flow canvas + inspector
    └── styles.css         — dark theme, Plinth visual identity (Volt accent)
```

## Why this scope

The full Plinth design (`../spec/`, `../design/`, `../packages/`) describes a typed-graph IR with framework adapters, a diff algorithm, and a GitHub Action. That whole apparatus is the v1.0 vision. This MVP is the smallest thing that gives you the same _feel_ — paste a URL, see your codebase as a graph — without any of the cross-language plumbing or the typed-edge work. When the IR types stabilize, the `analyze.js` IR shape can be replaced by `@codegraph/core/ir` and the viewer can be swapped out for `packages/viewer`.

## MCP server (LLM-native interface)

Ryngo ships an MCP server (`mvp/mcp-server.js`) that exposes the
analyzer + LLM projections to any MCP-compatible client — Claude Code,
Claude Desktop, the ChatGPT Apps SDK, Cursor (via plugin), Continue,
custom agents.

For the client-by-client setup path, see
[`mvp/docs/AGENT_VIEWER.md`](docs/AGENT_VIEWER.md). The shortest local
proof is:

```bash
cd mvp
npm run mcp:map -- https://github.com/vercel/ms
```

**No LLM inference happens server-side.** Ryngo is the map your
agent reads; the model is whatever the user is paying for. We just
clone, parse, and serve structured projections.

### Tools exposed

| Tool | What it does |
|---|---|
| `analyze_repo(github_url, ref?)` | Clones a repo (shallow), returns IR stats |
| `get_view_model(github_url, ref?, mode?, max_nodes?)` | RyngoViewModel v1: capped graph contract for agent-rendered viewers |
| `get_compact_ir(github_url, ref?)` | Stripped IR ready to paste into prompts |
| `get_topology(github_url, ref?)` | ~300-token markdown bird's-eye view |
| `get_subgraph(github_url, root_id, hops?)` | k-hop neighborhood around a node |
| `english_signature(github_url, node_id)` | Prose description of one fn / class |
| `find_node(github_url, query)` | Fuzzy label search → stable node ids |
| `list_intents(repo)` | Read `.ryngo/intents/` |
| `read_intent(repo, intent_id)` | Full intent body |
| `list_annotations(repo)` | Read `.ryngo/annotations.md` |

### Transports

- `npm run mcp` starts the stdio server for Claude Code, Claude Desktop,
  Codex, Cursor, and other local MCP clients.
- `npm run dev:api` or `npm start` exposes the same tools over Streamable
  HTTP at `/mcp` for ChatGPT Apps / hosted MCP connectors. During local
  ChatGPT development, tunnel the app port and use `https://.../mcp` as the
  connector URL.

### Wiring it into Claude Code

Add to your `~/.config/claude-code/mcp.json` (or whichever path Claude
Code expects on your platform):

```json
{
  "mcpServers": {
    "ryngo": {
      "command": "node",
      "args": ["/absolute/path/to/mvp/mcp-server.js"]
    }
  }
}
```

After restart, Claude Code will discover the tools above. Try:

> _"Use ryngo to give me the topology of github.com/tiangolo/sqlmodel
>  then list every function in it that takes a `Session` parameter."_

### Wiring it into Claude Desktop

Same JSON shape; the file lives at
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.

### Manual smoke

```bash
cd mvp
(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}'
 echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
 echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
 sleep 1) | node mcp-server.js
```

You should see the protocol handshake response followed by the tool
definitions. `npm run smoke:mcp` performs the same discovery check plus
the widget resource check.

To print ready-to-paste Claude and Codex config snippets:

```bash
npm run mcp:config
```

### Session caching

The server keeps the most-recent 8 `(repo, ref)` IRs in memory for 5
minutes so an LLM can drill down across multiple tool calls without
re-cloning. After 5 minutes idle, the next call re-clones HEAD.

### What's NOT in the MCP server

- `apply changes` / `write file` tools — Ryngo is read-only by design.
  Your agent applies code edits with its own tools (Cursor's edit, Claude
  Code's `Edit`, etc.); Ryngo's job is to give it a coherent map first.
- LLM calls of any kind. Same point.
- Annotation writes. Coming when the security model for cross-tenant
  writes is decided.
