# @codegraph/viewer

React + Vite SPA for exploring a codegraph IR (intermediate representation)
produced by the deterministic, no-LLM static analysis pipeline.

The viewer is purely client-side — no backend, no telemetry, no network calls
beyond loading the IR JSON itself. Drop an `ir.json` into `public/` for
development, or paste a URL / pick a local file at runtime.

## What it is

codegraph emits a typed IR describing a codebase as a graph of nodes (services,
modules, types, functions, expressions) and edges (calls, imports, type-of,
data-flow, etc.). This package renders that graph interactively so a human can:

- navigate the hierarchy (service -> module -> type -> function -> expression),
- inspect provenance (file path + line range) for any node,
- filter by node tier, edge kind, file path, or free-text search,
- follow edges between nodes to understand call / data-flow.

## Dev commands

```bash
pnpm --filter @codegraph/viewer install
pnpm --filter @codegraph/viewer dev      # vite dev server on :5173
pnpm --filter @codegraph/viewer build    # static bundle to dist/
pnpm --filter @codegraph/viewer preview  # serve the production bundle
pnpm --filter @codegraph/viewer typecheck
```

For local dev, place a sample IR at `public/ir.json` — the loader fetches that
path by default. In production, the user provides a URL or picks a file via
the file input in the sidebar.

## Architecture

```
src/
  main.tsx                  Vite entry, mounts <App />.
  App.tsx                   Top-level layout: sidebar | canvas | inspector.
  index.css                 Tailwind v4 entry + a few CSS variables.
  components/
    Graph.tsx               React Flow v12 canvas with custom node types.
    Inspector.tsx           Selected node: provenance, edges, type info.
    NodeService.tsx         Custom node renderer for tier=service.
    NodeModule.tsx          Custom node renderer for tier=module.
    NodeType.tsx            Custom node renderer for tier=type.
    NodeFunction.tsx        Custom node renderer for tier=function.
    NodeExpression.tsx      Custom node renderer for tier=expression.
  lib/
    load-ir.ts              fetch + shape-validate IR JSON.
    layout.ts               ELK-based hierarchical layout.
  state/
    graph.ts                Zustand store: ir, selection, filters.
```

### Why Zustand

The viewer's shared state is small (a loaded IR, a selected node id, a few
filter predicates) but is read by many distant components (sidebar search,
canvas, inspector). Zustand gives us granular subscriptions without the
ceremony of Context + reducers, and avoids re-rendering the React Flow canvas
when only the inspector cares about the change.

### Why ELK over Dagre

The IR is hierarchical by construction (services contain modules contain types
contain functions contain expressions). ELK's `layered` algorithm with
`elk.hierarchyHandling: INCLUDE_CHILDREN` understands compound graphs natively;
Dagre flattens hierarchy and would require us to manually nest sub-layouts.
ELK is heavier but runs in a Web Worker (`elkjs/lib/elk-api`) so the main
thread stays responsive on large graphs. Layout is computed once after IR load
and cached on the node objects.

## IR contract

The viewer imports IR types from the sibling `@codegraph/ir` package:

```ts
import type { IR, Node, Edge } from '@codegraph/ir';
```

While that package is still being authored, `src/lib/load-ir.ts` ships local
stub types matching the agreed shape — replace with the published types as
soon as `@codegraph/ir` is on the workspace.

## Non-goals

- No editing. The viewer is read-only.
- No persistence. Reload re-fetches the IR.
- No LLM calls. codegraph is deterministic by design.
