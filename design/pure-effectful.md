# Pure vs Effectful Node Coloring

Status: design (v0.1)
Owner: codegraph core
Audience: contributors implementing the analyzer + renderer

This document specifies how codegraph classifies every function/method node in
the call graph as either **pure** or **effectful**, how that classification is
displayed, and how the user navigates by it. This is codegraph's headline
differentiator: every other static call-graph tool draws structure; we draw
*consequence*.

---

## 1. Why this matters

Three concrete user workflows justify the entire feature:

1. **Security review.** "Show me every path from any HTTP handler to a
   `db-write` or `exec`." If the classification is correct, the answer is a
   subgraph; if it is wrong, the answer is a false sense of safety. This is the
   single highest-value query codegraph supports.
2. **Refactoring confidence.** "Is this subtree safe to extract into another
   package / move across a process boundary / memoize?" The pure subgraph is, by
   construction, free of hidden coupling: no DB row referenced by id, no log
   line some operator greps for, no file someone tails. Pure code can be moved.
3. **Reasoning / onboarding.** New engineers ask "where does this app actually
   *do* anything?" The effect surface area — the set of impure leaves — is
   typically <10% of nodes in a healthy codebase. Highlighting it reduces a
   100k-LOC service to a readable map.

The coloring is therefore not decorative. It is the primary signal in the view.

---

## 2. Effect taxonomy

Every effect a function can have is one of the following nine **effect kinds**.
The list is closed: adapters MUST map every flagged sink onto exactly one of
these. Adding a tenth kind requires a spec change because palette, priority,
and filter UI all enumerate them.

| Kind             | Read/Write | Examples (illustrative)                              |
|------------------|------------|------------------------------------------------------|
| `exec`           | write      | `child_process.exec`, `os/exec.Command`, `eval`      |
| `fs-write`       | write      | `fs.writeFile`, `os.WriteFile`, `fs.unlink`          |
| `db-write`       | write      | `prisma.user.create`, `INSERT`, `UPDATE`, `DELETE`   |
| `network`        | both       | `fetch`, `http.get`, `axios.post`, gRPC client calls |
| `log`            | write      | `console.log`, `logger.info`, `slog.Info`            |
| `db-read`        | read       | `prisma.user.findFirst`, `SELECT`                    |
| `fs-read`        | read       | `fs.readFile`, `os.ReadFile`, `fs.stat`              |
| `mutation-of-arg`| write      | mutating a parameter the caller still holds          |
| `throw`          | both*      | `throw new Error(...)`; `panic`; explicit raise      |

*`throw` is special. It is not a sink in the I/O sense, but it is observable to
callers and breaks referential transparency. We classify it as an effect so
that "is this function pure?" has the answer most engineers actually expect:
"no, it can blow up." A function whose only effect is `throw` is rendered with
a distinct hatching (see §5) so the user can opt to treat throw-only functions
as "pure-ish" via a global toggle.

### 2.1 Read effects vs write effects

The split matters because the security and refactoring queries care about
writes far more than reads. Concretely:

- A function that only reads (`db-read`, `fs-read`, plus network GETs flagged
  by an adapter as read-only — see §7.2) is **observably impure** but cannot
  *change the world*. It is unsafe to memoize across process restarts but safe
  to retry, safe to call in a dry-run.
- A function that writes can change the world. Caching it is a correctness
  bug. Calling it in a dry-run is a bug.

The renderer therefore treats reads and writes as two tiers within "impure"
(see §5.2). The "show only effectful path to selected node" toggle (§6) has a
sub-toggle: *writes only*.

### 2.2 What is *not* an effect

To keep the classification useful, the following are explicitly **not** effects
in this taxonomy (and so do not impurify a function on their own):

- Allocating memory, including large allocations. (Real but uniform.)
- Reading from a parameter or closed-over constant.
- Time. Reading the clock is a `fs-read`-class effect *only* if an adapter
  flags it (see §7); by default `Date.now()` and friends do not impurify. This
  is a deliberate choice: flagging time globally would paint half the codebase
  orange and devalue the signal. Users who want strict purity can enable the
  `strict-time` ruleset which adds a `time` adapter mapping `Date.now`,
  `performance.now`, `time.Now`, etc. to a synthetic `clock` effect.
