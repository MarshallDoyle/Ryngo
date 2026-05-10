# codegraph — Dead-Code Detection (design)

> Status: design draft, v0.1.
> Companion docs: [`spec/ir-schema.md`](../spec/ir-schema.md),
> [`spec/config-schema.md`](../spec/config-schema.md),
> [`spec/adapter-interface.md`](../spec/adapter-interface.md).
>
> This document defines how codegraph identifies code that is never reached
> from any program entry point, how user-declared entries augment auto-
> detection, how false positives are bounded, and how dead-code findings are
> reported by CLI, viewer, and the GitHub Action.

---

## 0. Why dead-code detection at all

codegraph already builds a typed, polyglot IR with `call` and `import` edges
(see `ir-schema.md` §4). Once that graph exists, dead-code detection is *not*
a new analyzer — it is a single pass over the IR. We get it for free as long
as we are honest about three things:

1. The IR has gaps (dynamic dispatch, reflection, eval). A reachability
   analysis that pretends those gaps don't exist will confidently delete
   live code.
2. "Entry point" is a fuzzy concept that depends on how the code is run
   (CLI binary, Lambda, cron, library import). Detection must default to
   *over*-counting entries (more false negatives than false positives).
3. The user owns their code. We surface findings; we never auto-delete.

The output is therefore tiered, not binary, and the strict mode is opt-in.

---

## 1. Entry-point definition

An **entry point** is any IR node from which we begin reachability traversal.
The full set is the union of *auto-detected* entries (§1.1) and *user-declared*
entries (§2). Each entry has a `kind` (one of the kinds below), a `nodeId`
(into the IR), and a `source` (which detector produced it) — these are
preserved on the report so a user can debug "why is this dead?" by asking
"which entries did codegraph try?".

### 1.1 Auto-detected entry kinds

| Kind                  | Detection rule                                                                                                                       | Detector       |
|-----------------------|--------------------------------------------------------------------------------------------------------------------------------------|----------------|
| `http-route`          | Any function node that is the source of an `http-route` edge in the IR (every framework adapter emits these — see `adapter-interface.md`). | core           |
| `cli-bin`             | For each entry in `package.json#bin`, the resolved file's top-level module node and any `function` it exports as default.            | core (Node)    |
| `cli-bin`             | Each `[project.scripts]` and `[project.gui-scripts]` entry in `pyproject.toml`; each `[[bin]]` in `Cargo.toml`; each `cmd/<name>/main.go`. | core           |
| `library-export`      | Every `function`/`type` node referenced by a path listed in `package.json#exports` (or `main`/`module`/`types` legacy fields), recursively re-exported names. | core (Node)    |
| `library-export`      | Every public symbol in `__init__.py` of a package whose `pyproject.toml` declares it as a distribution; every `pub` item under `lib.rs`/`mod.rs` of a published crate. | core (per-lang) |
| `test`                | Any module whose path matches the language's test convention: TS/JS `*.test.{ts,tsx,js,jsx}`, `*.spec.*`, `__tests__/**`; Python `test_*.py`, `*_test.py`, `tests/**`; Go `*_test.go`; Rust `tests/**` and `#[test]` functions; Java `**/test/java/**`. | core           |
| `framework-page`      | Next.js: every file under `app/**/page.{ts,tsx,js,jsx}`, `pages/**/*.{ts,tsx,js,jsx}` (excluding `_*`), `app/**/{layout,loading,error,not-found,route}.*`, plus middleware. SvelteKit: `+page.*`, `+layout.*`, `+server.*`. Remix: `routes/**`. | adapter        |
| `framework-component` | A React component is an entry only if it is *transitively* used by a `framework-page` entry. Components reachable only from other components inherit liveness — they are not standalone entries. | core (post-pass) |
| `main-module`         | Python: any module containing `if __name__ == "__main__":`. Rust: `fn main` in a `[[bin]]` target. Go: `package main` + `func main`. Node: a file referenced by `npm start` / `pnpm start` script.    | core           |
| `lifecycle-hook`      | `package.json` lifecycle scripts (`prepare`, `postinstall`, `prepublishOnly`, …) when they invoke a workspace file. `Procfile` entries. `Dockerfile` `CMD`/`ENTRYPOINT` when they reference a workspace file. | adapter        |
| `worker`              | Files matching `*.worker.{ts,js}` referenced by `new Worker(new URL(...))`; service workers (`sw.{ts,js}`); `web-worker:` imports. | adapter        |

