# @codegraph/adapter-nextjs

Framework adapter that lifts [Next.js App Router](https://nextjs.org/docs/app) conventions
into the codegraph IR: HTTP routes, rendered pages, Server Actions, and
client-side `fetch()` calls.

This package is a [codegraph](https://github.com/codegraph/codegraph) framework
adapter. Drop it into a project that uses Next.js 13+ and codegraph's CLI will
auto-discover it via the `codegraph-adapter` keyword.

```bash
pnpm add -D @codegraph/adapter-nextjs
```

```ts
// codegraph.config.ts
import nextjs from "@codegraph/adapter-nextjs";

export default {
  adapters: [nextjs()],
};
```

## What it emits

| Kind                       | Where it comes from                                           |
| -------------------------- | ------------------------------------------------------------- |
| `http.route` node          | Each `GET` / `POST` / etc. export of `app/.../route.ts`       |
| `nextjs.page` node         | Default export of `app/.../page.tsx`                          |
| `nextjs.server-action` node | Async functions covered by a `'use server'` directive        |
| `http.client-call` node    | `fetch(url)` calls with statically-resolvable URLs            |
| `http.route-handler` edge  | `route` node -> handler symbol                                |
| `nextjs.page-component` edge | `page` node -> component symbol                             |
| `nextjs.action-handler` edge | `server-action` node -> bound symbol                        |
| `nextjs.action-call` edge  | Caller symbol -> `server-action` node (resolved via indexer)  |
| `http.calls` edge          | `client-call` node -> matching `http.route` (cross-adapter)   |

## Detection

Active when **both** are true:

1. `next` is listed in any `package.json` under `dependencies` or `devDependencies`.
2. An `app/` or `src/app/` directory exists at the project (or any package) root.

Pages-router-only projects (`pages/`) are intentionally not handled.

## Route conversion

File paths under `app/` map to URL routes per Next.js's conventions, normalized
to colon-style so the path lines up with the patterns Express/FastAPI emit:

| Source path                       | Emitted route       |
| --------------------------------- | ------------------- |
| `app/users/route.ts`              | `/users`            |
| `app/users/[id]/route.ts`         | `/users/:id`        |
| `app/users/[id]/page.tsx`         | `/users/:id`        |
| `app/(marketing)/about/page.tsx`  | `/about`            |
| `app/blog/[...slug]/page.tsx`     | `/blog/*slug`       |
| `app/blog/[[...slug]]/page.tsx`   | `/blog/*slug`       |
| `app/_components/x.tsx`           | (skipped — private) |
| `app/@modal/page.tsx`             | (skipped — parallel route slot) |

## Cross-stack `fetch` -> route matching

The adapter is the matchmaker for cross-stack edges (per
[`spec/adapter-interface.md`](../../spec/adapter-interface.md) §9). When the
project also runs `@codegraph/adapter-express` or `@codegraph/adapter-fastapi`,
this adapter:

1. Walks every `fetch(url)` it found (via deferred `match-route` refs).
2. Looks up `http.route` nodes in `own + peers["fastapi"] + peers["express"]`,
   in that priority order.
3. Resolves the deferred edge to the matched route, or leaves it unresolved
   (the host turns those into `unresolved-edge` placeholders).

Match algorithm:

- Strip the client URL's query string and trailing slash.
- Match `(method, path)` exactly first.
- Otherwise, convert the route pattern to an anchored regex:
  - Last-segment `*name` -> `.*`
  - Other `:name` / `{name}` / `*name` -> `[^/]+`
- First match wins; iteration order across peer outputs is stable.

## Server Actions

Two flavors, both detected:

- **Module-level** — file's first directive is `'use server'`. Every async
  exported function becomes a `nextjs.server-action`.
- **Function-level** — a function body's first statement is `'use server'`.
  The covering function (when async) becomes a `nextjs.server-action`.

When the host's TypeScript indexer is active, `resolve` walks call-site
references to each action's bound symbol and emits `nextjs.action-call`
edges from the calling function to the action node — the moral equivalent of
the cross-stack `http.calls` edge for Server Actions.

## Permissions

This adapter declares no `permissions`. It reads only files the host has
already in-scoped (the `ScopedFs` view) and uses no env, exec, or network.

## Configuration

```ts
nextjs({
  // Limit analyzeFile to these globs (default: every TS/JS file in scope).
  include: ["app/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
  // Excluded patterns. The host's gitignore + repo ignore list also apply.
  exclude: ["**/__fixtures__/**"],
});
```

## License

MIT