- Random. Same reasoning as time; opt-in via `strict-random`.
- `console.debug` when the `log.debug-is-pure` flag is on (off by default).

Everything not in §2 and not flagged by an adapter is treated as a normal,
pure function call. This is the right default: the long tail of stdlib helpers
(`Array.prototype.map`, `strings.TrimSpace`, …) are all pure and should not
need any annotation.

---

## 3. Purity computation

Purity is a **bottom-up fixed point** over the call graph, with one wrinkle
for cycles. The algorithm:

```
effects(f) :=
    direct_effects(f)                     // §3.1
  ∪ ⋃ { effects(g) | f calls g }          // §3.2
  ∪ adapter_flags(f)                      // §7

pure(f) := effects(f) == ∅
```

`direct_effects(f)` is computed by the language adapter walking the AST of
`f`'s body once: it sees `throw`, parameter mutation, etc. Adapter-flagged
sinks (§7) are added at the same time.

The set `effects(f)` is a bitset over the nine kinds in §2. Union is bitwise
OR. Equality is bitset equality. This makes the per-call-site work O(1) bitset
ops, and the whole pass O(V + E) over the call graph.

### 3.1 Direct effects of `f`

Computed structurally from `f`'s body:

- Any `throw` / `panic` / `raise` statement reachable from the body (without
  being caught inside `f` itself; see §3.5) → `throw`.
- Assignment to `param.x`, `param[i]`, or any path rooted in a parameter that
  the language considers a reference type → `mutation-of-arg`.
- Calls to functions matching an adapter sink rule (§7) → that effect kind.
- Calls to other functions in the graph — handled in §3.2.

Note that direct effects do **not** include calls to other in-graph functions:
those propagate via the bottom-up pass.

### 3.2 Propagation

Bottom-up over the SCC-condensed call graph:

1. Build the call graph V, E from the language adapter.
2. Compute strongly connected components (Tarjan).
3. Topological order on the condensation (leaves first).
4. For each SCC in order, compute the union of direct effects of every member
   plus the already-computed effects of every successor SCC. Assign that union
   to every member of the SCC. This is the cycle wrinkle: members of a cycle
   share their effect set, because by definition they can each reach the
   others, so they are equipotent w.r.t. effects.
5. After the pass, every node has an `effects` bitset and `pure` is just
   `effects == 0`.

This is a straightforward Kildall-style fixed point on a finite lattice
(bitsets of nine bits, partial order = subset), monotone, height ≤ 9, so it
converges in ≤ 9 sweeps even without the SCC condensation. The SCC pass is for
performance and determinism, not correctness.

### 3.3 Caching

Per node, codegraph stores:

```
NodeEffects {
  direct:        Bitset9     // §3.1, depends only on f's body + adapter rules
  transitive:    Bitset9     // §3.2 result
  contentHash:   u64         // hash of f's AST + adapter rule version
  edgeHash:      u64         // hash of {callee_id} ⊕ each callee's transitive
}
```

`direct` is invalidated when `contentHash` changes. `transitive` is invalidated
when either `direct` changes or any callee's `transitive` changes (which is
detected via `edgeHash`). On a cold build we compute everything; on a warm
build we re-walk only files whose source changed, recompute `direct` for
functions in those files, recompute `edgeHash` for any function whose callee
list changed, and propagate.

This is the same shape as a memoized topological recompute. The important
property: if a leaf function changes from pure to `db-write`, every transitive
caller must be re-evaluated — but only those callers, not the whole graph.
The propagation cost is O(reverse-reachable set of the changed nodes).

### 3.4 Incremental recompute

On file change:

1. Re-parse changed files; compute `direct` for each function in them.
2. For each function whose `direct` changed, mark its `transitive` dirty.
3. Walk reverse-edges (callers) BFS, marking `transitive` dirty until we hit
   a function whose recomputed `transitive` equals its old value (early-out:
   the caller's color cannot have changed, so its callers don't need to
   recompute either).
