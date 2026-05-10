# Roadmap

This is the public roadmap for codegraph. Dates are intentionally absent — milestones ship when they're ready and the previous one has cooked in real codebases. PRs and issues that pull a milestone forward are welcome.

**Legend.** Complexity is rough engineering effort, not calendar time:
- **S** — small, days
- **M** — medium, 1–2 weeks
- **L** — large, multiple weeks
- **XL** — multi-month, often a sub-project of its own

---

## v0.1 — MVP (dogfood-ready)

**Goal.** A single contributor on a TypeScript + Express + Prisma service can `codegraph index && codegraph serve` and get a useful map of their system. No diff yet — that lands in v0.3 once the IR has stabilized.

**Scope.**
- TypeScript indexing via SCIP (`scip-typescript`).
- Graph IR v1 — nodes (`service` / `module` / `function` / `type`), edges (`calls`, `imports`, `imports-type`).
- Express adapter — lifts `app.METHOD('/path', handler)` into `http-route` edges with method, path, and handler binding.
- Prisma adapter — lifts `prisma.<model>.<op>(...)` into `db-query` edges with model and operation kind.
- CLI: `codegraph index` (writes `.codegraph/graph.json`), `codegraph serve` (boots the viewer on `localhost:4747`).
- Viewer: React Flow canvas, three tiers (service / module / function), tier collapse/expand, click-through navigation, search by symbol name.
- Configuration via `.codegraph.yml` (include/exclude, adapter list, tier matchers).

**Out of scope (deferred).** Diff engine. PR comment. Effect classification. Any non-TypeScript language. Any non-Express/Prisma adapter.

**Complexity.** L. Most of the cost is the IR design — getting it right means v0.2+ are plug-in work.

**Dependencies.** None outside SCIP and React Flow.

**Why first.** Everything else assumes a stable IR and a working viewer. Shipping diff before the IR has been stress-tested would force breaking changes through the action surface — expensive once users depend on it. TypeScript / Express / Prisma is the highest-density target stack in the OSS world, which maximises early dogfooding.

**Definition of done.** A maintainer can run codegraph against their own production TS service, find at least one architectural surprise, and not throw the tool away.

---

## v0.2 — Python parity, env vars, dead code

**Goal.** Cover the second-most-common backend stack (Python) and ship two reports that pay back the install in the first session.

**Scope.**
- Python indexing via SCIP (`scip-python`).
- FastAPI adapter — `@app.get`, `APIRouter`, dependency-injection edges.
- SQLAlchemy adapter — ORM-call → `db-query` edges, including session-scope tracking.
- Env-var detection — every `process.env.X` / `os.environ['X']` lifted as a `config` node, edges from consumers. Cross-language because env is the universal contract.
- Dead-code report — unreachable nodes from declared entry points (HTTP routes, exported package APIs, scripts in `package.json` / `pyproject.toml`).

**Complexity.** M. SCIP carries most of the language work; Python adapters mirror v0.1 patterns.

**Dependencies.** v0.1 IR must be stable. Adapter SDK contract (informal at this stage) needs to hold across two languages — proves it generalizes.

**Why ordered here.** Validating the IR across two languages before adding diff (v0.3) catches schema bugs while only one consumer (the viewer) depends on it. Env-var and dead-code reports are also the highest-ROI features that don't need diff to be valuable — they ship as standalone CLI subcommands.

---

## v0.3 — Graph diff, GitHub Action, PR comment

**Goal.** Codegraph becomes a review tool, not just an exploration tool. Every PR carries an architectural delta.

**Scope.**
- Graph diff algorithm — symmetric node/edge diff with stable IDs across runs (the hard part), edge-kind-aware change detection (e.g. `db-query` model rename ≠ a delete + add).
- `codegraph diff <base> <head>` CLI subcommand emitting JSON + a summary.
- GitHub Action `codegraph/action@v1` — checks out base + head, runs index on both, posts a PR comment.
- PR comment renderer — collapsed-by-default markdown with summary counts, top-N changed nodes, and a link to a viewer URL that highlights the diff.
- Viewer diff mode — added (green) / removed (red) / changed (yellow) overlays, "show only changes" filter.
- Cycle and orphan detection as `--fail-on` triggers.

**Complexity.** L. Stable IDs across refactors (file renames, function moves) are the genuinely hard problem; everything else is plumbing.

**Dependencies.** v0.1 IR (locked) and v0.2 adapter SDK (proven across two languages). Stable IDs require the IR to expose a content-addressable identity scheme that survives renames — designing this earlier would have been speculative.

**Why ordered here.** Diff is the core differentiator vs. existing tools, but it has to ride on a stable IR. Shipping it third (not first) trades the marketing splash for a diff engine that doesn't break every minor release.

---

## v0.4 — Effect coloring, complexity, type flow, more frameworks

**Goal.** Move from "what's connected" to "what's risky." Add the analyses that justify staring at the graph.

