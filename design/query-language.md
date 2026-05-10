# Query Language — `cgql`

> Status: Design spec, v1
> Owner: codegraph core
> Scope: how users (humans, CI, the viewer) ask questions of a `codegraph.json`
> IR. Covers language choice, surface syntax, semantics, output formats, CLI
> integration, viewer integration, and the execution model.

## 0. Why this exists

A typed graph IR is only as useful as the questions you can ask of it. The
viewer answers some questions visually (pan, zoom, click), but the
load-bearing questions — the ones that show up in PR comments, in security
reviews, in onboarding tours — are *queries over the graph*:

- "Show every path from an HTTP route to a `db-write`."
- "What does `paymentsHandler` reach that is impure?"
- "Which cross-service edges have `valueType.display = unknown`?"
- "Of the functions changed in this PR, which are reachable from a route
  tagged `auth:public`?"

Pointing and clicking does not scale to those. This document specifies
`cgql` — what it is, what it costs, what it returns, and how it plugs
into the rest of the system.

The deliverable is three things:

1. A `codegraph query "<expr>"` CLI subcommand that runs against any
   `codegraph.json` and prints results to stdout.
2. A query bar in the viewer that runs the same language and highlights
   the matching subgraph in place.
3. A small library API (`@codegraph/core/query`) so the GitHub Action and
   third-party tools can run queries programmatically.

---

## 1. Language choice

### 1.1 The candidates

We considered four shapes:

| Option              | Example for "paths from HTTP routes to db-writes"            |
| ------------------- | ------------------------------------------------------------ |
| GraphQL-style       | `{ paths(from: { tag: "http-route" }, to: { sink: "db-write" }) { nodes { id name } } }` |
| Datalog (Glean)     | `path(X, Z) :- edge(X, Y), path(Y, Z). httpRoute(X), path(X, Z), dbWrite(Z).` |
| Cypher-style        | `MATCH p = (a:Function)-[*]->(b:Sink {flavor:"db-write"}) WHERE a.tag = "http-route" RETURN p` |
| Custom DSL          | `from tag:http-route to sink:db-write` |

**GraphQL** is the wrong tool. GraphQL is a *fetch* language for
hierarchical data, not a *traversal* language for graphs. Expressing
reachability with `*`-length paths in GraphQL means bespoke field
arguments — at which point we are inventing a DSL inside another DSL.
Its schema-driven nature also forces every traversal shape to be baked
in up front, fighting the ad-hoc-question use case. Rejected.

**Datalog** is *the* language for this problem on the merits — recursive
joins is what it was designed for, and Glean uses a Datalog dialect at
very large scale. The cost is ergonomics: a typical user (a backend dev
debugging a regression) should not have to learn intermediate predicates
and safety conditions to ask "what does `paymentsHandler` reach?"

**Cypher** is the practical sweet spot. Most-deployed property-graph
language (Neo4j, Memgraph, RedisGraph, Apache AGE), readable ASCII-art
for paths (`(a)-[:CALL]->(b)`), and variable-length path operators
(`*1..5`) which are exactly what reachability needs. But raw Cypher is
overkill: we do not need `MERGE`, `CREATE`, `SET`, indexes-as-syntax,
or full subqueries.

**Custom DSL** is what we ship — but Cypher-shaped, not invented. A
read-only slice of Cypher (`MATCH` / `WHERE` / `WITH` / `RETURN` +
aggregation) with codegraph-native labels for tiers and edge categories.
Short name `cgql` so it does not collide with Neo4j SEO.

### 1.2 Recommendation

**Adopt a Cypher-shaped read-only DSL named `cgql`.** Rationale:

1. **Familiarity dominates novelty.** The `(node)-[edge]->(node)` pattern
   is recognizable to Neo4j users and unambiguous to everyone else. It
   maps directly to how the viewer already draws graphs.
2. **Variable-length paths are first-class.** `(a)-[:CALL*1..5]->(b)`
   is the right surface syntax for reachability and we get it for free.
3. **Read-only is enough.** The IR is the indexer's product; queries
   never mutate it. Dropping `CREATE` / `MERGE` / `SET` / `DELETE` /
   `REMOVE` shrinks the parser, reserved-word list, and docs surface.
4. **Codegraph-native selectors save typing.** `(:function)`,
   `[:db-write]`, `(:sink {flavor:"network"})` are syntactic shorthand
   for the most common predicates in our domain instead of `WHERE`-clause
   clutter.