4. Emit a re-render event listing the nodes whose color changed.

Adapter rule changes are treated as "every function in the affected language
has dirty `direct`". This is rare (adapter version bump) and worth the full
sweep.

### 3.5 try/catch

A `throw` caught inside `f` does **not** contribute `throw` to `f`'s effects
*if* the catch is total (no rethrow, no throwing handler). Adapters MUST
implement this conservatively: if any catch branch can itself throw, or if the
catch is restricted by type and the raised type is not provably narrower, the
`throw` effect propagates. Better to over-color than to under-color.

---

## 4. Multi-effect nodes

A function commonly does several things — write to the DB *and* call an
external service *and* log. The renderer must pick one color per node, so we
define a **dominant effect** by priority:

```
exec  >  fs-write  >  db-write  >  network  >  log  >  db-read  >  fs-read
```

(`mutation-of-arg` and `throw` are not in this ordering — see below.)

The ordering is by *severity*, where severity is roughly "blast radius if this
function is called by mistake":

- `exec` is at the top: arbitrary code execution dominates everything else.
- File and DB *writes* sit above network because a write to local state is
  almost never what the user wants when a function looks pure.
- `network` (which includes both writes and reads at the protocol level) sits
  above `log` because it can mutate remote systems.
- `log` is above the read effects because logs are persistent in practice
  (operators grep them) and create coupling.
- `db-read` above `fs-read` is mostly aesthetic — DB reads are usually more
  semantically meaningful and more interesting to the user.

`mutation-of-arg` and `throw` are **modifiers**, not dominant kinds. A node's
dominant color is chosen from the list above; if `mutation-of-arg` or `throw`
is present, it is added as a small icon overlay regardless. A function whose
*only* effects are `mutation-of-arg` and/or `throw` is colored as
`mutation-of-arg` (treated as a synthetic write at the bottom of the ordering)
or, if only `throw`, with the throw-hatching pattern (§5).

### 4.1 Secondary effects as icons

Every effect a node has, *other than* its dominant one, renders as a small
monochrome glyph in a strip along the bottom edge of the node:

```
     ┌──────────────────────────────┐
     │  createInvoice               │   <-- node label
     │  ──────────────────────────  │
     │  pkg/billing/invoice.ts:42   │   <-- location
     │                              │
     │  [DB W]      ⓛ ⓝ ⓣ           │   <-- dominant tag, then 2nd-effect icons
     └──────────────────────────────┘
        ^             ^ ^ ^
        |             | | └ throw
        |             | └── network
        |             └──── log
        └─ dominant: db-write (color of node fill)
```

Icons (single-glyph mnemonic):

- `ⓔ` exec
- `ⓦ` fs-write
- `ⓓ` db-write
- `ⓝ` network
- `ⓛ` log
- `ⓡ` db-read
- `ⓕ` fs-read
- `ⓜ` mutation-of-arg
- `ⓣ` throw

The dominant effect's icon is omitted from the strip (it's already the fill
color and the tag).

### 4.2 Severity within a kind

Within the *impure* tier, the dominant effect determines the *hue position* on
the gradient (see §5.2). Multi-effect nodes are not "more red" than
single-effect nodes of the same dominant kind; the icon strip is the only cue
that a node has secondary effects. This avoids a combinatorial palette and
keeps the visual primary signal one-dimensional.

---

## 5. Visual scheme

Two palettes ship: **default** and **colorblind-friendly** (deuteranopia +
protanopia tested). User picks per-workspace; the choice is persisted in
`.codegraph/ui.json`.

### 5.1 Pure node

- Fill: soft gray-green, default `#D7E4D2`, CB-safe `#D6DCE4` (a cool
  desaturated slate — the CB palette de-emphasizes the green/red axis
  entirely; pure is "calm cool", impure is "warm yellow→amber").
- Border: 1px, 20% darker than fill.
- Text: near-black `#1A1F1A`.
- No icon strip.
- Hover tooltip: `pure` and the reason, e.g. "no transitive sink", or
  "annotated `// codegraph: pure`".

