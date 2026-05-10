---
title: The IR
description: codegraph's intermediate representation — a stable, language-agnostic JSON graph that every other tool in the project reads and writes.
sidebar:
  order: 2
---

The **IR** (intermediate representation) is the JSON graph codegraph emits after analyzing your repository. Every other piece of codegraph — the viewer, the diff engine, the GitHub Action, your custom adapters — reads or writes this same shape. If you understand the IR, you understand the project.

## Why a separate IR

A single static-analysis pass that goes straight from source to "here's a PR comment" works until you want to do anything else with the result. You can't easily diff two runs, you can't swap the renderer, you can't write a third-party adapter, and you can't pin behavior across versions. So codegraph splits the pipeline:

```
source → adapter → IR → consumer (viewer / diff / export / your script)
```

The IR is the contract between the two halves. Adapters only need to emit valid IR. Consumers only need to read valid IR. Neither has to know about the other.

## Schema overview

The IR is a single JSON document with three top-level keys:

```json
{
  "meta": { "...": "..." },
  "nodes": [ /* ... */ ],
  "edges": [ /* ... */ ]
}
```

### `meta`

| Field          | Type     | Description                                                                 |
| -------------- | -------- | --------------------------------------------------------------------------- |
| `version`      | `string` | IR schema version. Semver. Bumped on breaking changes only.                 |
| `generatedAt`  | `string` | ISO-8601 timestamp of the run that produced this IR.                        |
| `repo`         | `object` | Repository identity: `root`, `commit`, optional `remote`.                   |
| `adapters`     | `array`  | Each adapter that contributed, with `name`, `version`, `nodeCount`.         |
| `tier`         | `enum`   | `0` \| `1` \| `2` — the deepest analysis tier that ran. See [Nodes & tiers](/concepts/nodes-and-tiers/). |

### `nodes`

A node is anything codegraph can talk about: a file, a symbol, a call site, an HTTP route, a SQL query. Every node has:

| Field    | Type     | Description                                                                 |
| -------- | -------- | --------------------------------------------------------------------------- |
| `id`     | `string` | Stable, content-addressed identifier. See [Stability](#stability-guarantees) below. |
| `kind`   | `string` | One of the documented node kinds (`file`, `symbol`, `call`, `route`, ...).  |
| `name`   | `string` | Human-readable label. Not unique.                                           |
| `loc`    | `object` | `{ path, line, col }` — where the node was defined. Optional for synthetic nodes. |
| `tier`   | `number` | The tier this node was discovered at.                                       |
| `attrs`  | `object` | Free-form, kind-specific attributes. Schema lives next to the kind's docs.  |

### `edges`

An edge is a directed relationship between two nodes:

| Field     | Type     | Description                                                                |
| --------- | -------- | -------------------------------------------------------------------------- |
| `from`    | `string` | Source node `id`.                                                          |
| `to`      | `string` | Target node `id`.                                                          |
| `kind`    | `string` | `calls`, `imports`, `reads`, `writes`, `derives-from`, `routes-to`, ...    |
| `attrs`   | `object` | Edge-kind-specific attributes (e.g. `condition` on a conditional call).    |

The full enumeration of node kinds and edge kinds lives in [Nodes & tiers](/concepts/nodes-and-tiers/) and [Edges & types](/concepts/edges-and-types/).

## A minimal example

Given this Python file:

```python
# app.py
from db import save_user

def handle_signup(req):
    save_user(req.body)
```

A tier-1 IR looks roughly like this (truncated):

```json
{
  "meta": {
    "version": "1.0.0",
    "generatedAt": "2026-05-08T14:22:11Z",
    "repo": { "root": "/repo", "commit": "a1b2c3d" },
    "adapters": [{ "name": "python", "version": "0.4.2", "nodeCount": 3 }],
    "tier": 1
  },
  "nodes": [
    { "id": "f:app.py",            "kind": "file",   "name": "app.py", "loc": { "path": "app.py", "line": 1, "col": 1 }, "tier": 0 },
    { "id": "s:app.handle_signup", "kind": "symbol", "name": "handle_signup", "loc": { "path": "app.py", "line": 3, "col": 1 }, "tier": 1, "attrs": { "kind": "function" } },
    { "id": "s:db.save_user",      "kind": "symbol", "name": "save_user",     "loc": { "path": "db.py",  "line": 7, "col": 1 }, "tier": 1, "attrs": { "kind": "function", "effects": ["db.write"] } }
  ],
  "edges": [
    { "from": "f:app.py",            "to": "s:app.handle_signup", "kind": "defines" },
    { "from": "s:app.handle_signup", "to": "s:db.save_user",      "kind": "calls", "attrs": { "callsite": { "line": 5, "col": 5 } } }
  ]
}
```

That's the whole shape. Larger codebases produce thousands of nodes and tens of thousands of edges, but the structure does not change.

## Stability guarantees

- **Node IDs are stable across runs** for the same source. Renaming a symbol changes its ID; moving a file does not (the path is part of the location, not the identity). This is what makes diffs work — see [Diff & PR comments](/concepts/diff-and-pr-comments/).
- **Schema version is semver.** Patch and minor bumps only add fields. We will never silently change the meaning of an existing field.
- **Unknown fields are reserved.** Consumers must ignore fields they don't recognize, not error. This lets adapters add experimental attrs without breaking the viewer.
- **Edge kinds are an open enum.** Core kinds are documented and fixed; adapter-specific kinds use a `namespace:kind` form (e.g. `sql:references-table`).

## Producing IR

You won't usually write IR by hand. Either:

- Run [`codegraph index`](/cli/index-command/), which invokes the configured adapters and writes the IR to `.codegraph/graph.json`, or
- Write an [adapter](/adapters/sdk/) that emits IR for a language or framework codegraph doesn't yet support.

## Consuming IR

Anything that reads `.codegraph/graph.json` is an IR consumer. The built-ins:

- The [viewer](/viewer/) renders it as an interactive graph.
- [`codegraph diff`](/cli/diff/) compares two IR files and emits a structured changelist.
- [`codegraph export`](/cli/export/) converts it to DOT, SVG, or filtered JSON.

Third-party tools can read it the same way — it's just JSON. A short Python script that lists every function reachable from an HTTP route is about 30 lines; see the [recipe](/recipes/db-writes-from-http/) for a worked example.

## See also

- [Nodes & tiers](/concepts/nodes-and-tiers/) — what a "node" actually is and what each tier costs you.
- [Edges & types](/concepts/edges-and-types/) — the edge taxonomy in full.
- [Pure vs effectful](/concepts/pure-vs-effectful/) — how `effects` attrs work and what they're good for.
- [Adapters](/concepts/adapters/) — how IR gets produced for a given language.