5. **Datalog-on-demand.** `cgql` compiles to a small set of relational
   primitives (§7); a Datalog evaluator over those primitives is a pure
   backend swap if anyone needs full recursive logic later.
6. **It plays well with the IR.** Tier on every node, category on every
   edge, stable hash for identity — exactly what a Cypher-style matcher
   wants to bind against.

We do *not* adopt Cypher's full property-graph data model (no
user-defined edge properties at query time, only schema-fixed ones),
`OPTIONAL MATCH`'s NULL semantics (stricter "no match → empty result"),
or the full `CASE` expression (one inline form only, §8.9).

---

## 2. Surface syntax

```
[ MATCH <pattern> [, <pattern>]* ]
[ WHERE <predicate> ]
[ WITH <projection> [, <projection>]* ]
[ ORDER BY <expr> [ASC|DESC] ]
[ LIMIT <int> ]
RETURN <projection> [, <projection>]*
```

Only `RETURN` is mandatory.

### 2.1 Patterns

```
(<var>:<tier> {<key>:<val>, ...})
-[<var>:<category>*<min>..<max> {<key>:<val>, ...}]->
(<var>:<tier> {<key>:<val>, ...})
```

All bracketed parts are optional:

- `<var>` — binding name. Omit if not referenced later.
- `<tier>` — `service | module | type | function | expression | sink |
  source`. `sink` and `source` are sugar for an `expression` with the
  matching flavor: `(:sink {flavor:"db-write"})` matches an expression
  whose `sink.flavor === "db-write"`.
- `<category>` — an edge category from `spec/ir-schema.md` §4.1.
  Alternate with `|`: `[:call|type-flow]`.
- `*<min>..<max>` — variable-length path. `*` = `*1..`. `*..5` =
  `*1..5`. `*0..1` = optional.
- `{<key>:<val>}` — inline property filter, equivalent to a `WHERE`
  conjunct.

Edges may be undirected (`-[...]-`) or reverse (`<-[...]-`). `-[]-` is
a wildcard.

### 2.2 Path bindings

```
MATCH p = (a:function)-[:call*1..5]->(b:function)
RETURN p
```

`p` is a `Path` value (§4.2): returnable, sortable by `length(p)`, etc.

### 2.3 Predicates in `WHERE`

Predicates use C-like operators with codegraph-native helpers:

```
a.name =~ "^handle"            // regex match
a.tier = "function"
a.path STARTS WITH "apps/api"  // string helpers: STARTS/ENDS/CONTAINS
a.pure = false
glob(a.path, "**/auth/**")     // glob() helper for file globs
hasTag(a, "auth:public")       // tag membership
e.category IN ["call", "type-flow"]
length(p) <= 4                 // path length
NOT EXISTS { (a)-[:db-write]->() }  // existence subquery
```

Boolean operators are `AND`, `OR`, `NOT` (case-insensitive). String
literals are double-quoted. Numbers are JSON-shaped. `null` is reserved
for missing optional fields; comparisons against `null` use `IS NULL`
and `IS NOT NULL` (no `=` to `null`, to keep the rules around tri-valued
logic out of the language).

### 2.4 `WITH` and aggregation

`WITH` is the pipeline operator: it projects the current bindings into a
new set, optionally applying aggregations.

```
MATCH (m:module)-[:contains*]->(f:function)
WITH m, count(f) AS fnCount
WHERE fnCount > 50
RETURN m.path, fnCount
ORDER BY fnCount DESC
```

Supported aggregations: `count`, `count(distinct …)`, `min`, `max`,
`sum`, `avg`, `collect` (gather into a list). Grouping is implicit:
non-aggregated columns in `WITH` form the group key, exactly as in SQL's
`GROUP BY` (this is the Cypher convention; it surprises SQL-trained users
exactly once and then they internalize it).

### 2.5 What is *not* in `cgql`

To keep the parser and evaluator small:

- No write clauses (`CREATE`, `MERGE`, `SET`, `DELETE`, `REMOVE`).
- No `OPTIONAL MATCH`. Use `WHERE NOT EXISTS { ... }` instead.
- No `UNION`. Run multiple queries and concatenate in the caller.
- No user-defined functions. The function table is fixed (§3.5).
- No parameters at the language level — the CLI and library API
  substitute `$name` references from a `--params` map before parsing.
