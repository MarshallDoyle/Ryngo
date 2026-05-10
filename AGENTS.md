# AGENTS.md

This file is read by both **Claude Code** and **OpenAI Codex** when
they start work on this repo. Keep it short, accurate, and current.
If a workstream changes hands, update the table.

> **AGENTS.md is canonical.** When the table here disagrees with a
> sub-agent's prompt, this file wins.

---

## What Ryngo is

> "The map your coding agent is missing." Paste a GitHub URL, get a
> typed node-editor of the codebase. Annotations / intents / regions
> live in `.ryngo/` so any AI agent — Claude, Codex, Cursor, Aider,
> custom — reads the same map.

Mission: [`mvp/missionStatement.md`](mvp/missionStatement.md). Don't
soften the tone in edits.

## Where to start

| If you want to … | Read |
|---|---|
| understand the architecture | [`mvp/lib/analyze.js`](mvp/lib/analyze.js) — Tier-0→3 pipeline |
| add a parser | [`mvp/lib/parsers/index.js`](mvp/lib/parsers/index.js) registry |
| add a framework adapter | [`mvp/lib/adapters/index.js`](mvp/lib/adapters/index.js) + an existing adapter as template |
| change LLM-facing output | [`mvp/lib/projection-llm.js`](mvp/lib/projection-llm.js) |
| connect Claude/Codex/ChatGPT to the node viewer | [`mvp/docs/AGENT_VIEWER.md`](mvp/docs/AGENT_VIEWER.md) |
| change the UI | [`mvp/src/App.jsx`](mvp/src/App.jsx) + [`mvp/src/components/nodes/`](mvp/src/components/nodes/) |
| measure compiler progress | [`mvp/test/SCOPE.md`](mvp/test/SCOPE.md) |
| understand priorities | the master plan (see "Source of truth" below) |
| deploy | [`mvp/docs/HOSTING.md`](mvp/docs/HOSTING.md) |
| build the marketing landing page | [`mvp/docs/LANDING.md`](mvp/docs/LANDING.md) |
| add usage / compiler-quality data capture | [`mvp/docs/DATA_WAREHOUSE.md`](mvp/docs/DATA_WAREHOUSE.md) |

## Source of truth for priorities

The active plan lives at
`/Users/marshalldoyle/.claude/plans/i-want-you-to-quiet-shamir.md`.
**That file is canonical for what ships next.** When picking a task,
re-read the relevant Phase section before opening files.

When `Codex` works in the cloud (no access to that absolute path),
ship the same content to `mvp/docs/PLAN.md` so both agents see the
same priority list. Owner of mirroring: whichever agent updates the
plan first.

---

## Active workstreams (2026-05-09)

