# Ryngo — deferred feature backlog

Running tally of items from the approved roadmap (`/Users/marshalldoyle/.claude/plans/i-want-you-to-quiet-shamir.md`)
that have NOT been shipped yet, why each is deferred, and the smallest
viable next step for each.

Update this file as items are picked up.

## Phase 1 (LLM annotation loop) — partial

Item 19 (Lasso → region) **dropped from roadmap** per user direction
(2026-05-09). The backend (`/api/regions`) stays in place because
intents reference regions; only the lasso UI is removed from scope.

| # | Feature | Status | Why deferred | Next step |
|---|---|---|---|---|
| 20 | Manual edge authoring → wires.md | not started | Same custom drag complexity; lower priority than Apply-and-verify | Add a "wire mode" toggle; drag from one node's right handle to another's left handle; save to `.ryngo/wires.md` |
| 21 | Constraint annotations on regions | not started | Renderer needs custom polygon overlay around region nodes | Render a colored boundary polygon per region; flag any edge that crosses a `must not depend on` rule with a red badge |

## Phase 2 (PM dashboard + diff polish) — partial

| # | Feature | Status | Why deferred | Next step |
|---|---|---|---|---|
| 2 | Service map auto-detect | not started | Heuristic-heavy; needs monorepo workspace detection (pnpm/Turbo/Nx/Bazel) plus framework-presence checks | Detect `pnpm-workspace.yaml`, `turbo.json`, etc.; treat each workspace as a top-tier service node |
| 3 | Stack-layer view (FE / BE / data / infra) | not started | Needs the adapter framework signals; current analyzer is regex-only and doesn't classify by layer | Add `.ryngo.yml` boundary declarations as a first pass; auto-detect from common framework deps later |
| 4 | Health metrics overlay | not started | Needs git churn calculation (`git log --since=…`) + AST-level cyclomatic complexity, neither is wired in | Start with simple overlays we already have data for: orphans (no inbound edges from any entry point) and edge-traffic count |
| 6 | What-changed-this-week panel | not started | Needs date-aware multi-clone (HEAD now and HEAD@{7.days.ago}) | Reuse `/api/diff` with a `since=<duration>` knob; resolve `since` to a SHA via `git rev-list -1 --before=…` |
| 14 | PR comment GitHub Action | not started | Separate deployable action package; biggest single lift in the roadmap | Wrap `/api/diff` as a Docker container action; post sticky comment via `actions/github-script` |

## Phase 3 (collaboration + scale + AI tools) — partial