- `// line` and `/* block */` comments between tokens.

---

## 3. Selectors and shortcuts

### 3.1 Node selection by id

```
MATCH (n) WHERE n.id = "f607182930415263"
RETURN n
```

`id` is the 32-hex string from `spec/ir-schema.md` §6. Equality is the
cheapest selector — it hits the by-id index in O(1).

### 3.2 Node selection by name pattern

```
MATCH (f:function) WHERE f.name =~ "^handle"
RETURN f.id, f.name, f.path
```

`=~` is a regex match against the surface name. We always use
ECMAScript regex semantics (the JSON viewer runs in JS; the CLI runs in
Node; the regex flavor is the same).

### 3.3 Selection by tier

The tier sits in the label position of the pattern: `(:service)`,
`(:module)`, `(:type)`, `(:function)`, `(:expression)`. This is
syntactic sugar; under the hood it's `n.tier = "service"` etc.

`(:sink {flavor:"db-write"})` and `(:source {flavor:"env"})` are sugar
for `(:expression)` plus a property filter on the leaf or sink object.

### 3.4 Selection by tag

The IR schema does not currently have a top-level `tags` field on every
node, but adapters and the viewer both want one. v1 of `cgql` specifies
tag selection now, with synthesized tags as a fallback:

| Surface          | Source                                            |
| ---------------- | ------------------------------------------------- |
| `pure`           | `node.pure` boolean                               |
| `effectful`      | `!node.pure`                                      |
| `exported`       | `node.exported` boolean                           |
| `sink:<flavor>`  | `node.sink?.flavor === <flavor>`                  |
| `leaf:<flavor>`  | `node.leaf?.flavor === <flavor>`                  |
| `route:<method>` | `node.kind === "route"` and method matches        |
| `lang:<name>`    | `node.lang === <name>`                            |
| `service:<name>` | nearest containing service has matching name      |
| `<custom>`       | adapter-emitted, in `node.tags?: string[]` (future) |

Selection: `hasTag(n, "sink:db-write")` is a predicate; the property
shorthand form is also accepted: `(:expression {tag:"sink:db-write"})`.

Tags are a *query-time* concern. When the schema gains a real `tags`
field (v0.2 candidate), the `cgql` selection syntax stays the same.

### 3.5 Built-in functions

The function table is fixed and small:

| Function                   | Returns | Notes                              |
| -------------------------- | ------- | ---------------------------------- |
| `length(p)`                | int     | path length in edges               |
| `nodes(p)`                 | list    | nodes along a path                 |
| `edges(p)`                 | list    | edges along a path                 |
| `count(x)`                 | int     | aggregate                          |
| `count(distinct x)`        | int     | aggregate                          |
| `min/max/sum/avg(x)`       | num     | aggregate                          |
| `collect(x)`               | list    | aggregate                          |
| `glob(s, pattern)`         | bool    | glob match                         |
| `hasTag(n, tag)`           | bool    | tag membership                     |
| `service(n)`               | node    | nearest enclosing service          |
| `module(n)`                | node    | enclosing module                   |
| `parent(n)`                | node    | direct parent                      |
| `pathString(p, sep?)`      | string  | join node names with separator     |
| `changedInPR()`            | set     | nodes touched by current PR        |

`changedInPR()` is unusual: it returns the set of node ids tagged as
"changed" by an earlier diff step. It is populated by the GitHub Action
(which runs `codegraph diff` and feeds the result to `codegraph query`
via an environment variable / `--pr` flag) and by the viewer's "PR mode"
toggle. Outside those contexts, it returns the empty set. See §5.4.

---

## 4. Output formats

A `cgql` query produces a *result*. The result has one of three shapes:

### 4.1 Node list

```
RETURN n.id, n.name, n.path
```

Flat tabular bindings. CLI prints columns; viewer renders a side-panel
table; library returns `Array<Record<string, JSONValue>>`.

### 4.2 Path list

```
MATCH p = (a:function)-[:call*]->(b:expression {tag:"sink:db-write"})
RETURN p
```

Each row is:

```ts
type Path = {
  nodes: NodeId[];       // length n+1
  edges: EdgeRef[];      // (sourceId, targetId, category, hash)
  length: number;        // edge count
};
```

Viewer highlights nodes and edges. CLI prints `A -> B -> C -> D`
(`--format=path`) or JSON.