| Workstream | Owner | Status | Files in flight |
|---|---|---|---|
| Phase 4.3 — keyboard shortcuts + `?` overlay | claude | shipped | `mvp/src/components/HelpOverlay.jsx`, `mvp/src/App.jsx` |
| Phase 4.5 — landing page (`ryngo.ai/`) with embedded demo + walkthrough | unclaimed | planning | `mvp/landing/*` (new), `mvp/scripts/build-demo-irs.js` (new), `mvp/server.js`, `mvp/vite.config.js` |
| Ryngo design system / brand pass | codex | in progress | `mvp/src/styles.css`, `mvp/landing/landing.css`, `mvp/landing/logos.html`, possibly a new `mvp/src/lib/tokens.js` |
| Public API docs + OpenAPI spec | unclaimed | not started | `mvp/docs/API.md` (new), `mvp/openapi.yaml` (new) |
| Phase 5.1 (real) — tree-sitter swap | unclaimed | not started | `mvp/lib/parsers/ts.js`, `mvp/lib/parsers/py.js` (heavy) |
| Phase 5.4 — Go via `go list` | unclaimed | not started | `mvp/lib/parsers/go-list.js` (new) |
| Phase 6.2 — anomaly badges | claude | shipped | `mvp/test/anomaly.js`, `mvp/scripts/corpus-run.js` |
| Phase 6.3 — per-repo `expects` | claude | shipped | `mvp/test/corpus.js`, `mvp/scripts/corpus-run.js` |
| Phase 6.4 — PR-blocking corpus check | claude | shipped | `.github/workflows/corpus.yml` |
| Phase 7 — hosting (Cloud Run + GH Actions) | unclaimed | not started | `mvp/Dockerfile` (new), `.github/workflows/deploy-*.yml` (new) |
| Phase 9 — usage database + compiler-quality warehouse | codex | in progress | `mvp/docs/DATA_WAREHOUSE.md`, `mvp/lib/events.js`, `mvp/scripts/events-smoke.js` |
| Agent viewer MCP/App contract | codex | in progress | `mvp/lib/view-model.js`, `mvp/lib/mcp.js`, `mvp/server.js`, `mvp/src/App.jsx` |
| Adapter framework expansion: Django ✓ shipped | claude | shipped | `mvp/lib/adapters/django.js` |
| Adapter framework expansion: GraphQL ✓ shipped | claude | shipped | `mvp/lib/adapters/graphql.js` |
| Adapter framework expansion: Rails ✓ shipped | claude | shipped | `mvp/lib/adapters/rails.js` |
| Adapter framework expansion: Spring ✓ shipped | claude | shipped | `mvp/lib/adapters/spring.js` |
| Adapter framework expansion: SQLAlchemy ✓ shipped | claude | shipped | `mvp/lib/adapters/sqlalchemy.js` |
| Adapter framework expansion: Terraform ✓ shipped | claude | shipped | `mvp/lib/adapters/terraform.js` |
| Landing logo lab — 30 SVG mark candidates | codex | shipped | `mvp/landing/logos.html` |
| Landing eval plan | codex | shipped | `mvp/docs/EVALS.md` |
| Token-efficiency benchmark — implementing the EVALS.md plan | claude | in progress | `mvp/scripts/eval-tokens.js` (new), `mvp/test/results/tokens-*.{json,md}` (new). **Stays out of `mvp/landing/index.html` / `mvp/src/App.jsx` / `mvp/src/styles.css` — Codex owns those.** When tokens-latest.json lands, Codex wires it into the `#evals` UI. |
| Landing measured eval UI — consume token benchmark artifact | codex | claimed | `mvp/landing/index.html`, `mvp/landing/landing.css`, static token summary JSON once Claude lands `tokens-latest.json` |
| Landing "How to plug Ryngo.md into your agent" section | claude | spec'd, codex to implement | `mvp/docs/LANDING_RYNGO_MD.md` (claude, done) → `mvp/landing/index.html` + `mvp/landing/landing.css` (codex). Drop-in HTML + CSS in the spec; ~70 lines net. |
| Backend — `GET /api/ryngo-md?format=raw` for download flow | claude | not started | `mvp/server.js` — ~10 lines so card 3 of the section above has a working URL |

To **claim** a workstream: edit this table, change `unclaimed` to your
agent name, commit. Use `claude/<workstream-slug>` or `codex/<slug>` as
your branch name. To **release**: push final PR to main, set status to
`shipped`, leave the row in place for two weeks then delete.

## Hand-off / collaboration protocol

### Branches

- `main` is the source of truth. Never commit directly.
- Each agent works on its own branch: `claude/<slug>` or `codex/<slug>`.
- Open a draft PR as soon as you start. The draft acts as a soft lock —
  the other agent sees the branch in flight.
- When ready, mark "ready for review" and merge.

### File-level locking

Within a branch you can touch any file. Across branches, a *soft*
lock is enforced by:

1. The "Files in flight" column in the table above.
2. Conventional commit messages name files: `wip(parsers/ts.js): ...`.
3. If both agents need the same file, the one who started later
   rebases on the first agent's branch. No exceptions.

This is optimistic locking, not pessimistic. The corpus harness +
typecheck catches conflicts on merge.