The pure color is intentionally low-saturation so that *the eye is not drawn
to it*. Pure code is the boring background; impure code is the foreground.

### 5.2 Impure nodes — gradient by dominant effect

Default palette, ordered by severity (top of the priority list = most intense):

| Dominant     | Default fill | CB-safe fill |
|--------------|-------------:|-------------:|
| `exec`       | `#7A1F1F` (deep red)     | `#5B2A86` (deep violet) |
| `fs-write`   | `#B23A2A` (red)          | `#8E44AD` (violet)      |
| `db-write`   | `#D9542B` (red-orange)   | `#C77DFF` (light violet)|
| `network`    | `#E68A2E` (orange)       | `#E8B33A` (gold)        |
| `log`        | `#E8B33A` (amber)        | `#F2D17B` (pale gold)   |
| `db-read`    | `#E8C77A` (pale amber)   | `#D8D8B0` (pale khaki)  |
| `fs-read`    | `#EFD9A6` (sand)         | `#E5E5C8` (paler khaki) |
| `mut-of-arg` | `#C7A26B` (muted ochre)  | `#B8AE85` (muted khaki) |

Border:
- For dominant kinds in `{exec, fs-write, db-write}`: 2px solid border, color
  20% darker than fill. These are the "danger" tier; the heavier border makes
  them pop even at zoomed-out levels.
- All other impure: 1px border same as pure.

Throw-only: not colored from the table. Rendered with a *hatched* pure-fill:
soft gray-green (or CB slate) with diagonal lines at 45°, spaced 4px. Visible
at full zoom; collapses to flat pure color at far zoom levels (we read a
throw-only function as "basically pure" from a kilometer up, which is the
right intuition).

### 5.3 Edges

Edge color follows the *callee*'s dominant effect, not the caller. Rationale:
the edge's importance is "what does crossing this edge get me into." A pure
caller→impure callee edge is an effect *boundary* — and boundaries are
exactly what the security and refactoring views want to highlight. We render
those boundary edges 1px thicker and with a small filled arrow head; pure→pure
and impure→impure edges get a 1px line with an open arrow head.

### 5.4 Zoom levels

- Far zoom (whole graph): only pure vs not-pure is distinguishable. Pure nodes
  collapse to a single pixel-cluster; impure nodes keep their dominant hue but
  no labels, no icon strip.
- Mid zoom (package level): dominant hue plus a one-letter tag (`E`, `W`, `D`,
  `N`, `L`, `R`, `F`, `M`).
- Full zoom (function level): full node card with label, location, dominant
  tag, and icon strip.

The colorblind palette is checked at every zoom level — at far zoom the only
signal is hue, so the CB palette intentionally maps the three "danger" tier
effects to violet (vs gold for everything else) so a deuteranope still sees a
clean two-class distinction at distance.

---

## 6. Toggles

Two top-level filter modes plus a couple of refinements. Both modes are
*subgraph dim*, not *subgraph hide*: nodes outside the selected set are
rendered at 15% opacity with no labels, edges at 8%. This preserves spatial
memory — the user does not lose where a node was when they toggle filters on
and off.

### 6.1 "Effectful path to selected node"

User selects a node `n`. Toggle on: highlight every node `m` such that there
exists a path from `m` to `n` *and that path passes through at least one
impure node*, plus `n` itself if it is impure. Pure side-paths fade. This
answers: *what side-effectful code can influence the value/behavior at this
node?*

Sub-toggle: **writes only** — restrict the impure-node requirement on the
path to nodes whose effects intersect the write set
`{exec, fs-write, db-write, network*, log, mutation-of-arg}`.
(`network` is included because at the protocol level we cannot tell GET from
POST without an adapter hint; see §7.2 for adapters that split it.)

ASCII mockup of this view (mid zoom, tag-only labels):