### 4.3 Subgraph

```
RETURN subgraph(p)
```

Deduplicated node set plus induced edges — what the viewer wants for
highlighting (no flicker if a node appears in multiple paths):

```ts
type Subgraph = { nodes: NodeId[]; edges: EdgeRef[] };
```

A `RETURN subgraph(...)` query prints a filtered fragment of the IR
JSON, pipeable to the viewer:

```
codegraph query "..." --format=subgraph | codegraph serve --stdin
```

### 4.4 Output format selection

CLI `--format` selects `table` (default), `json`, `path`, `subgraph`,
`dot`, `mermaid`. The viewer renders inline; `--format` is CLI-only.

### 4.5 Result envelope

Every machine-readable output is wrapped:

```jsonc
{
  "schemaVersion": "0.1.0",
  "query":   "MATCH (a:function) ... RETURN ...",
  "shape":   "table" | "paths" | "subgraph",
  "columns": ["a.id", "a.name"],   // present for "table"
  "rows":    [ [...], [...] ],
  "stats":   { "matchedNodes": 42, "matchedEdges": 117,
               "elapsedMs": 18,    "planNodes": 6 }
}
```

`stats.planNodes` is the count of physical operators in the executed
plan, useful for explaining slow queries. `--quiet` drops `stats`.

---

## 5. CLI integration

### 5.1 The `codegraph query` subcommand

```
codegraph query "<expr>"
codegraph query --file path/to/query.cgql
codegraph query "..." --ir build/codegraph.json
codegraph query "..." --params params.json
codegraph query "..." --format json
codegraph query "..." --explain
codegraph query "..." --highlight     # hands result to `codegraph serve`
```

Defaults:

- `--ir` resolves `./codegraph.json` then `./build/codegraph.json`,
  same as `codegraph serve`.
- `--format` is `table` on a TTY, `json` otherwise (gh/kubectl
  convention).
- Exit codes: `0` parsed and executed (even if no rows), `2` parse
  error, `3` runtime error, `1` reserved for `--fail-empty`.

### 5.2 Stdin / pipe support

```
echo "MATCH (n:service) RETURN n.name" | codegraph query
```

Stdin is treated as `--file`. This is how the GitHub Action invokes
multi-line queries without escaping nightmares.

### 5.3 `--explain`

Prints the query plan instead of executing (§7.2):

```
$ codegraph query "MATCH (a:function)-[:call*1..5]->(b:expression {tag:'sink:db-write'}) RETURN a, b" --explain

Plan:
  Project           [a, b]                               cost ~ 110
  └─ PathExpand     :call, [1..5], rightFilter           cost ~ 110
     ├─ Scan        (a:function)                         rows  ~ 1842
     └─ Scan        (b:expression where sink.flavor=db-write)
                                                         rows  ~ 14
Indexes used:
  by-tier:function          (1842 rows)
  by-sink-flavor:db-write   (14 rows)
  reachability:call         (precomputed, hot)
```

### 5.4 `--pr` flag

`codegraph query --pr <ref>` runs `codegraph diff <ref>...HEAD` first
and tags the changed nodes so `changedInPR()` resolves to that set.
The action wires this automatically; locally it lets a developer ask
"what does my branch break?" without ceremony.

### 5.5 Programmatic API

```ts
import { runQuery } from "@codegraph/core/query";

const result = await runQuery(ir, query, { params, prChanges });
// envelope shape: see §4.5
```

The viewer, the action, and third-party tools all call this. The CLI is
a thin shell over `runQuery` plus formatting.

---

## 6. Viewer integration

The viewer gets a query bar at the top of the canvas plus a result
panel on the right.

### 6.1 Behavior

1. User types a query.
2. The viewer parses incrementally and shows the parse error (if any)
   under the bar with a caret pointing at the bad token. No execution
   on incomplete parses.
3. On Enter (Cmd-Enter for multi-line), the viewer runs
   `runQuery(ir, query)` in the browser — IR is already in memory.
4. The auto-derived result subgraph (§6.2) replaces the canvas
   highlight set: matched nodes thicken, the rest dim to 30%.
5. The result panel shows the rows/paths with a "Locate" button on
   each row to pan to that node.

### 6.2 Auto-subgraph derivation

The `RETURN` list drives the highlight:

- `RETURN n.id, ...` → union of the `n` bindings.
- `RETURN p` (path) → all nodes and edges in every returned path.
- `RETURN subgraph(...)` → exactly that subgraph.
- Mixed (`RETURN a, b, p`) → all node bindings plus all paths.

Most users never write `subgraph()` explicitly — they `RETURN` what
they care about and the viewer paints it.

### 6.3 Saved queries

A sidebar with ten built-ins (the §8 worked examples) plus user-saved
ones in `localStorage`. Saved queries are plain text and copy-paste
into the CLI. A "Copy as `codegraph query` command" button produces
the shell-friendly form. Saved-query state is client-side only — the
viewer is a workbench, not a server.

### 6.4 Performance budget in the viewer

> 200ms shows a spinner. > 1000ms offers to move execution to a
background web worker so the canvas stays interactive. > 5000ms
suggests running it via `codegraph query` instead with a copy-pasteable
command. The canvas does not freeze for ten seconds because someone
wrote `*1..` over a million-node IR.

---

## 7. Execution model

### 7.1 Storage

The IR is held in memory as a small set of tables:

```ts
type Store = {
  nodes:       Map<NodeId, IRNode>;          // by-id
  edges:       EdgeRef[];                    // canonical list
  outEdges:    Map<NodeId, EdgeRef[]>;       // adjacency, forward
  inEdges:     Map<NodeId, EdgeRef[]>;       // adjacency, reverse
  byTier:      Map<Tier, NodeId[]>;
  bySinkFlavor:Map<SinkFlavor, NodeId[]>;
  byLeafFlavor:Map<LeafFlavor, NodeId[]>;
  byPath:      Map<string, NodeId[]>;        // sorted by prefix
  byCategory:  Map<EdgeCategory, EdgeRef[]>;
};
```

Built once at IR load (CLI: at startup; viewer: on first render).
~200ms for a million-node IR in the browser, amortized over every
subsequent query.

No on-disk database. Typical IRs are 50k-200k nodes / 300k-1.5M edges,
50-300MB serialized; RAM is fine on any CI runner. Queries are
read-only; no concurrent writer. The IR file *is* the persistent form.
Repos with single IRs above ~5M nodes get a future `codegraph-bigir`
plan with RocksDB; out of scope for v1.

### 7.2 Query planning

`cgql` queries compile to a small set of physical operators:

| Operator        | Reads                          | Produces       |
| --------------- | ------------------------------ | -------------- |
| `Scan(tier?)`   | tier index or all nodes        | nodes          |
| `IdLookup(id)`  | by-id map                      | one node       |
| `Expand(dir, cat?)` | adjacency + category index | edges + nodes  |
| `PathExpand(min, max, cat?)` | adjacency, repeated | paths        |
| `Filter(pred)`  | row stream                     | filtered rows  |
| `Project(cols)` | row stream                     | reshaped rows  |
| `Aggregate(group, agg)` | row stream             | grouped rows   |
| `Sort(key, dir)`| row stream                     | sorted rows    |
| `Limit(n)`      | row stream                     | first n rows   |
| `Subgraph(node-or-path expr)` | row stream    | subgraph       |

The planner is a hand-written recursive descent over the parse tree.
There is no cost-based optimizer. Heuristics:

1. **Push filters down.** `(a:function {pure:false})` becomes
   `Filter(pure=false) ← Scan(function)`, not a scan-then-filter at the
   end.
2. **Prefer indexed scans.** `(:sink {flavor:"db-write"})` uses
   `bySinkFlavor`, never a full node scan.
3. **Direct shorter side first.** For
   `(a:function)-[:call*]->(b:sink {flavor:"db-write"})`, the planner
   notices that scanning `db-write` sinks gives ~10² rows while
   scanning all functions gives ~10⁴ rows, and runs the path expansion
   *backwards* from the sinks. The result is the same set of paths,
   but the search frontier stays small.
4. **Bound unbounded paths.** A `*` with no upper bound gets clamped to
   `*1..16` and a warning is printed. Sixteen edges is more than any
   real-world reachability question needs and prevents a runaway
   query from eating the heap. Users can pass `--max-path-length`
   to override.

`--explain` prints the chosen plan tree (§5.3). The plan is also
inspectable from the library API: `runQuery(ir, q, { explain: true })`
returns the plan instead of the result.

### 7.3 Indexes

