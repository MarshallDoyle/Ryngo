# codegraph Framework Adapter Interface

Status: draft v0.1
Audience: adapter authors, codegraph core maintainers
Companion file: [`adapter-interface.ts`](./adapter-interface.ts)

---

## 1. Purpose & rationale

codegraph compiles a repository into a typed graph IR (nodes + edges + provenance) that a React Flow viewer renders. The language indexers (TypeScript, Python, Go, etc.) produce a baseline IR — files, modules, declarations, references, calls, imports — using SCIP / tree-sitter output. They are deliberately **framework-agnostic**: they do not understand that `app.get('/users', handler)` registers an HTTP route, or that a `prisma.user.findMany()` call is rooted in `schema.prisma`.

A **framework adapter** is the unit of pluggable, framework-specific knowledge. It takes the host's parsed-and-indexed view of the repo and emits *additional* IR nodes and edges, plus diagnostics. Adapters are how codegraph stays a deterministic, no-LLM tool while still surfacing semantically meaningful structure (HTTP routes, ORM models, IaC resources, message-bus topics, RPC services, GraphQL schemas, etc.).

### Design goals

1. **Determinism.** Same inputs → byte-identical IR. No network, no time-of-day, no LLMs. This is the entire product promise; adapters must not break it.
2. **Composability.** A repo typically uses several frameworks; adapters must layer cleanly. A FastAPI adapter and a Pydantic adapter must coexist without conflicts. An OpenAPI-client adapter must be able to consume a FastAPI adapter's output.
3. **Stable IDs.** Edges from one adapter's output must be referenceable by another adapter. IDs must be stable across runs and across small unrelated edits elsewhere in the repo.
4. **Provenance everywhere.** Every node and edge carries the source file + byte/line range that produced it. The viewer needs this for click-to-source; users need it to trust the graph.
5. **Bounded blast radius.** A buggy adapter must not corrupt unrelated parts of the IR, hang the build, or read arbitrary files. Failures degrade gracefully into diagnostics.
6. **Cheap to write.** Most adapters should be a few hundred lines. The interface is small; helpers live in `@codegraph/adapter-sdk`.

### Non-goals

- Adapters do **not** parse source code from scratch. They consume the host's parsed AST + symbol index. (Exception: a framework like Terraform or Prisma that uses its own non-host language ships its own parser; see §6.4.)
- Adapters do **not** mutate other adapters' output. Cross-adapter consumption is read-only.
- Adapters do **not** schedule themselves. The host's pipeline driver computes execution order from declared dependencies.

---

## 2. Concepts

### 2.1 IR fragment
The unit of adapter output. A fragment is a set of `IrNode`s and `IrEdge`s with provenance. The host merges fragments from all adapters into the global IR, deduplicating by stable ID.

### 2.2 Stable ID
A content-addressed string of the form `scheme:adapter@version:path#local-id`. Examples:
- `cg:fs:/src/api/users.ts#L42-L57` — file-relative span (host-provided).
- `cg:fastapi@1:/api/main.py#route::GET:/users` — adapter-namespaced.
- `cg:typescript:symbol::abc123` — symbol from the language indexer.

Adapter authors mint IDs via `ctx.id.mint(...)` so that the host can apply collision detection and namespace enforcement. An adapter cannot mint an ID outside its own `scheme`.

### 2.3 Phases
The host runs adapters in fixed phases so that ordering between unrelated adapters is well-defined:

1. **detect** — quick pass to determine whether the adapter applies to this repo. No IR emitted.
2. **analyzeFile** — per-file pass; runs in parallel across files. Emits IR fragments local to one file.
3. **resolve** — global pass; runs once per adapter after every adapter has finished `analyzeFile`. This is where cross-file edges are resolved (e.g. matching `fetch('/api/users')` to `@app.get('/users')`).
4. **finalize** — last chance to emit summary nodes (counts, schema-level nodes) and downgrade unresolved edges into diagnostics.

Within each phase, the host topologically orders adapters by their declared dependencies (§3.4).

### 2.4 Provenance
Every `IrNode` and `IrEdge` carries `provenance: { file, range, adapter, version }`. The viewer uses this for click-to-source; the audit log uses it to attribute graph contents back to a specific adapter version. There is no anonymous IR.

