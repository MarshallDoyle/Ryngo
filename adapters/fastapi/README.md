# @codegraph/adapter-fastapi

[![npm version](https://img.shields.io/npm/v/@codegraph/adapter-fastapi.svg)](https://www.npmjs.com/package/@codegraph/adapter-fastapi)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](../../LICENSE)

First-party [codegraph](../../README.md) adapter for [FastAPI](https://fastapi.tiangolo.com/). Lifts decorator-based routes, APIRouter prefix composition, and Pydantic body/response models into the typed graph IR.

> codegraph is a deterministic, no-LLM static-analysis tool. This adapter is purely AST-driven; it never executes user code.

## What it produces

| Kind | Type | Meaning |
| --- | --- | --- |
| `http.route` | node | One per `@app.<verb>(...)` / `@router.<verb>(...)` decorator, with composed full path after `resolve` and colon-style placeholders. |
| `http.module` | node | Per-run summary node with `routeCount`, `routerCount`, `appCount`, `orphanCount`. |
| `http.handler` | edge | `route -> handler symbol` (the Python function under the decorator). The same target also lives on `route.data.handlerSymbolId` for direct call-graph joins. |

The `http.*` namespace is shared with [`@codegraph/adapter-express`](../express) and [`@codegraph/adapter-nextjs`](../nextjs): downstream consumers can filter peer outputs by `http.route` and union FastAPI / Express / Next.js routes uniformly. fastapi is a **pure producer** of route nodes; cross-service `http.calls` edges are emitted by the client adapter (nextjs / http-client) — see [Cross-service edge contract](#cross-service-edge-contract).

## What it understands

- **App + APIRouter bindings.** `app = FastAPI()` and `router = APIRouter(prefix="/users")` are tracked at file scope. Multiple apps in one repo are supported.
- **Decorator routes.** `@app.get`, `@app.post`, `@app.put`, `@app.patch`, `@app.delete`, `@app.options`, `@app.head` (and the `router.*` equivalents). Non-literal path arguments are skipped with a `warn` diagnostic (`fastapi/route-path-not-literal`).
- **`include_router(prefix=...)` fixed-point composition.** A router defined in one file and mounted from another (or chained: `app -> r1 -> r2`) is resolved to its full path(s) via a fixed-point BFS over the include graph. A router included from two parents emits two route nodes.
- **Pydantic body / response models.** A function arg whose annotation resolves to a Pydantic model becomes the route's `requestBody`. The decorator's `response_model=` kwarg becomes `responseType`.
- **Path / query / body parameter classification.** Parameters whose names appear in the path template (`{id}`) are tagged `in: "path"`; Pydantic-typed args become the body; everything else is `in: "query"`. `Depends(...)` (including `Annotated[T, Depends(...)]`) is excluded.
- **Status code / tags.** Decorator kwargs `status_code=` and `tags=[...]` are surfaced on the route's `data` payload.
- **Orphan routers.** Routers defined but never mounted from an app are emitted at their declared prefix with `orphan: true` so downstream tooling can flag dead code.

## What it deliberately does NOT do

- Infer routes from comments, README content, or non-AST heuristics.
- Follow runtime-dynamic patterns (paths from f-strings with non-constant interpolations, decorators applied programmatically).
- Import or run FastAPI itself.

## Lifecycle

This adapter implements the full 4-phase contract from [`spec/adapter-interface.ts`](../../spec/adapter-interface.ts):

| Phase | Lives in | What it does |
| --- | --- | --- |
| `detect` | `src/detect.ts` | Scans `pyproject.toml` and `requirements*.txt` for `fastapi`. Cheap; no source scan. |
| `analyzeFile` | `src/analyze.ts` | Per-`.py`-file AST walk: bindings, `include_router` calls, decorator routes, parameter classification, path normalization. |
| `resolve` | `src/resolve.ts` | Fixed-point prefix composition; re-emits each route at its full composed path(s); flags orphan routers. |
| `finalize` | `src/finalize.ts` | Emits the `http.module` summary node and downgrades any still-deferred refs to diagnostics. |

## Cross-service edge contract

The `http.*` kind namespace is shared across all HTTP adapters. fastapi is the *server-side producer*; the *client-side adapter* (nextjs, http-client) is the matchmaker. Concretely:

- **Path normalization at emit-time.** Every `http.route` node's `data.path` uses colon-style placeholders, regardless of which framework produced it:
  - `{id}`            → `:id`
  - `{item_id:int}`   → `:item_id`         (type info is preserved on the corresponding `RouteParam.type`)
  - `{rest:path}`     → `*rest`            (last segment only; matches `.*` in the consumer's regex)

  This means a Next.js `fetch("/users/123")` matches a FastAPI route declared as `@app.get("/users/{id}")` *and* an Express route declared as `app.get("/users/:id", ...)` through one regex translation in the matcher, not three.

- **Matcher ownership.** fastapi does **not** emit `http.calls` edges. The client-side adapter walks `peers.get("fastapi").nodes("http.route")` (and equivalent for express), exact-then-regex matches `(method, url)`, and resolves its own deferred refs. This avoids double-emission when both nextjs and a server adapter are active in the same repo.

- **Edge data shape (for reference; produced by client adapter, not us):**
  ```ts
  edge.kind = "http.calls";
  edge.from = clientCallNodeId;
  edge.to   = matchedRouteNodeId;
  edge.data = {
    method: "GET",
    path: "/users/:id",
    matchKind: "exact" | "parameterized",
  };
  ```

## Configuration

```ts
// codegraph.config.ts
import fastapi from "@codegraph/adapter-fastapi";

export default {
  adapters: [fastapi()],
};
```

The factory currently takes no options — fastapi has no behavior to tune. The `FastApiAdapterConfig` interface is reserved for future additions.

## Diagnostics

| Code | Severity | When |
| --- | --- | --- |
| `fastapi/route-path-not-literal` | `warn` | Decorator's first arg isn't a string literal. Route is skipped. |
| `fastapi/handler-symbol-not-resolved` | `warn` | Host's py-indexer didn't surface a symbol for the decorated function. Route is emitted; handler edge is omitted. |
| `fastapi/include-router-fixed-point-cap` | `warn` | Fixed-point loop hit its 32-pass safety cap. Almost always indicates a cyclic `include_router` chain. |
| `fastapi/unresolved-cross-service-edge` | `unresolved-edge` | A deferred cross-service ref survived `resolve` (reserved; not produced by current logic). |

## Determinism

Same inputs → byte-identical IR. Specifically:

- Route IDs are content-addressed: `route::<METHOD>:<normalizedPath>@<ownerVar>` keyed off the route's intrinsic identity, not iteration order.
- The fixed-point loop's per-binding `prefixes` list is order-stable: prefixes are appended in include-iteration order, which is deterministic given file-walk order is host-controlled.
- No `Date.now()`, no `Math.random()`, no unsorted-Map iteration leaking into output.

## License

MIT — see [LICENSE](../../LICENSE).