**Always-on indexes** (built at IR load):

- `byId` — `Map<NodeId, IRNode>`, O(1) lookup.
- `byTier` — `Map<Tier, NodeId[]>`. Tier is small (5 values).
- `bySinkFlavor`, `byLeafFlavor` — small categorical indexes.
- `byCategory` — edges grouped by category for typed traversal.
- `byPath` — sorted by `path` prefix, used by `glob()` predicates.

**Hot-path precomputed reachability**: for categories queried for
reachability often (`call`, `type-flow`, `import`) we precompute a
per-source frontier sketch — *not* full transitive closure (which can
be O(n²) on densely connected subgraphs):

```ts
type ReachSketch = {
  // for a given source node, which target node-ids are reachable
  // within K hops along category C, as a compressed bitset.
  forward:  Map<NodeId, RoaringBitmap>;
  backward: Map<NodeId, RoaringBitmap>;
};
```

`K` defaults to 8. A query like `(a:function)-[:call*1..5]->(b:function)`
checks the sketch first to prune unreachable `(a, b)` pairs, then runs
explicit BFS only on survivors. Standard 2-hop labeling — turns a
worst-case quadratic blow-up into a linear walk for the cases we care
about.

The sketch is opt-in per IR via a `metadata.reachIndexes: ["call",
"type-flow"]` hint. `codegraph query --build-reach=call,type-flow`
computes and persists the sketch to a sidecar file
(`codegraph.reach.bin`) that subsequent runs pick up automatically. The
sketch is a query-engine artifact, not part of the IR.

### 7.4 Cost model

No real cost optimizer. The plan is determined by the heuristics above.
On profiled IRs (50k-200k nodes), every query in §8 returns under 100ms
cold and under 20ms warm. We will revisit when we see a query that
misses badly; we will not preemptively engineer a CBO.

### 7.5 Determinism

Query results are *ordered*. Without `ORDER BY`, results come back in
deterministic-by-construction order: nodes by id, paths by
length-then-id-lex, edges by (source, target, category, attr-hash). Two
runs of the same query against the same IR produce byte-identical
output. The CLI test harness, the viewer's saved-query screenshots, and
the action's diff comments all depend on this.

---

## 8. Worked examples

Each of the following has shipped as a built-in saved query in the
viewer, and is part of the CLI's smoke-test suite.

### 8.1 All paths from any HTTP route to any DB write

```
MATCH p = (h:function)-[:call|type-flow*1..8]->(s:expression {tag:"sink:db-write"})
WHERE EXISTS { (h)-[:http-route]->() }
RETURN p
ORDER BY length(p)
LIMIT 200
```

Why: this is the canonical "trust boundary → persistent state" question.
Every backend gets one of these on every PR review. The `*1..8` bound
is conservative; the planner uses the precomputed `call|type-flow`
reachability sketch to prune in advance.

### 8.2 Functions reachable from `paymentsHandler` that are impure

```
MATCH (start:function {name:"paymentsHandler"})
MATCH p = (start)-[:call*1..]->(f:function)
WHERE f.pure = false
RETURN DISTINCT f.id, f.name, f.path, length(p) AS hops
ORDER BY hops, f.name
```

Why: when triaging "this thing did something," knowing every effectful
descendant is the bounding box of "things to suspect." `DISTINCT` keeps
the result set on functions, not paths.

### 8.3 Cross-service edges with `valueType.display = "unknown"`

```
MATCH (a)-[e]->(b)
WHERE service(a).id <> service(b).id
  AND e.valueType.display = "unknown"
RETURN a.path, b.path, e.category, count(*) AS n
ORDER BY n DESC
```

Why: cross-service `unknown` edges are the highest-value
type-confidence regression to fix. The query both surfaces the regression
and aggregates by source/target so duplicates collapse.

### 8.4 Functions changed in this PR reachable from auth routes

```
MATCH (route:function)
WHERE hasTag(route, "route:any") AND hasTag(route, "auth:public")
MATCH p = (route)-[:call*1..]->(f:function)
WHERE f.id IN changedInPR()
RETURN DISTINCT f.path, f.name, length(p) AS distance
ORDER BY distance, f.path
```

Why: the highest-signal CI question. "Of the things you changed, which
sit on a path from a public-auth route?" The action prepends
`changedInPR()` automatically; locally the user passes
`--pr origin/main`.