A module marked as a `test` entry is treated specially: it is live, but
its own reachable closure is *flagged* in the report so the user can ask
"is this function used only by tests?" (see §6).

### 1.2 What is *not* an entry

- `index.ts` of a workspace package is not, by itself, an entry. It only
  becomes one if `package.json#exports` (or `main`) points at it. A repo-
  internal `index.ts` re-exported by nobody is just a module.
- `console.log` statements in a top-level file are not an entry. The IR
  has them; reachability does not begin from them.
- A function decorated with `@deprecated`, `@internal`, etc. is not an
  entry by virtue of the decorator. Decorators only become entries via
  the framework adapter that interprets them (e.g., `@app.get` in
  FastAPI emits an `http-route` edge).
- Comments saying "// entry point" are ignored. Entries are declarative
  (config, framework, manifest), never prose.

### 1.3 Adapter contract

Each adapter is responsible for emitting whatever IR edges its framework
implies, and *also* for advertising its entries through a small extra
hook on the adapter object:

```ts
interface Adapter {
  // … existing fields from adapter-interface.md …

  /** Optional. Called once per repo after node emission. Returns entry-point
   *  references. The host accumulates these across all adapters before
   *  reachability runs. */
  entryPoints?(ctx: AdapterContext): EntryPointRef[];
}

type EntryPointRef = {
  nodeId: string;          // must resolve in the emitted IR
  kind:   "http-route" | "cli-bin" | "library-export" | "test"
        | "framework-page" | "main-module" | "lifecycle-hook"
        | "worker" | "x-" + string;   // x- prefix per ir-schema §8
  source: string;          // adapter id, for debugging
  label?: string;          // human-readable, shown in viewer
};
```

This keeps entry detection close to the analyzer that knows the framework,
without polluting the IR itself with an "isEntry" boolean. The IR remains
a pure graph; entry-point info lives next to it in
`.codegraph/entry-points.json`.

---

## 2. User-declared entry points

`.codegraph.yml` already has an `entryPoints` section
(see `config-schema.md` §3.8). For dead-code detection it is the escape
hatch for everything we cannot auto-detect:

- A cron job invoked by an external scheduler that imports `jobs/nightly.ts`.
- A Lambda handler whose registration is in Terraform, not the source.
- A debug script run only by ops, e.g. `scripts/dump_state.py`.
- A function called by reflection from a config-driven plugin loader.

```yaml
entryPoints:
  include:
    # A function called only via cron — name it explicitly.
    - kind: function
      symbol: "packages/jobs/src/nightly.ts#runNightlyReindex"
      label: "Nightly reindex (cron)"

    # An entire file is an entry: every exported symbol of it is live.
    - kind: file
      path: "packages/lambda/src/handlers/billing.ts"
      label: "Billing webhook (AWS)"

    # An export pattern (everything in the file) for an internally-used package.
    - kind: export
      symbol: "packages/internal-sdk/src/index.ts"
      label: "Internal SDK consumed by the mobile app repo"

    # A framework route we know the adapter doesn't see.
    - kind: route
      symbol: "packages/api/src/legacy/handler.ts#legacyXmlHandler"

  exclude:
    - "scripts/**"           # never use scripts/ contents as entries
    - kind: route
      symbol: "packages/api/src/v1/healthz.ts#healthz"   # we accept it dies
```

**Resolution rules.** Following `config-schema.md` §4:

1. Auto-detection runs and emits its `EntryPointRef[]`.
2. `entryPoints.include` is appended. Each `include` is resolved against
   the IR by `(kind, symbol|path)`. An entry that fails to resolve becomes
   a diagnostic with severity `warning` and is dropped — we don't pretend
   it's there.
3. `entryPoints.exclude` is applied. Excludes can be globs (matched against
   the node's `module` path) or `(kind, symbol|path)` objects (matched as
   includes are). An excluded entry is removed from the entry set even if
   auto-detection found it.

The final entry set is written to `.codegraph/entry-points.json` next to
the IR, with `source` showing how each one got there
(`auto:next-page`, `auto:cli-bin:package.json`, `config:include[3]`, …).
Reproducing reachability from this file alone is the public contract for
third-party tools.

### 2.1 Schema for `include` items (recap)