### 2.5 Diagnostics
Adapters report problems via `ctx.diagnostic({...})`. Diagnostics are first-class output of a codegraph run — surfaced in CLI output, the viewer's "Issues" panel, and the GitHub Action annotation stream. Categories:

- `info` — informational (e.g. "detected 14 routes").
- `warn` — soft failure (e.g. "could not resolve route handler; emitting unresolved-edge marker").
- `error` — hard failure for this adapter; IR for this adapter is dropped, but the run continues.
- `unresolved-edge` — a structured warning that creates a placeholder edge node so the viewer can show "incoming HTTP request from unknown caller" rather than silently omitting the edge.

---

## 3. Lifecycle

### 3.1 Registration
An adapter package exports a default `Adapter` object. The host loads adapters specified in `codegraph.config.{ts,json}`:

```ts
// codegraph.config.ts
import fastapi from "@codegraph/adapter-fastapi";
import openapiClient from "@codegraph/adapter-openapi-client";

export default {
  adapters: [fastapi(), openapiClient()],
};
```

Adapters are pure factory functions: calling the factory returns the `Adapter` descriptor. No I/O at registration time.

### 3.2 Detect
Once per run, the host calls `adapter.detect(detectCtx)`. Detect must be cheap (target: <50ms for a 100k-file repo). Typical detect strategies:

- Check for a marker file (`prisma/schema.prisma`, `next.config.js`, `pyproject.toml` with a key, `Pipfile`).
- Check `package.json` / `pyproject.toml` / `go.mod` for a dependency.
- Run a glob and look at counts.

Detect returns `{ active: true, evidence: [...] }` or `{ active: false }`. If inactive, the adapter is skipped entirely; no further phases run for it. Evidence is surfaced in the viewer's "Adapters" panel so users can see *why* an adapter activated.

### 3.3 analyzeFile (per-file)
For every file under analysis, the host calls each active adapter's `analyzeFile(file, ctx)` whose `appliesTo` predicate matches the file. The host parallelizes across files but serializes within a single file when adapters declare an ordering dependency (§3.4).

`analyzeFile` is purely local: it sees the file's AST, symbols, and content. It emits fragments. It must not depend on other files' results — those go in `resolve`.

### 3.4 Dependencies & ordering
Adapters declare dependencies in their descriptor:

```ts
deps: {
  required: ["typescript-indexer@^1"],   // run will fail without these
  optional: ["openapi-spec@^1"],         // consumed if present
  after: ["fastapi@^1"],                 // ordering hint, not data dep
}
```

The host computes a DAG over all active adapters per phase. Cycles are a config error and abort the run. Within a phase, an adapter's `analyzeFile`/`resolve` runs only after all `required` and `after` deps have completed that phase.

### 3.5 resolve (global)
After every adapter finishes `analyzeFile` for every file, each adapter's `resolve(ctx)` runs once. In this phase the adapter has read-only access to:

- its own `analyzeFile` outputs (already merged into the IR);
- the language indexers' symbol/reference index;
- other adapters' outputs *that it declared a dependency on*.

This is the matchmaking phase: a frontend adapter reading `fetch('/api/users')` literals looks up `route::GET:/users` nodes contributed by the FastAPI adapter and emits cross-stack edges.

Cross-adapter access is mediated by `ctx.peers.get(adapterName)`, which returns a typed read-only view. If the dep was not declared, this throws.

### 3.6 finalize
A last single call per adapter. Used for:
- emitting summary nodes (`module::api`, totals);
- converting still-unresolved markers into `unresolved-edge` diagnostics;
- emitting cleanup/cache-bust hints for incremental runs.

### 3.7 Incremental runs
`analyzeFile` outputs are cached keyed by `(adapter@version, file content hash, host inputs hash)`. On a subsequent run the host replays cached fragments for unchanged files and only re-runs changed files. Adapters opt out of caching by setting `cacheable: false` (rare; typically only adapters that read repo-wide state inside `analyzeFile`).

`resolve` is never cached — it always re-runs. Its inputs are small (already-built IR + peer outputs) so this is fine.

---

## 4. Error handling

A failure in one adapter must not corrupt the IR or abort the whole run. Rules:

1. **Throw inside a phase = adapter fails for this run.** The host catches, logs the stack as an `error` diagnostic, drops *all* IR fragments emitted by that adapter in that phase, and continues with other adapters. (Fragments from earlier successful phases are kept; they are valid in isolation.)
2. **Time budget.** Each phase has a per-adapter wall-clock budget (default 30s for `detect`, 5s/file for `analyzeFile`, 60s for `resolve`, 10s for `finalize`). Exceeding the budget aborts that phase for that adapter and emits an `error` diagnostic.
3. **Memory.** The host runs adapters in worker threads with a soft heap cap (default 512MB/worker). On OOM, the adapter is killed and marked failed.
4. **Determinism violations.** The host re-runs `detect` and a sample of `analyzeFile` calls in CI-mode. Output mismatch on identical inputs is treated as a hard error and the adapter is quarantined.
5. **Schema violations.** Every emitted node/edge is validated against the IR schema (Zod). Invalid output → diagnostic + drop the offending fragment, not the whole adapter.
6. **Unresolved references.** Not an error. Emit an `unresolved-edge` placeholder so the graph still has a slot, then a `warn` diagnostic.

The CLI exit code is `0` if the run completes (even with adapter `error` diagnostics), and non-zero only for host-level failures (config invalid, dep cycle, IO error). Adapter authors who want CI to fail on their warnings configure that at the project level, not by throwing.

---

## 5. Sandbox & permissions

Adapters run with a constrained capability set. The host injects all external access through `ctx`; adapters must not import `node:fs`, `node:net`, `node:child_process`, etc. directly.

- **Filesystem:** `ctx.fs` exposes only files the host has decided are in-scope (respects `.gitignore`, `codegraph.config.ignore`, max-file-size limits). Read-only. No write.
- **Network:** denied by default. An adapter that needs network (e.g. to read a remote OpenAPI spec) must declare `permissions: { network: ["openapi.example.com"] }`; the user must allow-list this in `codegraph.config.ts`. Default config disallows all.
- **Subprocess:** denied. Adapters that wrap external CLIs (e.g. `terraform graph`, `prisma format`) must use `ctx.exec(toolName, args)`, which the host gates on `permissions.exec`.
- **Env vars:** `ctx.env` exposes only the keys declared in the adapter's `permissions.env`. No `process.env`.
- **Determinism guards.** `Date.now`, `Math.random`, `crypto.randomUUID` are stubbed inside the worker to deterministic equivalents. Adapters needing real randomness or time must justify it in code review; this is a smell.

The host runs adapters in a Node `worker_threads` worker with the above stubs and a `Permissions`-style proxy on `ctx`. There is no VM-level isolation — the security model is "trusted authors, defensive defaults". Adapters are npm packages and inherit npm's trust model.

---

## 6. Performance contract

codegraph targets sub-minute analysis for ~1M-LoC monorepos on a 2024-class laptop. Adapters share that budget. Targets:

| Phase           | Per-adapter target                          | Hard ceiling           |
|-----------------|---------------------------------------------|------------------------|
| detect          | <50ms                                       | 1s                     |
| analyzeFile     | O(file size); <2ms/KLOC; no global state    | 5s/file                |
| resolve         | <5% of total run time                       | 60s                    |
| finalize        | <100ms                                      | 10s                    |

### 6.1 Streaming output
Adapters emit fragments via `ctx.emit(node)` / `ctx.emit(edge)` rather than returning a big object. The host streams these into the IR builder, keeping peak memory bounded.

### 6.2 No global mutable state
All state lives on `ctx` (or in returned values). The host may run two `analyzeFile` calls for the same adapter on different threads simultaneously; module-level mutable state will cause nondeterministic output.

### 6.3 Caching contract
For `cacheable: true` adapters, `analyzeFile(file, ctx)` must depend only on:
- `file.content`, `file.path`,
- `ctx.symbols` for that file (host-provided; cache key includes its hash),
- adapter version + config.

Reading other files via `ctx.fs.read` inside `analyzeFile` is allowed but every read is added to the cache key — overuse defeats incremental gains. A common pattern is to read globals once in `resolve` instead.

### 6.4 BYO parser
Adapters for non-host languages (e.g. HCL for Terraform, the Prisma schema DSL) ship their own parser. They still implement `analyzeFile`; they just ignore `file.ast` and parse `file.content` themselves. Parser must be:
- pure-JS or WASM (no native deps); the host bundles for multiple OS/arch via the GitHub Action;
- deterministic;
- tested with a fuzz corpus (recommended).