### Regression gate

**Before merging any branch to `main`:**

```bash
cd mvp
npm run corpus
```

Expected:
- All 51 repos pass.
- No classification has dropped >5% from the most recent main run
  unless your PR description includes a `Corpus-Allow-Regression:
  <classification-ids>` line explaining why.
- The build is clean: `npx vite build` returns 0.

If your change is purely visual / non-parser, deltas should be 0.
Non-zero deltas on a non-parser change is a bug — investigate.

### Conventional commits

Format:
```
<type>(<area>): <subject>

<optional body>

Co-Authored-By: <agent> <email>
```

`<type>` ∈ {`feat`, `fix`, `refactor`, `docs`, `test`, `chore`,
`wip`}. Use `wip` only on draft PRs; collapse before merging.

Trailing co-author line — Claude commits use the
`Claude Opus 4.7 (1M context) <noreply@anthropic.com>` line; Codex
commits use whatever Codex's own convention emits.

---

## Code conventions

- **No premature abstractions.** Three similar lines is better than
  a half-finished helper.
- **No comments explaining what code does.** Only `WHY` comments —
  hidden constraints, surprising invariants, references to specific
  bug reports.
- **No backwards-compat shims.** This is an MVP; we move forward.
- **No emojis in code or commits** unless the user explicitly asks.
- **Every new public function must have a one-line JSDoc** describing
  its single responsibility. Anything past that is too long.
- **Style:** ESM modules, no semicolons-in-strict-mode, double-quote
  strings, 2-space indent. The existing files are the reference.
- **Tests live in `mvp/test/` or `mvp/scripts/smoke.js`.** No new test
  framework — Node's built-in `assert` is enough.

## Don't-touch zones

These files are load-bearing for the active demo. Touch only with
explicit owner approval:

- `mvp/missionStatement.md` — verbatim brand copy. Only edit on
  user direction.
- `mvp/test/results/` — runner output. Don't manually edit.
- `mvp/.ryngo/` — annotation/intent state. Don't manually edit.
- The dev server config in `mvp/vite.config.js` — fragile around
  proxy settings.

## "Don't add this" list (rejected ideas)

| Idea | Why not |
|---|---|
| Lasso → name a region | Dropped 2026-05-09 — not on critical path |
| Run an LLM server-side | Mission statement: "we are not a coding agent" |
| TypeScript port of the analyzer | Adds tooling cost without value — JS is fine |
| New test framework (Vitest / Jest) | Node's `assert` + smoke + corpus is sufficient |
| Dark mode as the default | User picked light by name |
| Replacing React Flow | Too much sunk in existing custom node components |

---

## Quick reference: running things

```bash
cd mvp
npm install                     # one-time
npm run dev                     # dev server (api on 3000, web on 5173)
npm run smoke                   # one-repo health check
npm run corpus                  # 51-repo benchmark (~70 s)
npm run corpus:watch            # corpus loop every 30 min
npm run mcp                     # MCP stdio server (for Claude Code / ChatGPT)
npm run db:up                   # local Postgres container + named volume
npm run db:down                 # stop local Postgres, keep volume
npx vite build                  # production build of the SPA
```

## Activity log convention

When you ship something, append a single line to
[`mvp/CHANGELOG.md`](mvp/CHANGELOG.md):

```
2026-05-09  claude  Phase 6.1 — Express adapter false-positive cleanup (-494 fake routes)
2026-05-09  codex   Phase 5.4 — Go backend via `go list` subprocess
```

Date · agent · one sentence. Newest at top. The corpus harness
already records measurable deltas; this just adds human-readable
context.

---

## When the agents disagree

If Claude says "ship X" and Codex says "ship Y" and the user is
ambiguous: **ship whichever is smaller and more reversible first.**
Convergence over correctness. We can always undo a small change.

If both have been working on the same file in parallel and both
diffs need to land: the agent merging in second is responsible for
running the corpus harness on the merged branch and confirming no
classification regressed by more than 5%.