| Field    | Type     | Notes                                                                |
|----------|----------|----------------------------------------------------------------------|
| `kind`   | enum     | `function` \| `file` \| `route` \| `export`. Default `function`.    |
| `symbol` | string   | Mutually exclusive with `path`. Format depends on `kind`.            |
| `path`   | string   | Repo-relative file path. Mutually exclusive with `symbol`.           |
| `label`  | string?  | Free text, shown in viewer/report.                                   |

`function` and `route` use the `module#name` symbol form
(see `ir-schema.md` §6 for the underlying signature). `export` may use
either a file path (interpreted as "every export of this module") or a
specific `module#name`.

---

## 3. Reachability

Reachability is **forward graph traversal** from the entry set, along a
specific subset of edge categories.

### 3.1 Edges that propagate liveness

| Edge category | Direction        | Reason                                                          |
|---------------|------------------|------------------------------------------------------------------|
| `call`        | source → target  | Caller calls callee; callee is reached.                          |
| `import`      | source → target  | A module that imports another causes the imported module to load and evaluate. Imported names are reachable in principle. |
| `type-flow`   | source → target  | A value flowing into a function argument can keep the receiving function live (the call edge typically already covers it, but `type-flow` covers higher-order patterns where the call edge attaches to the wrapper). |
| `http-route`  | source → target  | A route function points at its route literal expression; the literal is itself a leaf and trivially live. The route function is the entry, so this edge isn't strictly needed for liveness, but we walk it to mark the literal explicitly. |

`db-*`, `env-read`, `fs-*`, `network`, `exec` edges all point at
`expression` leaves and are walked for completeness, but their targets
are leaves with no outgoing edges, so they don't extend the live set.

### 3.2 Edges that do *not* propagate liveness

- Reverse edges. We don't say "X is live, so its callers are live" — that
  would mark the universe.
- Edges with `attributes.unresolved == true`. The IR marks an edge as
  unresolved when the analyzer could not statically resolve the callee
  (dynamic dispatch, `eval`, computed member access). Walking these would
  let one unresolved hub keep the whole repo alive. Instead they are
  recorded and surfaced via the false-positive heuristic in §4.
- Edges whose `category` is not in §3.1.

### 3.3 Containment: parent and child liveness

Liveness propagates *downward* through containment but not upward:

- A live `function` keeps every `expression` inside it live (its
  expression children are part of the function body).
- A live `expression` does **not** keep its parent function live —
  the parent is live by some other chain or it isn't.
- A live `function` keeps its parent `type` live (you can't have a live
  method on a dead class).
- A live `type` keeps its parent `module` live.
- A live `module` keeps its parent `service` live.
- The reverse — a live `module` does *not* automatically keep all its
  functions live. That's the entire point: a live file may contain dead
  functions.

### 3.4 The traversal

Standard BFS/DFS, no surprises. Time complexity is `O(V + E)` over the
edges in §3.1, which in practice is dominated by `call` edges and is well
under 100ms on repos up to ~500k nodes (see `research/perf-budget.md` —
not yet written, but this is the budget).

---

## 4. False positives

The honest part. Static reachability is **unsound** in any language
that has dynamic dispatch, reflection, eval, FFI, or string-based
imports — i.e., every language the user is likely to use. Our policy:

> When in doubt, do not mark dead. Mark *probably-dead* and surface the
> reason. The user decides.

### 4.1 Dynamic dispatch via dictionary lookup

```ts
const handlers = { ping: ping, pong: pong };
handlers[name]();
```

The IR has no `call` edge from `handlers[name]()` to `ping` or `pong`.
A naïve reachability pass deletes both. We mitigate via the **string-name
heuristic** (§4.4).

### 4.2 Reflection / metaprogramming

Java `Class.forName(...)`, Python `getattr(obj, name)`, JS
`Reflect.get(obj, name)`, Rust `inventory::iter`, Go's `reflect` package.
The analyzer cannot resolve these in general. Affected nodes show up as
unresolved sites; the heuristic in §4.4 covers most common patterns.

### 4.3 Eval-style

`eval(...)`, `new Function(...)`, Python `exec`, Erlang `apply/3` with a
string. We treat the call site as unresolved; downstream symbols rely on
the heuristic.

### 4.4 The string-name heuristic

> If a `function` node's `symbol.name` appears as a substring of any
> string literal anywhere in the IR (across all modules), treat it as
> **probably-live** instead of dead. Emit a warning showing the literal
> location.

This catches:

- Dictionary lookup (`{ "runJob": runJob }`).
- Decorator-driven registration (`@register("nightly")` paired with a
  function called `nightly`).
- Config-driven dispatch (`config.handler === "nightly"`).
- `bind` / event-name strings (`emitter.on("ping", ping)`).

Implementation: during IR build, every `expression` of leaf flavor
`literal` with `kind: string` contributes its string to a corpus. After
reachability finishes, for each candidate-dead `function` node, we
substring-search the corpus for the function's bare name. A hit
*demotes* the node from "definitively dead" to "probably dead"
(§6 tier 2) but does **not** make it live for reachability purposes —
no edges are added to the IR.

#### 4.4.1 Why a substring search and not a whole-word match

Languages disagree on what "the name" looks like in a string. Python
might have `"my_module:run_job"`. JS might have `"runJob"`. Go might
have `"package.Function"`. Whole-word match across all of these is
brittle and produces false-*negatives* (we miss real evidence and mark
something dead). Substring is the conservative choice.

#### 4.4.2 Limits and known false-positives of the heuristic

- **Common short names** (`get`, `do`, `run`, `init`, `main`) match
  almost any non-trivial codebase's string literals. We keep a **stop
  list** of names ≤ 3 chars and a small list of common verbs. Functions
  named on the stop list bypass the heuristic — they're either dead or
  not based on graph reachability alone, and the user can mark them as
  entries if needed. This is documented in the report.
- **Generated docs / OpenAPI files** that include every function name
  as part of an embedded schema will keep the entire codebase
  "probably-live". We exclude `*.json`, `*.yaml`, `*.openapi.*` files
  from the literal corpus by default; the user can override via
  `dead.literalCorpusIgnore` in config (§5.4).
- **Coincidental collisions**: a function `parse` collides with the
  string `"parser"`. The heuristic flags it probably-live; the user
  ignores or mutes. We accept this — false-negative-of-deadness beats
  false-positive-of-deadness.
- The heuristic does not cover **renaming** through transformations
  (`fnName.replace(/Run/, "Exec") + "Job"`). Anything with computed
  string assembly is genuinely outside static reach. We recommend the
  user add an explicit entry-point `include`.

#### 4.4.3 Estimated false-positive rate

We have not yet run the heuristic across a corpus, so the numbers below
are *targets* to be validated, not measurements. Benchmark plan in
`research/dead-code-eval.md` (not yet written).

| Tier (§6)            | Target false-positive rate                              |
|----------------------|---------------------------------------------------------|
| Definitively dead    | < 1% (i.e., truly-live code marked dead < 1 per 100)    |
| Probably dead        | ~10–25% — by construction this tier is uncertain        |
| Unused export        | Not a false-positive question (correct by definition)   |

We intentionally accept a higher false-positive rate at "probably dead"
because the *intent* of that tier is "look at this, it might be dead",
not "delete this".

### 4.5 Things we explicitly do not handle

- **Dynamic imports with computed paths**: `import(\`./plugins/${name}\`)`.
  The IR records an unresolved import edge. The string-name heuristic
  on the *file path* helps — if the file `plugins/foo.ts` exists and
  `"foo"` appears in literals, we treat the module as probably-live —
  but we make no guarantees.
- **Cross-repo callers**: a function in this repo called only by another
  repo (a microservice we can see, but its caller lives elsewhere). The
  user must declare `entryPoints.include kind: export` for these. We
  surface a hint in the report when a function is exported but never
  imported internally and the package is not published (no `publish`
  metadata) — that's exactly the cross-repo case.
- **JSON-RPC / GraphQL string method names** that don't show up as
  literals because they're stored in a separate JSON file. The user
  loads such files as part of `dead.literalCorpusInclude`.

---

## 5. Reporting modes

### 5.1 CLI

```
codegraph dead [--strict] [--ignore-pattern GLOB ...]
               [--format text|json|sarif] [--include-tier TIER ...]
```

| Flag                    | Effect                                                                          |
|-------------------------|---------------------------------------------------------------------------------|
| `--strict`              | Exit non-zero (code 2) if any node is in tier 1 or tier 2. Default exits 0.    |
| `--ignore-pattern`      | Glob applied to module path; matched nodes are filtered from the report.       |
| `--format text`         | Default. Human-readable, grouped by module.                                    |
| `--format json`         | `.codegraph/dead.json` — programmatic consumption.                             |
| `--format sarif`        | SARIF 2.1.0 — for editor integrations and CodeQL-style consumers.              |
| `--include-tier`        | Repeatable. Show only listed tiers. Tiers: `dead`, `probably-dead`, `unused-export`. Default: all three. |

