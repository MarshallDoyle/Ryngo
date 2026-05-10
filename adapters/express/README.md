# @codegraph/adapter-express

First-party [codegraph](../../README.md) framework adapter for
[Express.js](https://expressjs.com). Recognizes route registrations,
composes Router mount prefixes, and emits shared `http.route` IR nodes
that the cross-stack matcher (in `@codegraph/adapter-nextjs`) joins to
frontend `fetch` calls.

> Deterministic, AST-based, no LLM. Same input → byte-identical IR.

## Status

- API version: `1` (matches `@codegraph/adapter-sdk@^0.1`)
- Adapter version: `0.1.0`
- ID scheme: `express`

## Install

```bash
pnpm add -D @codegraph/adapter-express
```

Then register it in `codegraph.config.ts`:

```ts
import express from "@codegraph/adapter-express";

export default {
  adapters: [express()],
};
```

The factory accepts an optional config object:

```ts
express({ maxFileBytes: 2_000_000 });
```

| Option         | Default     | Description                                                                                |
|----------------|-------------|--------------------------------------------------------------------------------------------|
| `maxFileBytes` | `1_000_000` | Skip analysis for files larger than this. Helpful for skipping minified bundle files.      |

## What it produces

### Nodes

| Kind                   | Source                                                | `data` highlights                                                                              |
|------------------------|-------------------------------------------------------|------------------------------------------------------------------------------------------------|
| `http.route`           | every `app.METHOD(...)` and `router.METHOD(...)`      | `method`, `path`, `framework: "express"`, `fullPath`, `handlerSymbolId?`, `ownerKind`, `orphan?` |
| `express.handler`      | inline arrow / function-expression handlers          | `displayName: "anonymous"`, `async?`                                                            |
| `express.router`       | every `express.Router()` / `Router()` binding         | `varName`                                                                                       |
| `express.file-mounts`  | per-file carrier of mount records (internal)          | `mounts: MountRecord[]`                                                                         |
| `express.summary`      | one per repo, emitted in `finalize`                   | `routes`, `routers`, `orphanRouters`                                                            |

`http.route` is the cross-adapter contract kind. adapter-nextjs reads it
via `peers.get("express").nodes("http.route")` to draw frontend
`fetch -> route` edges. adapter-fastapi emits the same kind (with
`framework: "fastapi"`).

### Edges

| Kind                      | From         | To                                | When                                                |
|---------------------------|--------------|-----------------------------------|-----------------------------------------------------|
| `express.route-handler`   | `http.route` | language-indexer symbol or handler node | every successfully-parsed route registration |

This adapter does **not** emit cross-stack `http.calls` edges —
adapter-nextjs is the producer-of-record for those. We're producer-only
of route nodes.

### Diagnostics

| Code                                | Severity | When                                                  |
|-------------------------------------|----------|-------------------------------------------------------|
| `express/route-path-not-literal`    | `warn`   | `app.get(`${prefix}/x`, ...)` — non-static path       |
| `express/handler-unresolved`        | `warn`   | terminal arg is neither identifier, member, nor inline function |
| `express/router-not-mounted`        | `warn`   | router carries routes but is never `app.use(...)`-mounted |

## What it recognizes

```ts
import express, { Router } from "express";
const app = express();
const userRouter = express.Router();   // ✓ recognized
const blogRouter = Router();           // ✓ recognized (named import)

app.get("/health", (req, res) => res.send("ok"));        // ✓ inline handler
app.post("/users", createUser);                          // ✓ identifier handler
userRouter.get("/:id", controllers.users.byId);          // ✓ dotted handler

app.use("/api/users", userRouter);                       // ✓ mount with prefix
app.use(blogRouter);                                     // ✓ prefix-less mount
userRouter.use("/posts", postsRouter);                   // ✓ nested mount
```

The resolver fans nested routers transitively: a route on `postsRouter`
mounted at `/posts` inside a `userRouter` mounted at `/api/users` shows
up as `GET /api/users/posts/:id` in `data.fullPath`.

## What it deliberately does not do (yet)

- `app.route('/x').get(...).post(...)` chains. The chained shape is
  rare; v0.1 emits a `warn` and skips. v0.2 will handle it.
- Middleware tracking. `app.use(fn)` (no router) is silently ignored.
- Dynamic paths. Template literals with interpolations are not
  fabricated — we emit a `warn` and skip. Adapters must be sound.
- Dynamic mount prefixes. Same rule.

## Determinism

Same input → byte-identical IR. We sort iteration over `Map`s and
collected mounts before composing prefixes, mint IDs from intrinsic
identity (method + path + composed prefix) rather than counters, and
never call `Date.now()`.

## Testing

```bash
pnpm --filter @codegraph/adapter-express test
```

Fixtures live in `../../test-fixtures/express/`:

| Fixture                       | Exercises                                                      |
|-------------------------------|----------------------------------------------------------------|
| `simple-app/`                 | flat `app.get('/x', handler)` registrations                    |
| `router-mount/`               | single Router mounted with a prefix                            |
| `router-multi-mount/`         | one Router mounted at two prefixes (fan-out)                   |
| `nested-routers/`             | router-onto-router transitive composition                      |
| `orphan-router/`              | router carrying routes but never mounted (orphan diagnostic)   |
| `non-literal-path/`           | `app.get(\`${prefix}/x\`, ...)` (non-literal-path diagnostic)  |
| `inline-handler/`             | arrow / function expression handlers                           |
| `dotted-handler/`             | `controllers.users.byId` style                                 |

## License

MIT — see [LICENSE](../../LICENSE).