### 8.5 Files with high churn AND in the auth subsystem

```
MATCH (m:module)
WHERE glob(m.path, "**/auth/**")
  AND m.churn90d > 20      // adapter-emitted, monthly count
WITH m, m.churn90d AS churn
RETURN m.path, churn
ORDER BY churn DESC
LIMIT 50
```

Why: combining churn and subsystem identifies "the part of the codebase
where things are moving fastest *and* a mistake is most expensive." The
`churn90d` field is emitted by an optional churn adapter; if absent, the
predicate is `null` and the row drops.

### 8.6 Sink chokepoints — db-writes touched by the most call paths

```
MATCH p = ()-[:call*1..6]->(s:expression {tag:"sink:db-write"})
WITH s, count(distinct p) AS reachers
WHERE reachers > 5
RETURN s.path, s.parentId, reachers
ORDER BY reachers DESC
LIMIT 50
```

Why: a sink with a thousand reachers is structurally important — a bug
there blasts the whole graph. This query ranks them.

### 8.7 Public-API surface — exported functions never imported externally

```
MATCH (f:function {exported:true})
WHERE NOT EXISTS {
  ()-[:import]->(f)
}
RETURN f.path, f.name
ORDER BY f.path
```

Why: dead exports are surface area without users. Sweep them on a
quarterly cadence. (Note: this catches only call-site dead-ness, not
re-exports through index files; an adapter that resolves re-exports
fixes that without changing the query.)

### 8.8 All paths from a specific `http-input` to any sink

```
MATCH p = (leaf:expression {tag:"leaf:http-input"})-[:type-flow*1..12]->(sink:expression)
WHERE leaf.leaf.field = $field
  AND (hasTag(sink, "sink:db-write")
       OR hasTag(sink, "sink:network")
       OR hasTag(sink, "sink:exec"))
RETURN p
```

Run as:

```
codegraph query --file q.cgql --params '{"field":"email"}'
```

Why: parameterized "where does field X go?" is the workhorse for data-
flow audits. The `$field` substitution happens before parse, so the
query is still a static `cgql` string at execution.

### 8.9 Group functions by enclosing service and count effectful ones

```
MATCH (f:function)
WITH service(f).name AS svc, f
WITH svc,
     count(*)                              AS total,
     sum(CASE WHEN f.pure = false THEN 1 ELSE 0 END) AS effectful
RETURN svc, total, effectful, effectful * 1.0 / total AS effectfulRatio
ORDER BY effectfulRatio DESC
```

Why: rough-and-ready "where is this codebase doing things?" — useful
for newcomers and for steering refactors. (Note: we said `cgql`
excludes `CASE`. We allow it as one inline ternary form because every
SQL-dialect-style aggregation in the wild uses it; the parser
implements `CASE WHEN <bool> THEN <expr> ELSE <expr> END` and nothing
else. This is the only `CASE` form `cgql` accepts.)

### 8.10 The "callgraph diamond" — pairs of functions both calling and being called

```
MATCH (a:function)-[:call]->(b:function), (b)-[:call]->(a)
WHERE a.id < b.id
RETURN a.path, a.name, b.path, b.name
```

Why: mutual recursion between named symbols is rare and almost always
intentional. When it isn't, it's a code-smell; this query surfaces all
candidates. The `a.id < b.id` predicate dedupes the symmetric pair.

---

## 9. Errors and diagnostics

Three buckets:

1. **Parse errors.** `(line, col, expected, found)` plus a one-line
   excerpt with a caret. CLI exits 2; viewer shows the message under
   the bar and does not execute.
2. **Plan errors.** Unknown function/field, or unbounded `*` beyond
   `--max-path-length`. CLI exits 3; viewer warns and offers a default
   bound.
3. **Runtime errors.** Currently only "out of memory while expanding
   path" — the engine soft-caps at 5,000,000 intermediate rows and
   aborts. Has not triggered on profiled IRs; cheap insurance.

The result envelope (§4.5) carries a `diagnostics` array with
`severity` (`info` | `warn` | `error`), `source` (`parser` | `planner`
| `runtime`), and message.

---

## 10. Versioning

`cgql` has its own version, independent of the IR schema. `CGQL_VERSION`
exported from `@codegraph/core/query`; `codegraph query --version`
prints both.

- **MINOR**: new functions, selectors, operators. Old queries keep
  parsing.