Default behavior (no `--strict`) prints the report and exits 0 — dead
code is information, not failure, until the team opts in.

### 5.2 Viewer overlay

The React Flow viewer adds a "Dead code" toggle in the legend (already
present in the wireframes; see `design/viewer-overlay.md` — TBD). When
on:

- Tier 1 nodes (definitively dead): solid red outline, 30% opacity, no
  hover tooltip enrichment.
- Tier 2 nodes (probably dead): dashed orange outline, 60% opacity,
  hover shows the literal that demoted them.
- Tier 3 nodes (unused export): blue outline, full opacity, tooltip
  shows "Exported, no internal use — public API?".
- Edges into a dead node from a live node (shouldn't exist by
  construction, but can in edge cases): rendered with a warning glyph
  rather than dimmed. Their existence indicates a bug in detection
  rather than dead code.

The overlay reads `.codegraph/dead.json`, not a separate IR field —
keeping the IR free of liveness annotations.

### 5.3 Action / PR

`packages/action` runs `codegraph dead --format sarif` on the PR's
build and on the base branch's build. The diff between the two SARIF
results yields a "newly introduced dead code" set, posted as a PR
comment in the standard codegraph review format (see
`design/diff-action.md` — TBD):

```
## codegraph: dead code

This PR adds 3 newly-dead functions:

- `packages/api/src/util/legacy.ts#oldHelper`        (definitively dead)
- `packages/api/src/util/legacy.ts#oldHelper2`       (definitively dead)
- `packages/web/src/lib/format.ts#formatDateLegacy`  (probably dead — name appears in `web/src/types.ts` as a string literal)

This PR removes 1 dead function (good): …

[ View in viewer ]
```

A node already dead on the base branch and still dead on the head
branch is *not* reported (it's not the PR's fault). The user can run
`codegraph dead` locally to see the full list.

### 5.4 Config

```yaml
dead:
  enabled: true                          # default true; set false to skip the analysis entirely
  failOn: ["dead"]                       # tiers that fail --strict / the Action
                                         # any of: "dead" "probably-dead" "unused-export"
  ignore:
    - "packages/legacy/**"               # never report dead in legacy/
    - "**/*.generated.*"
  literalCorpusInclude:
    - "config/methods.json"              # add files to the string-name heuristic corpus
  literalCorpusIgnore:
    - "**/*.openapi.json"                # exclude these from the corpus
  shortNameStopList:                      # extend the default stop list
    - "do"
    - "go"
  treatTestsAsLive: true                 # default; set false to find functions used only by tests