```
 codegraph — pkg/billing  [highlight effectful path to: createInvoice]   ▣ writes only

   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
   │  parseAmount │ ──────▶ │  validateLine│ ──────▶ │  formatLines │     pure (faded)
   │      [ ]     │         │      [ ]     │         │      [ ]     │
   └──────────────┘         └──────────────┘         └──────────────┘
                                                              │
                                                              ▼
                            ┌──────────────┐         ┌──────────────┐
                            │ loadCustomer │ ──────▶ │ chargeCard   │
                            │      [R]     │ ◀────── │     [N]      │
                            └──────────────┘         └──────────────┘
                                    │                        │
                                    └────────┐    ┌──────────┘
                                             ▼    ▼
                                       ┌──────────────┐
                                       │ createInvoice│  ◀── selected
                                       │     [D]      │
                                       └──────────────┘

   Legend:  [ ]=pure  [R]=db-read  [N]=network  [D]=db-write   (·) faded = filtered out
```

The pure trio at the top fades because they don't sit on any
through-an-impure-node path to `createInvoice`. The `network` and `db-read`
nodes stay full-opacity because they are themselves impure and reach the
selection. With the **writes only** sub-toggle on, `loadCustomer` (`db-read`)
would also fade — only `chargeCard` (`network`) and `createInvoice` itself
would remain.

### 6.2 "Show only pure subgraph"

Inverse mode. The pure subgraph (the maximal subgraph induced by pure nodes
only) renders at full opacity; everything else fades. Useful for the
refactoring use case: see what's safely movable.

ASCII mockup, full graph, "show only pure subgraph" enabled:

```
 codegraph — pkg/billing      [show only pure subgraph]              ▣ include throw-only

   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
   │  parseAmount │ ──────▶ │  validateLine│ ──────▶ │  formatLines │
   │      [ ]     │         │      [ ]     │         │      [ ]     │
   └──────────────┘         └──────────────┘         └──────────────┘
           ▲                        ▲
           │                        │
   ┌──────────────┐         ┌──────────────┐
   │  splitTokens │         │  normalizeId │
   │      [ ]     │         │     [/]      │     <-- throw-only, hatched
   └──────────────┘         └──────────────┘

   · · · loadCustomer · · ·  · · chargeCard · ·  · · createInvoice · ·    (faded)

   Legend:  [ ]=pure   [/]=throw-only (treated pure when toggle ▣ on)
```

The `▣ include throw-only` checkbox controls whether `throw`-only functions
count as pure for this view. Off by default (strict pure); on includes them.

### 6.3 Always-on legend

Both views render a one-line legend strip along the bottom of the canvas
listing the dominant-effect colors actually present in the current view. It
updates as the user pans/zooms — no point showing `exec` in the legend if
nothing in view is exec-tagged.

### 6.4 Programmatic equivalent (CLI)

Every UI toggle has a CLI equivalent emitting the same subgraph as JSON:

```
codegraph query --to createInvoice --effectful-path
codegraph query --to createInvoice --effectful-path --writes-only
codegraph query --pure-only
codegraph query --pure-only --include-throw-only
```

This matters because the security workflow ("every path from any HTTP handler
to a `db-write`") is a CI check, not a click target.

---

## 7. Annotations and adapter sinks

The static analyzer cannot always see the truth. Two escape hatches:

### 7.1 Function-level pragma

A function may carry a comment annotation that overrides the computed effect
set. Syntax (language-by-language, but the directive grammar is uniform):

- TypeScript / JavaScript / Go / Rust / Python (`#` form):
  ```
  // codegraph: pure
  // codegraph: effects(db-write, log)
  // codegraph: ignore(log)
  ```
  (Python uses `# codegraph: …`; the rest use `// codegraph: …`. JSDoc
  `@codegraph pure` is also accepted.)

Semantics:

- `pure` — force `effects = ∅`, ignoring direct and transitive computation.
  Use sparingly; this is the user telling codegraph "trust me." Hover tooltip
  shows the annotation and its file:line.
- `effects(<list>)` — force `effects = <list>` exactly, again ignoring
  computed. Use when wrapping a sink that codegraph can't see (e.g. you
  imported a third-party native module and you know it does `fs-write`).
- `ignore(<list>)` — start from computed, then *remove* the listed kinds. Use
  for narrow false-positive removal: "yes I `console.log`, but for this
  workspace logs are pure" → `// codegraph: ignore(log)`. Useful for build
  scripts.