**Scope.**
- Pure-vs-effectful classification — propagate effect sets (`io`, `network`, `db`, `mutation`) up the call graph from declared roots, render as node color.
- Cyclomatic / cognitive complexity overlay — heatmap on functions.
- Type-flow filtering — given a type `T`, highlight every edge that carries `T` (or a `T`-shaped subset).
- Next.js adapter — App Router and Pages Router routes, server actions, server components.
- Drizzle adapter — query → `db-query` lift parallel to Prisma.

**Complexity.** L. Effect propagation is the tricky one — needs sound conservative analysis without flooding everything as "effectful."

**Dependencies.** v0.3 PR comment surface — these analyses become deltas in PR comments ("this PR makes 4 previously-pure functions effectful"), which is where they're most valuable.

**Why ordered here.** Effect coloring is the marquee analytical feature, but it's only useful once the diff surface exists to call out regressions. Doing it earlier would have produced a static heatmap with no review-time payoff.

---

## v0.5 — Go, Rust, IaC, polished incremental

**Goal.** Cover the rest of the modern backend stack and make re-indexing fast enough that codegraph runs on every save.

**Scope.**
- Go indexing via SCIP (`scip-go`).
- Go adapters — `net/http`, `chi`, `gin`; `sqlc`, `GORM`.
- Rust indexing via SCIP (`scip-rust` / `rust-analyzer`).
- Rust adapters — Axum, sqlx, Diesel.
- Terraform adapter — resource graph lifted as `infra` nodes, edges to consumer services via tags / naming convention.
- Incremental analysis hardened — file-level cache invalidation across SCIP + adapter layers, sub-second re-index for single-file changes on 50k-LOC repos.
- Watch mode — `codegraph serve --watch` re-indexes on save and pushes to the viewer.

**Complexity.** XL — four languages and an IaC dimension is genuinely a lot, and incremental analysis is its own engineering problem.

**Dependencies.** Adapter SDK from v0.4 must be solid (informal contract becomes formal here in prep for v1.0). Effect classification from v0.4 needs to generalize across Go and Rust ownership/borrowing semantics.

**Why ordered here.** Go and Rust users tend to demand more from static analysis tools (they already have great LSP-driven UX), so codegraph needs effect coloring and complexity overlay to be table stakes before showing up in those communities. Watching incremental land last avoids re-architecting it twice as the language list grows.

---

## v1.0 — SDK, third-party adapters, scale

**Goal.** Stop being a single-team project. Make it credible for a regulated enterprise to standardize on codegraph.

**Scope.**
- First-party adapter SDK — published as `@codegraph/adapter-sdk` with a stable API, semver guarantees, generators (`codegraph adapter init my-framework`), and a test harness.
- Third-party adapter discovery — `.codegraph.yml` can reference npm packages (`adapters: ['@acme/codegraph-myorm']`); registry of community adapters.
- Documentation site (Astro / Starlight) — replaces the README-as-docs model with searchable, versioned docs.
- Performance benchmarks — published numbers at 10k / 50k / 100k+ files, with a regression CI gate.
- Packaging hardening — single static binary distribution alongside npm, signed releases, SBOM.
- Stability guarantees — graph IR schema, CLI flags, and SDK API all under semver.

**Complexity.** L. Most pieces are individually small but each demands the polish a 1.0 deserves.

**Dependencies.** All prior milestones. The adapter SDK can only go stable once it's been pressure-tested across TS / Python / Go / Rust + IaC (v0.5).

**Why ordered here.** Calling something 1.0 implies you'll support its surfaces. Doing it before five language stacks have shaken out the SDK design would mean breaking changes early in the 1.x line — exactly what 1.0 promises not to do.

---

## Post-v1.0 wishlist

Not committed; each is a research bet that may or may not pay out.

- **Runtime trace ingest.** Optionally enrich the static graph with sampled OpenTelemetry traces — unobserved-but-static edges turn gray, observed edges show throughput. Static remains the source of truth; runtime is annotation.
- **History / temporal view.** Replay the graph over time. Watch how a service split apart commit-by-commit, or animate a six-month drift in module coupling. Powered by indexing every Nth commit on `main`.
- **Hosted enterprise.** SaaS deployment for orgs that don't want to run their own CI infra — RBAC, SSO, multi-repo cross-graph, audit logs. Strictly opt-in, never the default. Core stays MIT and self-hostable forever.
- **IDE plugin.** VS Code / JetBrains panel showing the codegraph viewer pinned to the symbol under cursor.
- **LLM-assisted exploration.** A `codegraph ask` that uses the graph IR (not the source) as grounding. Distinct from the no-LLM core — shipped as a separate optional package so the base tool stays deterministic and audit-friendly.

---

## How decisions get made

- Milestones move from wishlist → committed when there's both a maintainer who wants to own them and a real user blocked on them.
- Adapters are first-class issues, not internal work. If you need an adapter, file an issue; if you write one, expect a fast review.
- Breaking changes to the graph IR happen only at major versions after v1.0. Pre-1.0, expect occasional breakage with a migration note in `CHANGELOG.md`.

Questions, pushback, or "you're solving the wrong problem next" — file an issue or drop into Discord. Roadmap discussions are public.