```

`failOn` is the only knob that turns "dead code" into a CI failure. A
team that wants the ratchet pattern (no *new* dead code, but tolerates
existing) leaves `failOn` empty and uses the Action's diff-only mode
instead.

---

## 6. Tiers of deadness

| Tier | Name                | Definition                                                                                                       | Default report color | Default `--strict`? |
|------|---------------------|------------------------------------------------------------------------------------------------------------------|----------------------|---------------------|
| 1    | Definitively dead   | Not reachable from any entry, AND the function name does not appear as a substring of any string literal in the corpus, AND the node is not on the short-name stop list. | red                  | yes (in `failOn`)   |
| 2    | Probably dead       | Not reachable from any entry, but its name appears in a string literal somewhere (or it's on the stop list and we declined to evaluate). | orange               | configurable        |
| 3    | Unused export       | Reachable as an entry (because it's exported), but no *internal* call/import edge points at it. May be intended as part of a public API. | blue                 | configurable        |

Tier 3 is fundamentally different from tiers 1 and 2: tier 3 nodes are
*reachable*, just only via the "library export" gate. We treat them as
their own report category because they're the most common false-positive
of "dead": exported helpers in `index.ts` of a published package are
intentionally exported even before any consumer exists.

A node is in **at most one** tier. Tier assignment is computed in this
order: live? → tier 3 if exported-but-unused-internally → else tier 2
if name in literal corpus → else tier 1.

### 6.1 Subtiers / hints (informational, not blocking)

The report attaches non-blocking hints to nodes:

- `test-only`: live, but its only callers are inside test modules
  (using the `test` entry-kind tagging from §1.1). Useful for finding
  helpers that should move into the test directory.
- `framework-only`: live only because of a framework adapter's
  `framework-page` or `http-route` edge — i.e., remove the framework
  registration and it'd be dead. Not actionable on its own; it's
  context for the user when they're considering changing routes.
- `cycle-only`: in a strongly-connected component of the call graph
  with no in-edge from the entry set. The component as a whole is
  dead, but each node has a (mutual) caller. The report names the
  component, not just the nodes, to avoid an explosion of individual
  findings. Detection: post-reachability, run Tarjan's on the
  unreached set, group by SCC.

---

## 7. Diff integration

The PR check runs the full pipeline on both base and head, then takes
the **set difference**:

```
new_dead   = head.dead   \ base.dead
fixed_dead = base.dead   \ head.dead
```

Identity is by node `id`, which (see `ir-schema.md` §6) is signature-
based. A function moved between files keeps its name and parent type;
its `id` changes only if its module path changes — which means the
diff *will* see the move as a delete + add, but those will appear in
both base and head reports, cancelling out under set difference. Good.

A function whose body changed but whose signature didn't keeps its
`id` and is not double-counted. Also good.

**Edge cases.**

- An entry-point added in this PR (e.g., a new `http-route` adapter
  picks it up) makes a previously-dead function live. That node leaves
  `dead`; it does *not* show in `new_dead` or `fixed_dead` if the node
  wasn't in `base.dead` either. If it was in `base.dead`, it appears
  in `fixed_dead` — a positive-light "this PR fixes dead code". Good.
- An entry-point removed in this PR makes previously-live functions
  appear in `new_dead`. The report **groups** these under "Dead because
  entry point removed: `<entry id>`" so the cause is visible. Without
  that grouping a single removed `app.get("/foo", foo)` would look
  like "PR adds 30 dead functions".
- A new node that's dead on arrival is `new_dead` of tier 1 or 2 — the
  exact thing we want to flag.

The Action's default `failOn` applies to `new_dead` only, not to the
total. Existing dead code never blocks a PR unless the user explicitly
opts into a stricter policy.

---

## 8. Algorithm — pseudocode

```text
function detectDeadCode(ir, config) -> Report:

    # ---------- 1. Gather entries ----------
    entries = []
    for each adapter in ir.metadata.generators:
        entries += adapter.entryPoints(ir)        # auto-detected
    for each include in config.entryPoints.include:
        ref = resolveInclude(ir, include)
        if ref is null:
            diagnostics.warn("entry point not resolved", include)
            continue
        entries += ref
    for each excl in config.entryPoints.exclude:
        entries = entries.filter(e => not matchesExclude(e, excl))

    # ---------- 2. Forward reachability ----------
    live = new Set<NodeId>
    queue = new Queue<NodeId>
    for each e in entries:
        live.add(e.nodeId)
        queue.push(e.nodeId)

    while queue not empty:
        n = queue.pop()
        # propagate downward through containment
        for each child of n:
            if child not in live:
                live.add(child); queue.push(child)
        # propagate along live-bearing edges
        for each edge in ir.edges where edge.source == n:
            if edge.category not in {call, import, type-flow, http-route}:
                continue
            if edge.attributes.unresolved == true:
                unresolvedSites.add(edge); continue
            if edge.target not in live:
                live.add(edge.target); queue.push(edge.target)

    # ---------- 3. Candidate dead set ----------
    candidates = []
    for each node in ir.nodes:
        if node.tier != "function": continue       # we report only functions/methods
        if node.id in live: continue
        candidates.push(node)

    # ---------- 4. Build literal corpus for the heuristic ----------
    corpus = ""                                    # one giant searchable buffer
    for each node in ir.nodes:
        if node.tier == "expression"
           and node.leaf?.flavor == "literal"
           and node.leaf.kind == "string"
           and not config.dead.literalCorpusIgnore.matches(node.module):
            corpus += "\0" + node.leaf.value      # NUL-separated for safety
    for each path in config.dead.literalCorpusInclude:
        corpus += "\0" + readFile(path)

    # ---------- 5. Tier assignment ----------
    report = []
    for each node in candidates:
        if isExportedFromPublishedPackage(node, ir):
            tier = "unused-export"                 # tier 3
        else:
            name = node.symbol.name
            if name.length <= 3 or name in config.dead.shortNameStopList:
                tier = "dead"                      # heuristic skipped
            elif corpus.contains(name):
                tier = "probably-dead"             # tier 2
            else:
                tier = "dead"                      # tier 1
        if config.dead.ignore.matches(node.module): continue
        report.push({ node, tier, hints: computeHints(node, live, ir) })

    # ---------- 6. SCC collapsing ----------
    sccs = tarjan(restrictGraph(ir, candidates))
    for each scc with size > 1:
        annotate report rows for nodes in scc with hint "cycle-only" and shared groupId

    return Report(entries, report, diagnostics)