- **MAJOR**: breaking parse/eval changes. Old queries get a deprecation
  diagnostic for one MINOR cycle first.

---

## 11. Security

Three constraints, never relaxed:

1. **No filesystem access from a query.** No `LOAD CSV`, no `IMPORT`,
   no includes. Only the IR and `--params`, both passed in.
2. **No network access from a query.**
3. **No code evaluation.** No `eval`, no host expressions, no `exec()`.
   Closed function table (§3.5).

A malicious `cgql` query is at most a CPU/memory DoS, capped by
`--max-path-length` and the soft row limit.

---

## 12. Testing strategy

Three layers:

1. **Parser goldens.** Every example in this document plus parsed AST.
2. **Planner goldens.** Each query `--explain`ed against a fixed IR;
   plan-tree changes show up as diff noise — that is the point.
3. **End-to-end.** The ten §8 examples run against `test-fixtures/`
   IRs and assert `rows` and `stats.matchedNodes`. Coarse stats survive
   fixture additions; tight rows catch real regressions.

Goldens live under `packages/core/src/query/__goldens__/`. Update with
`pnpm test:goldens:write` only when intentional.

---

## 13. Out of scope for v1

- **Federated queries across multiple IRs.** Compose at the layer above:
  run the query against each, diff the results. No `FROM ir1, ir2`.
- **Streaming results.** All queries are batch; row counts are small.
- **Server-side saved queries.** The viewer keeps them client-side; no
  server.
- **CLI autocomplete.** The viewer's query bar autocompletes (it knows
  tiers, categories, tag namespaces); the CLI ships without it.
- **Web playground.** Future docs work.
- **GraphQL gateway.** Callers wrap `runQuery` themselves.
- **Datalog backend.** Discussed in §1.2; not now.

---

## 14. Assumptions

1. **The IR fits in memory.** True for measured IR sizes; see §7.1 for
   the threshold and the planned escape hatch.
2. **Cypher-shaped syntax is acceptable to our users.** Familiarity
   dominates novelty for anyone who has shipped Neo4j / Memgraph.
3. **Reachability along `call` and `type-flow` is the hottest path.**
   Drives the sketches in §7.3. New dominant categories get new sketches.
4. **No write queries, ever.** The IR is the analyzer's product.
5. **The viewer runs the same engine as the CLI.** `runQuery` is pure
   over IR + query string — no filesystem or process state.
6. **Tags are derivable at query time.** The synthesized layer in §3.4
   is enough until the schema gains a real `tags` field in v0.2.
7. **A `Path` is at most ~16 edges.** Planner cap; real-world
   reachability has not hit it. Override via `--max-path-length`.
8. **One query at a time per user.** The viewer cancels in-flight
   queries when a new one runs; the CLI is one-shot.

---

## 15. Quick reference

```
// All functions named `handle*`
MATCH (f:function) WHERE f.name =~ "^handle" RETURN f.id, f.name

// Direct callers of `db.users.create`
MATCH (a)-[:call]->(b:function {name:"create"})
WHERE module(b).path ENDS WITH "/users.ts"
RETURN a.id, a.name

// Full reachable subgraph from a node
MATCH (start) WHERE start.id = $id
MATCH p = (start)-[*1..]->(t)
RETURN subgraph(p)

// All effectful expressions in a service
MATCH (e:expression)
WHERE service(e).name = "api" AND e.pure = false
RETURN e.id, e.parentId, e.sink.flavor

// Top imports per module
MATCH (m:module)-[:import]->(t)
WITH m, count(t) AS imports
ORDER BY imports DESC
LIMIT 20
RETURN m.path, imports
```

---

## 16. Open questions

1. **Tag namespace.** Standardize `auth:`, `route:`, `lang:`, `service:`
   in the IR schema, or keep them as a query-layer convention? Leaning
   toward standardizing in v0.2.
2. **Multi-line query files.** Want a `q.cgql.json` that bundles query
   + params + default format? Probably yes, low priority.
3. **Query timeouts.** Currently soft via row cap. Add a wall-clock
   timeout (default 30s) for CI ergonomics.
4. **`count(*)` sweetener.** Cypher uses `count(x)`; SQL refugees write
   `count(*)`. Cheap to alias.
5. **"Why this row?" mode.** Given a result row, print the plan-step
   trace that produced it. Planner already collects the data.

---