The annotation MUST be on the line immediately preceding the function
declaration, with no blank lines between. Trailing or interleaved annotations
are ignored (warning emitted in `codegraph check`).

A function annotated `pure` whose computed effects are non-empty produces a
**lint warning** ("annotation overrides 3 effects: db-write, log, throw"). The
annotation still wins, but the user gets a heads-up that the override is
load-bearing. The renderer marks annotation-overridden nodes with a small `★`
in the corner and the tooltip explains which annotation, on which line.

A workspace-level `.codegraph/ignore.toml` allows the same overrides by
fully-qualified function name, for cases where you can't or don't want to
modify source (vendored code).

### 7.2 Adapter-flagged sinks

Codegraph adapters (one per language + per major framework) ship a list of
**sink rules**. A sink rule is a pattern matching a call site or a callee
identifier, plus the effect kind to attribute when matched. Examples:

```
# adapters/typescript/prisma.toml
[[sink]]
match = "prisma.<model>.create"        # any model
effect = "db-write"

[[sink]]
match = "prisma.<model>.findFirst"
effect = "db-read"

[[sink]]
match = "prisma.$transaction"
effect = "db-write"                    # transactions can write; conservative

# adapters/typescript/node-fetch.toml
[[sink]]
match = "fetch"
effect = "network"

[[sink]]
match = "fetch"
where = "arg[1].method in {'POST','PUT','PATCH','DELETE'}"
effect = "network"
extra = "write"                         # hint for "writes only" filter
```

The matching language supports:

- Bare identifier (`fetch`).
- Member chain with wildcards (`prisma.<model>.create` — `<...>` matches a
  single segment).
- `where` clauses over statically-decidable arg shape (literal strings,
  literal objects, etc.). When the `where` clause depends on a value
  codegraph cannot evaluate statically, the rule is conservatively applied
  (it matches).

Sink rules are applied during `direct_effects(f)` (§3.1). Crucially, adapters
let us flag a call site as a sink **without seeing the callee's body** —
which is the whole point. `prisma.user.create` is a generated client method
that points into a runtime; we don't trace into it, but the adapter knows
what it does, so the caller is correctly tagged `db-write`.

Adapter precedence:
1. Function-level `pragma` (§7.1).
2. Workspace ignore.toml.
3. Adapter sink rules.
4. Computed direct + transitive (§3).

Adapters are versioned. The adapter version is part of every node's
`contentHash` (§3.3) so an adapter bump correctly invalidates the cache.

### 7.3 Listing the lies

`codegraph annotations` prints every override active in the workspace —
function-level pragmas plus ignore.toml entries — with file:line and the
effects they suppress or assert. Code review hygiene: an `// codegraph: pure`
on a function that talks to a queue is a bug; this command makes them
auditable.

---

## 8. Summary of design choices

- **Closed taxonomy of nine kinds**, severity-ordered for color priority. Adding
  a kind is a spec change, not a config change.
- **Bottom-up bitset fixed point** over SCC condensation, cached per node with
  separate `direct` and `transitive` hashes for cheap incremental.
- **One color per node** (dominant effect), secondary effects as icon strip;
  pure is a single calm color, impure is a severity gradient.
- **Two palettes** (default, colorblind-friendly), checked at all zoom levels;
  pure is intentionally low-saturation so it reads as background.
- **Two toggle modes** (effectful path to selected, pure-only) with subgraph
  *dim* not *hide*, plus a `writes only` refinement on the first and a
  `include throw-only` refinement on the second. Each toggle has a CLI form
  emitting the same subgraph as JSON for CI.
- **Two override mechanisms** (function pragma, ignore.toml) plus
  adapter-flagged sinks that work without callee bodies. Pragmas that
  contradict computation produce a lint warning so the override stays
  visible.

The shipping bar is: a user opens codegraph on an unfamiliar service, picks a
DB-write node, toggles "effectful path to selected — writes only", and reads
the answer to "how does dirty input reach this write" without writing a
query, without reading docs, and without trusting any single annotation more
than the source it sits next to. Everything else in this document serves that
moment.