function computeHints(node, live, ir):
    hints = []
    callers = ir.edges.filter(e => e.category == "call" and e.target == node.id)
    if callers.every(c => isInTestModule(c.source)):
        hints.push("test-only")
    if callers.every(c => fromFrameworkAdapter(c)):
        hints.push("framework-only")
    return hints
```

Notes on the pseudocode:

- The traversal is the textbook BFS; the design effort is in steps 1
  (entries), 4 (corpus), and 5 (tiering). All three are pure functions
  of (IR, config) — the whole pipeline is reproducible and cacheable
  on `(ir.contentHash, config.contentHash)`.
- `isExportedFromPublishedPackage` checks the *containing package's*
  `package.json` for a `name` that doesn't start with `@private/` and
  for the absence of `"private": true`. It's a fast file-system lookup,
  not graph traversal.
- `tarjan` is over a *restricted* call graph (only the candidate-dead
  nodes and the `call` edges among them). Restricting it keeps the
  pass cheap even on large repos.

---

## 9. Open questions & limits

- **Macros.** Rust `macro_rules!` and proc macros can synthesize whole
  functions at compile time. The IR records the post-expansion source
  via `rust-analyzer`-style indexing where available; otherwise the
  generated functions don't exist in the IR and can't be marked dead
  — fine. But if a macro *invokes* a function by name, we may not see
  the call edge. Mitigation: macro names participate in the literal
  corpus (every macro invocation site is captured as a string-flavored
  expression). Not yet validated.
- **Generics / monomorphization.** A generic function with no resolved
  monomorphizations on the head branch *is* dead — that's the right
  answer. But analyzers differ in whether they emit a single
  generic-function node or one per monomorphization. Spec position:
  one node per generic, with `valueType` info on edges. Reachability
  is on the generic node. (See `ir-schema.md` §4.2.)
- **Conditional compilation.** `#[cfg(target_os = "linux")]` blocks
  produce nodes the analyzer may or may not see depending on the
  active config. We document that codegraph analyzes "the IR for the
  default build configuration" — the user's responsibility to run it
  again under other configs if they want coverage.
- **Plugin / DI containers.** Spring `@Bean`, NestJS DI, etc. The
  adapter for that framework MUST emit `call` edges from the
  registration to the bean factory, otherwise every bean class is
  dead. We will not paper over missing adapter coverage with a
  heuristic — bad adapter coverage is a bug to fix in the adapter.

---

## 10. Out of scope (for v0.1)

- **Auto-fix / auto-delete.** We never write code. A future
  `codegraph dead --apply` could pipe into an LLM-driven refactorer,
  but that's a separate (non-OSS, non-MIT) tool, and explicitly outside
  this project's "no LLM" promise.
- **Coverage-based liveness.** We don't merge runtime coverage with
  static reachability. They answer different questions; combining them
  belongs in the user's reporting layer, not in `codegraph`.
- **Cross-repo reachability.** As noted in §4.5: declare the boundary
  with `entryPoints.include kind: export` and live with the imprecision.

---

## 11. Glossary

- **Entry point.** A node from which reachability traversal begins.
- **Reachable / live.** A node found by forward traversal from any
  entry along edges in §3.1.
- **Candidate dead.** A `function` node not in the live set.
- **Definitively dead (tier 1).** Candidate dead, name not in literal
  corpus, not on short-name stop list.
- **Probably dead (tier 2).** Candidate dead, name appears in literal
  corpus.
- **Unused export (tier 3).** Reachable only because the node is an
  exported public symbol; no internal callers.
- **Literal corpus.** The concatenation of every string-literal value
  in the IR plus user-specified extra files; searched for function
  names by the heuristic in §4.4.
- **Stop list.** Function names short or generic enough that the
  heuristic produces too many matches; bypassed (treated as tier 1
  candidates by reachability alone).
