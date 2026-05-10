# Ryngo Agent Viewer

This is the local-first setup for giving Claude, Codex, or ChatGPT a
GitHub URL and getting back the read-only Ryngo node viewer plus the
high-level codebase data behind it.

The shared contract is `RyngoViewModel v1`, returned by the MCP tool
`get_view_model(github_url, ref?, mode?, max_nodes?)`. It contains the
repo summary, capped graph nodes, edges, clusters, highlights, default
inspector facts, compiler-quality summary, truncation limits, and
suggested drill-down prompts.

## One-command proof

```bash
cd mvp
npm install
npm run mcp:map -- https://github.com/vercel/ms
```

Expected result: Ryngo clones the repo through the stdio MCP server,
prints a markdown map, and ends with `MCP map OK`.

## Claude Code or Claude Desktop

Use the plain endpoint when connecting through `mcp-remote`. Claude can
use Ryngo's tools and structured summaries, but it should not receive
ChatGPT widget resources.

```json
{
  "mcpServers": {
    "ryngo": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://ryngo-261437541038.us-west1.run.app/mcp/plain"
      ]
    }
  }
}
```

Print the exact local config for this checkout:

```bash
cd mvp
npm run mcp:config
```

Add the JSON snippet under `mcpServers` in the Claude config file, then
restart Claude.

On macOS, Claude Desktop commonly uses:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

The shape is:

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

Then ask Claude:

```text
Use Ryngo to map https://github.com/vercel/ms with max_nodes 80.
Explain the high-level code structure, then suggest which node I should
inspect first.
```

Claude should call `get_view_model`, then use `get_subgraph`,
`get_compile_report`, `find_node`, or `english_signature` when you ask
follow-up questions.

## Codex

Print the exact TOML for this checkout:

```bash
cd mvp
npm run mcp:config
```

Add the TOML snippet to `~/.codex/config.toml`, then restart Codex:

```toml
[mcp_servers.ryngo]
command = "node"
args = ["/absolute/path/to/mvp/mcp-server.js"]
```

Then ask Codex:

```text
Use the Ryngo MCP server to call get_view_model for
https://github.com/vercel/ms. Give me the high-level map and show useful
node IDs for drill-down.
```

## ChatGPT Apps / HTTP MCP

ChatGPT should use the widget endpoint:

```text
https://ryngo-261437541038.us-west1.run.app/mcp
```

For local development, run Ryngo on port 3000 and tunnel it.

Terminal 1:

```bash
cd mvp
npm run dev:api
```

Terminal 2:

```bash
ngrok http 3000
```

Use the HTTPS forwarding URL with `/mcp` appended as the connector URL:

```text
https://<your-ngrok-host>/mcp
```

Then ask ChatGPT:

```text
Use Ryngo to map https://github.com/vercel/ms. Render the viewer and
summarize the important files, routes, packages, and suggested
drill-downs.
```

ChatGPT should discover `get_view_model`, receive `structuredContent`
using `RyngoViewModel v1`, and render the bundled read-only widget from
`ui://widget/ryngo-viewer.html`.

## Ryngo web app

The web app reuses the same view model projection without going through
MCP.

```bash
cd mvp
npm run dev
```

Open `http://localhost:5173`, paste a GitHub URL, then use the
`Agent Map` tab. This gives the same high-level node list, filters,
clusters, inspector facts, and prompts that agents receive.

## Smoke checks

```bash
cd mvp
npm run smoke:mcp
npm run smoke:compile-report
npm run smoke:mcp:http -- http://localhost:3000/mcp
npm run smoke:mcp:http -- http://localhost:3000/mcp/plain
npm run smoke:view-model
npm run mcp:map -- https://github.com/vercel/ms
```

Use these before handing work between Claude and Codex. The first check
proves stdio tool/resource discovery, the compile-report check proves
compiler-quality scoring, the HTTP check proves the ChatGPT/Cloud Run
path, the view-model check proves deterministic projection behavior,
and `mcp:map` proves a real GitHub URL can become a usable MCP map.

## Tool boundary for future logging

The clean event boundaries for the later database workstream are:

- `get_view_model`: repo submission, ref, mode, node cap, returned and
  omitted counts, compiler-quality status.
- `get_compile_report`: parser backends, parse statuses, weak files,
  quality flags, and recommendations.
- `get_subgraph`: selected node, hop count, returned neighborhood.
- `find_node`: query text and match count.
- `english_signature`: selected node and whether a prose signature was
  available.

Do not add server-side LLM inference to this path. Ryngo maps the repo;
the connected agent does the reasoning.
