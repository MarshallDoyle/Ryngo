# Framework Adapters

Adapters are the part of codegraph that turns framework-specific code patterns
into a normalized IR (intermediate representation) of routes, handlers, and
cross-stack edges. They are deterministic and AST-based — no LLM, no
heuristics that could vary between runs.

The orchestrator runs adapters in three phases:

1. **`detect(repo)`** — cheap, manifest-only check ("does this repo use my
   framework?"). Should not parse source.
2. **`analyzeFile(file, ctx)`** — per-file AST walk. Emits IR nodes
   (routes, pages, server actions, client calls, ...) and edges (route ->
   handler, page -> component, ...). Runs in parallel across files.
3. **`resolveCrossFile(allOutputs, ctx)`** — single global pass that joins
   information that wasn't available file-locally: router prefix
   composition, mount points, frontend-fetch -> backend-route matching, etc.

The `Adapter` interface lives in `@codegraph/adapter-sdk`; IR types live in
`@codegraph/ir`.

## Reference adapters

| Adapter | File | What it shows |
|---|---|---|
| Express | [`express.ts`](./express.ts) | Method-call route registration (`app.get(...)`), `Router` sub-mounting via `app.use('/prefix', router)`, last-arg handler resolution. |
| FastAPI | [`fastapi.ts`](./fastapi.ts) | Decorator-based routes (`@app.get(...)`), `APIRouter` prefix composition + `include_router`, Pydantic body/response model resolution, path/query/body parameter classification. |
| Next.js App Router | [`nextjs.ts`](./nextjs.ts) | File-path-as-route, `GET`/`POST` exports as method handlers, `page.tsx` page-routes, `'use server'` actions, `fetch()` -> route matching across adapters. |

All three emit `frontend-fetch -> backend-route` edges in their cross-file
pass when matchable URLs are found in the same repo. The Next.js adapter
additionally emits `action-call` edges from client components to server
actions they import.

## Edge "type info"

Edges carry framework-extracted metadata in their `attrs` field, mirroring
the route node's fields:

```ts
edge.attrs = {
  method: "POST",
  path: "/users/:id",
  params: [...],
  requestBody: { kind: "object", fields: [...] },
  responseType: { kind: "ref", name: "User" },
};
```

This is duplicated on the edge so downstream consumers (graph viewers,
docs generators) don't need to dereference the route node every time.

## Writing a 4th adapter

Use this checklist. The three reference adapters all follow it.

### 1. Detection
- [ ] `detect(repo)` reads ONLY manifest files (`package.json`,
      `requirements.txt`, `pyproject.toml`, `go.mod`, ...). Never scan source.
- [ ] Returns `false` quickly for irrelevant repos.
- [ ] If your framework can be confused with another, also gate on a
      cheap secondary signal (a directory existing, a config file present).

### 2. Per-file analysis
- [ ] Bail at the top of `analyzeFile` when the file extension obviously
      can't contain your framework's code (e.g. `.py` for Express).
- [ ] Walk the AST once. Use the SDK's normalized visitor — don't reach
      for raw parser internals.
- [ ] Track binding state in a per-file `state` object; flatten into
      `AdapterOutput` at the end.
- [ ] Emit a route node for every endpoint with: `method`, `path`,
      `framework`, `file`, `loc`. Path may be partial — full composition
      is the cross-file pass's job.
- [ ] Emit a `route-handler` edge from the route to the handler symbol.
      Use `file.symbolFor(node)` for declared functions and
      `file.synthesizeAnonSymbol(node, ...)` for inline arrow functions.
- [ ] Pull `params`, `requestBody`, `responseType` from type info when
      available. Never guess. If the SDK's type service returns
      `undefined`, leave the field undefined.
- [ ] If your framework has a routing concept like Express's `Router` or
      FastAPI's `APIRouter`, record mount points / prefix info in
      `output.private` to be consumed by `resolveCrossFile`.
- [ ] If your framework's clients make HTTP calls in the same language,
      ALSO emit `client-call` nodes for them — other adapters (and yours)
      use them in their cross-file pass.

### 3. Cross-file resolution
- [ ] Compose any prefixes / mounts you stashed in `private` so each
      route ends up with its full path.
- [ ] Emit ALL fan-outs: a router mounted at two prefixes produces two
      route nodes (one per full path).
- [ ] Mark unreachable routes (defined but never mounted) with
      `orphan: true` rather than dropping them — downstream tools may
      want to flag them.
- [ ] Walk `ctx.collectNodes("client-call")` and emit
      `frontend-fetch -> backend-route` edges for matchable URLs. Use
      both exact match and parameterized-path regex match. Always check
      method as well as path.

### 4. Determinism
- [ ] Same input -> identical output, including node IDs, on every run.
      Use `file.makeNodeId(kind, key)` for stable IDs derived from the
      route's intrinsic identity (method + path), not from iteration order.
- [ ] No `Date.now()`, no unsorted `Map` iteration leaking into IDs, no
      filesystem-walk order leaking into output ordering.

### 5. Tests
- [ ] At least one fixture per pattern: simple route, parameterized
      route, sub-mounted/prefixed route, typed body, typed response,
      orphan route.
- [ ] One fixture exercising frontend-fetch -> backend-route matching
      end-to-end.
- [ ] Snapshot the IR output. Diffs in snapshots are the easiest way to
      catch regressions.

### 6. Things to deliberately NOT do
- Don't infer routes from comments, README content, or string heuristics
  that aren't grounded in framework semantics. Adapters must be sound.
- Don't follow runtime-dynamic patterns. If a path comes from a
  template literal with non-constant interpolations, skip it (or emit
  with a `dynamic: true` flag); never fabricate a path.
- Don't import the framework you're analyzing. Adapters work on AST
  shapes, not runtime types.