---

## 7. Versioning

### 7.1 Adapter version
Every `Adapter` declares `version: string` (semver). The version is part of:
- node/edge IDs minted by the adapter (so old cached IR can't collide with new IR);
- the cache key (bumping the version invalidates all cached fragments);
- the IR provenance record.

### 7.2 Compatibility with the host
Adapters declare `apiVersion` matching the major of `@codegraph/adapter-sdk` they were built against. The host refuses to load an adapter whose `apiVersion` is outside its supported range.

### 7.3 Compatibility between adapters
Inter-adapter dependencies use semver ranges (`^1.2`). The host resolves them like a package manager; unresolvable constraints are a config error.

### 7.4 Breaking changes
Bumping the major version of an adapter triggers a full re-analysis on next run. Minor/patch bumps reuse cache only if the adapter explicitly declares cache compatibility (`compatWith: ["1.x"]`). Default is conservative: any version change invalidates cache.

### 7.5 Schema migration
The IR schema itself is versioned separately (`irSchemaVersion`). When the host upgrades the schema, every adapter is re-run; there is no automatic in-place migration of cached fragments.

---

## 8. Testing & validation

Adapters in the official monorepo follow a fixture-based test pattern:

- `test-fixtures/<framework>/<case>/` holds an input repo and an expected `ir.json`.
- The test runner runs the adapter against the fixture and diffs IR.
- Diffs in node/edge IDs are treated as breaking and require a version bump.

Determinism is enforced by running each fixture twice and comparing byte-for-byte.

---

## 9. Worked example: cross-stack `fetch` → FastAPI route

Two adapters cooperate to draw an edge from a frontend `fetch('/api/users')` call to a backend `@app.get('/users')` handler:

1. **`fastapi@1` adapter.**
   - `detect`: looks for `fastapi` in `pyproject.toml` deps.
   - `analyzeFile` for `*.py`: walks the AST for `@app.<method>(...)` decorators and `APIRouter` instances. For each, emits an `IrNode` of kind `http.route` with id `cg:fastapi@1:<file>#route::<METHOD>:<path>` and provenance pointing at the decorator.
2. **`http-client@1` adapter.**
   - `detect`: always active when a TS/JS indexer is active.
   - `analyzeFile` for `*.{ts,tsx,js,jsx}`: finds `fetch(...)`, `axios.<method>(...)`, etc., extracts the URL literal if statically resolvable. Emits an `IrNode` of kind `http.client-call` with the literal URL, plus an `IrEdge` of kind `http.calls` whose `to` is a *deferred reference* `{ kind: "match-route", method, path }`.
   - `deps.optional: ["fastapi@^1", "express@^1", ...]`.
3. **`http-client@1.resolve`.**
   - For each deferred `match-route` reference, look up `http.route` nodes in the merged IR (via `ctx.peers.get("fastapi").nodes("http.route")` and similar for other server adapters). Match on `(method, path)` with route-template parameter unification (`/users/:id` ↔ `/users/${id}`).
   - On match: emit a real `IrEdge` with the resolved `to`.
   - On miss: emit an `unresolved-edge` placeholder + `warn` diagnostic ("HTTP client call to GET /users has no matching server route").
4. **finalize.** `http-client@1` emits a summary node `module::http-clients` with the count of resolved/unresolved calls.

The viewer renders both kinds of edges (resolved + placeholder) so users can immediately see broken links between frontend and backend.

---

## 10. Open questions

- **Multi-language symbol unification.** Today each language indexer owns its symbol IDs. We may need a `cg:symbol` namespace owned by the host so adapters can refer to "this symbol" without knowing which indexer produced it.
- **Watch mode.** Streaming partial graph updates from `analyzeFile` is straightforward; streaming `resolve` updates as new files arrive is harder and not in v1.
- **Adapter discovery from `package.json`.** Should we auto-load adapters that declare a `codegraph` keyword, or require explicit config? Currently leaning explicit.
- **Per-file vs per-symbol granularity.** A few frameworks (e.g. tRPC) would benefit from a "per-symbol" callback rather than per-file. Possible v2 phase.