| # | Feature | Status | Why deferred | Next step |
|---|---|---|---|---|
| 7 | Public read-only share link | not started | Needs token-protected snapshot store + view-only route | Reuse the per-intent snapshot writer (Phase 3 iter 1) for the storage; add `/share/<token>` GET route + redacted viewer mode |
| 9 | Embed widget | not started | Needs static-bundled mini viewer + `/embed` route | After share-link infra; reuse the same snapshot path |
| 25 | Ryngo MCP server | not started | Separate process; needs the MCP SDK and a tool list (`get_node`, `find_paths`, `list_intents`) | Standalone `mvp/mcp-server.js` exposing those three tools; share the analyzer + storage libs |
| 32 | Monorepo package selector | not started | Needs workspace detection (overlaps with #2) | Add a workspaces sidebar to the Dashboard tab; checkbox per package; analyzer runs scoped to the checked set |
| 33 | Local IR cache | not started | Quick performance win, low risk | Cache `(repo, ref)` → IR JSON in `mvp/.ryngo/cache/` keyed on commit SHA; `/api/analyze` checks the cache first |
| 35 | Per-node comments (team) | partial | Single-author annotations exist; threaded multi-author comments don't | Reuse `.ryngo/annotations.md` storage; switch the modal to a thread view |
| 36 | Slack/Linear/Jira webhooks | not started | Needs outbound webhook config + secret storage | Add `.ryngo/integrations.json`; fire on diff with `severity > threshold` |

## Phase 4 (Frontend overhaul) — partial

| Iter | Feature | Status | Why deferred | Next step |
|---|---|---|---|---|
| 4.1.1 | Light-mode polish (form input bg, swatches, edge color, logo) | not started | Visible in screenshot; tracked in plan §4.1.1 | ~70 line change; mostly `mvp/src/styles.css` palette refactor + `App.jsx` `edgeStyle` theme awareness |
| 4.2b | ComfyUI-style custom node components per kind | not started | Needs Phase 5.2 typed-port data (now landed); next iteration | Create `mvp/src/components/nodes/{File,Function,Class,Cell,Package}Node.jsx`, register with React Flow `nodeTypes` |
| 4.2c | Typed-pipe edge coloring | not started | Same — needs custom edges that read `valueType` | `mvp/src/lib/type-color.js`; update `edgeStyle()` to honor `e.valueType` (now populated for many edges by Phase 5) |
| 4.3  | Keyboard shortcuts + `?` overlay | not started | Pure polish | `mvp/src/components/HelpOverlay.jsx`; route `Cmd+K`, `?`, `g d`, etc. through a single dispatcher in App.jsx |

## Phase 5 (Universal compiler) — partial

Phase 5.1 + 5.2 + 5.3 + 5.6 + 5.7 shipped: parser registry, TS/Python
type extraction (params, returnType, class members), adapter framework
with 5 P0 adapters (express, fastapi, nextjs, prisma, env), 5 LLM
projection functions (compactJson / englishSignature / topology /
slice / prd), and effect propagation. Stubs in place for Go, Rust,
Java, Ruby, C#, C/C++, Kotlin, Swift — they emit
`BackendUnavailable`-style diagnostics instead of crashing.

| Iter | Feature | Status | Why deferred | Next step |
|---|---|---|---|---|
| 5.1 (real) | Tree-sitter swap-in for TS / Python | not started — regex floor still in use | tree-sitter needs WASM grammars bundled; current regex-based parsers cover 90% with zero install cost | bundle `web-tree-sitter` + grammar wasms; replace `parsers/ts.js` + `parsers/py.js` while keeping the same ParsedFile shape |
| 5.4 | Go via `go list -deps -json` | stub only | needs Go toolchain on the host | `parsers/go-list.js` shells out to `go list` when present, otherwise emits the existing `BackendUnavailable` diagnostic |
| 5.5 | Rust via `rust-analyzer scip` | stub only | needs `rust-analyzer` installed | `parsers/scip-rust.js` — read SCIP index file format (proto3) and translate to ParsedFile |
| 5.8 | Java / Ruby / C# / C / C++ | stubs only | each requires its own external indexer | iterate per language: `scip-java`, `scip-csharp`, `scip-clang`; Ruby gets tree-sitter + Sorbet upgrade |
| 5.3+| More adapters (Terraform, SQLAlchemy, Django, Spring, Rails, GraphQL) | not started | P0 set already lands the demo value | follow the same adapter contract; each is ~80–150 lines |
| 5.6+| MCP server reusing `projection-llm.slice` for `get_subgraph` | not started — projections shipped, MCP server not | separate process, additional dep | `mvp/mcp-server.js`; tools `get_node`, `find_paths`, `list_intents`, `get_topology` |

## Phase 1 features that are intentionally OUT of v1 scope

These were called out in the plan as parking-lot candidates. Not blocked
on anything in particular — they're just not on the user's stated
critical path.

5, 8, 10, 12, 13, 16, 27, 28, 29, 30, 31, 34
(churn heatmap; static export; subscribe; time-travel scrubber;
side-by-side diff; touched-files focus; symbol-tier drill;
sequence/flow view; type-flow viz; coverage overlay; GitHub blame link;
streaming partial render).

See the approved plan for full descriptions.
