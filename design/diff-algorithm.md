# codegraph Graph-Diff Algorithm — Design (v0.1.0)

> Status: design draft.
> Companion specs: `spec/ir-schema.md` (node/edge shape, ID derivation),
> `spec/adapter-interface.md` (analyzer contract). This document defines
> how two IR documents — `base` and `head` — are reduced to a single
> structural diff, suitable for a PR comment, a viewer overlay, and a
> deterministic snapshot in tests.

## 0. Why a graph diff at all

A PR's *graph* delta is more legible than its *line* delta. A 12-line
refactor that introduces a new cross-service network edge to a PII
sink is a blocker; a 400-line whitespace sweep is noise. A textual diff
treats them the same. A graph diff treats them very differently. The
algorithm has to be: stable across runs (byte-identical output), stable
under irrelevant edits (reformatting, parameter renames, file moves),
loud about real change (sinks, cross-service edges, security-sensitive
types), and cheap (`O(|N| + |E|)` with small constants — §9.4).

The IR makes this tractable. §6 of the IR spec already buys us
**signature-based node IDs** and **(srcId, dstId, category, attrs-hash)**
edge identity, both position-independent. Diffing then reduces to
multiset comparison plus a bounded amount of follow-up work.

## 1. Inputs and outputs

### 1.1 Inputs

```ts
diff(base: IR, head: IR, opts?: DiffOptions): GraphDiff
```

`base` and `head` are full IR documents per `spec/ir-schema.md`. Both
must share a major `schemaVersion` (cross-major is a hard error); a
minor mismatch is warned but allowed — unknown enum values compare by
string equality and are correctly treated as "different from anything
in base".

`DiffOptions`:

```ts
interface DiffOptions {
  // Restrict diff to a path-glob subset; see §7.
  scope?: string[];                     // e.g. ["services/payments/**"]

  // Rename detection: off | "structural" | "structural+name".
  // Default "structural". See §4.
  renameDetection?: "off" | "structural" | "structural+name";

  // Severity weights (see §6). Defaults shipped in code; overridable
  // for repos that, e.g., flag a non-default sink as critical.
  severity?: SeverityConfig;

  // Cap on the number of `renamed` hints emitted (per side) to avoid
  // n^2 blow-up on huge churn PRs. Default 50.
  maxRenameHints?: number;
}
```

### 1.2 Output

```ts
interface GraphDiff {
  schemaVersion: "0.1.0";
  base:  { commit: string; generatedAt: string };
  head:  { commit: string; generatedAt: string };
  scope: string[] | null;

  // Mutually-exclusive node buckets.
  addedNodes:    AddedNode[];
  removedNodes:  RemovedNode[];
  changedNodes:  ChangedNode[];        // same id, different IR-level fields

  // Mutually-exclusive edge buckets.
  addedEdges:    AddedEdge[];
  removedEdges:  RemovedEdge[];
  changedEdges:  ChangedEdge[];        // same identity tuple, valueType-only delta

  // Heuristic, non-authoritative. UI shows both nodes; this points users
  // at "this looks like a rename of X". See §4.
  renameHints:   RenameHint[];

  // Stable summary numbers, used by the PR comment template.
  summary: {
    counts:    Record<DiffBucket, number>;
    severity:  Record<"low"|"medium"|"high"|"critical", number>;
    topItems:  ScoredItem[];           // sorted desc by score, capped (default 20)
  };
}
```

Every collection is sorted by a deterministic key (§8). The output is
intended to be checked into snapshot tests.

## 2. Node identity (relies on §6 of `ir-schema.md`)

### 2.1 What identity already gives us

The IR commits to: a node's `id` is `BLAKE3-128` of a tier-specific
canonical signature string. Components per tier:

| Tier         | Components                                                                  |
|--------------|-----------------------------------------------------------------------------|
| `service`    | repo URL + service path                                                     |
| `module`     | parent service id + repo-relative POSIX file path                           |
| `type`       | parent module id + fully-qualified type name                                |
| `function`   | parent id + symbol name + arity + parameter type *displays* + receiver type |
| `expression` | parent function id + role discriminator + canonical payload + occurrence-N  |

Diff-layer consequences: reformatting is invisible (identical IR
modulo `metadata.commit`). Renaming a function changes the id and
shows as remove+add, not "changed" — that matches reviewer intuition
("the import path changed"). Renaming a parameter does *not* change
the id (the signature uses the parameter *type display*, not its
name) — `(req: Request)` and `(r: Request)` collapse. Moving a
function across files changes its id, by design: a file move *is* a
semantic relocation in a multi-package monorepo, otherwise an attacker
could move a payment handler from `services/billing/` to
`services/auth/` and the diff would shrug.

### 2.2 What identity does *not* give us

The id buckets a node into "same/different" but says nothing about
**body equality**. Two functions with the same id can still differ in:

- file path of their parent module *if the module id stayed stable*
  (impossible under §2.1 — module id includes the path — but a future
  schema may relax this);
- line/column ranges (`loc`);
- `pure` flag, `exported` flag, `returnType`, `kind`;
- the *set of edges* incident on them.

These are the things that "changed" detects (§5).

### 2.3 Edge cases

- **Overloads.** Function id includes arity + parameter type displays,
  so two declarations sharing a name but differing in signature get
  distinct ids; `foo("a")` vs. `foo(1, 2)` resolve to two callees.
- **Anonymous functions and lambdas.** No symbol name — the IR
  synthesizes `<anon@N>` where N is the lexical-occurrence index inside
  the parent. Stable across reformatting, distinct per occurrence.
  Adding a new anonymous callback at the top of a function bumps the
  existing one's index by one (a small wave of add/remove). The
  rename-detection fingerprint (§4) is structural, not name-based, so
  these waves are usually paired back as `renameHints`.
- **Generics.** The signature uses the *unspecialized* declaration —
  `function map<T, U>(xs: T[], f: (t:T)=>U): U[]` is one id regardless
  of call sites. Specialization info lives on the call edge's
  `valueType`, so narrowing a generic shows as edge `changed` (good)
  without churning function ids (also good).
- **Re-exports.** Not a new node. Resolution happens in the analyzer;
  the id of the re-exported function is the id of the original. A PR
  that adds a re-export shows only a new `import` edge.
- **Test files.** Modules like any other; opt-out via `opts.scope`
  (§7) for "production" PR comments.
- **Package moves.** Moving a package directory changes the service id
  of every node under it. Deliberate (see §2.1) but loud. Recommendation:
  package renames in a dedicated PR. The action's comment template
  recognizes "all changes are under a single old→new path prefix" and
  collapses them into one "package moved: A → B (N nodes affected)"
  line.

## 3. Edge identity

### 3.1 Identity tuple

Per §4.3 of `ir-schema.md`:

```
edgeKey = (sourceId, targetId, category, attrsHash)
```

where `attrsHash = BLAKE3-128(canonical_attrs_string)` and `attrs` is
the sorted, JSON-canonicalized set of *category-specific* attributes
(e.g. `method` on `http-route`, `role` and `argIndex` on `type-flow`).
**`valueType` is NOT in the identity tuple.** This is the critical
asymmetry that §3.3 exploits: the same edge key can have its
`valueType` change, and we want to surface that as `changed`, not as
remove+add.

Why the rest is keyed in. Two `call` edges between the same pair of
nodes, both into different overloads, would collapse without `attrs` —
but in practice the overloads have different *target* ids already (§2.3),
so attrs only matters for `type-flow` (where `role`/`argIndex`
distinguish the same `(src,dst)` carrying multiple roles) and
`http-route` (where `method` distinguishes `GET /x` vs. `POST /x`).

### 3.2 Add / remove semantics

An edge is **added** iff its `edgeKey` exists in `head` but not in
`base`. **Removed** is the mirror. There is no "moved" edge — moving
means changing source or target, which changes the key.

### 3.3 `changed` edges

An edge is **changed** iff its `edgeKey` is in both `base` and `head`
*and* its `valueType` differs. The change record carries
`{ key, before: valueType, after: valueType }`. We do not consider any
other edge property as triggering `changed` — additional properties are
either part of `attrs` (and thus part of the key, so they trigger
add/remove) or analyzer noise we ignore.

This is the source of the worked example in §10.3 (`string` → `User`).

### 3.4 Edge case: parallel edges with identical keys

By construction the IR de-duplicates these (the `attrsHash` is intended
to make duplicates collapse). If they appear, the diff treats the IR as
a multiset and surfaces the count delta — but since the IR producer
guarantees uniqueness, this is a defense-in-depth path that should
never fire in well-formed input. We log a diagnostic
`duplicate-edge-key` and proceed.

## 4. Rename detection (heuristic, post-hoc)

### 4.1 What we explicitly do NOT do

We do *not* merge a removed and an added node into a single "renamed"
record. That would (a) destroy determinism, (b) hide real concerns
(a renamed function with a changed signature has a different id *and*
different behavior — the reviewer should see both), and (c) conflict
with §6.2 of the IR spec, which mandates that the IR layer is
rename-blind. Renames are surfaced as `renameHints[]`; the UI renders
each affected node with a "renamed from X / renamed to Y" badge.
Users can collapse the pair, but the underlying graph still shows
both — important if, e.g., V2 silently dropped a leaf.

### 4.2 Fingerprint

For each `function`-tier node we compute a fingerprint:

```
fingerprint(n) = {
  parentId:        n.parentId,
  arity:           n.params.length,
  paramTypes:      sorted(p.type.display for p in n.params),
  returnType:      n.returnType.display,
  inEdgeKinds:     sorted multiset of (category, peer.tier) for edges into n,
  outEdgeKinds:    sorted multiset of (category, peer.tier) for edges out of n,
  sinkFlavors:     sorted multiset of sink.flavor for n's expression descendants,
  leafFlavors:     sorted multiset of leaf.flavor for n's expression descendants,
}
```

Two notes: (1) `parentId` stays in for `structural` mode — cross-file
renames have too many false positives; opt into them via
`structural+name`, which removes `parentId` and adds a Levenshtein on
`name`. (2) Edge fingerprints use peer *tiers*, not peer ids — if
callees were also renamed, ids would differ on both sides; tiers are
stable.

### 4.3 Matching procedure

```
removedFns = { n in base.nodes | n.tier == "function" and n.id not in head.nodeIndex }
addedFns   = { n in head.nodes | n.tier == "function" and n.id not in base.nodeIndex }

for each rN in removedFns:
  candidates = addedFns where fingerprint(rN) matches fingerprint(aN)
  if exactly one candidate: emit RenameHint(rN -> aN, confidence: high)
  elif > 1: pick the one with smallest name Levenshtein (mode-dependent), confidence: medium
  else: no hint

cap total hints at opts.maxRenameHints (default 50)
```

A "match" is exact equality of all fingerprint fields under
`structural`. `structural+name` additionally allows `parentId` to
differ when name Levenshtein ≤ 3. Exact-equality is the right default
— renames-within-file with near-zero false positives.

Rename detection is restricted to `function` tier. Type renames are
expressible the same way but deferred to v0.2: a type rename already
ripples through every function whose param type display changed
(producing a wave of function-id changes), and doubling that with
type-rename hints is too noisy in the common case.

## 5. `changed` nodes

A node is **changed** iff its id is in both sides and something about
its IR differs. The "something" is: `loc` (file:line range), `pure`
flag, `exported` flag, `kind` (e.g. `function` → `component`),
`returnType.display`, or the set of edges incident on it (mirrored
from §3, so the UI can pulse a node whose neighborhood changed even
though its body didn't).

The change record:

```ts
interface ChangedNode {
  id: string;
  fields: Array<{ field: string; before: unknown; after: unknown }>;
  edgeDelta: { added: number; removed: number; changed: number };
}
```

`fields` is sorted by field name. `edgeDelta` is computed from the
node's incident-edge set on each side. A node with nonzero `edgeDelta`
and no field changes is still surfaced — body unchanged but
neighborhood shifted, exactly the signal we want.

A node whose *only* change is `loc` is dropped by default (collapses
"reordered 50 functions in a file" PRs into nothing). Pass
`opts.includeLocOnly = true` for tooling that needs full fidelity.

## 6. Severity scoring

Severity is a derived field used to **sort** the `topItems` list in the
PR comment summary. It does not affect what's in the diff — every
record is always present — only the order of the top-N preview.

### 6.1 Weights (defaults)

| Signal                                                                     | Weight |
|----------------------------------------------------------------------------|--------|
| New `network` sink (any value type)                                        | +6     |
| New cross-service edge (any category, where source.service ≠ target.service) | +6     |
| New `db-write` sink                                                        | +5     |
| New `exec` sink                                                            | +7     |
| New `fs-write` sink                                                        | +4     |
| New `http-route` edge (a new public route)                                 | +5     |
| Changed edge `valueType` where either side is in `securitySensitiveTypes`  | +6     |
| Changed edge `valueType` (any other)                                       | +1     |
| New edge into a node tagged `auth` or `payment` (via `tags[]`)             | +5     |
| Removed `http-route` edge (a route disappeared — likely a regression risk) | +4     |
| New function with `pure: false` and at least one sink in its descendants   | +2     |
| New function with `pure: true` (likely safe utility)                       | 0      |
| New "dead" function (added but no incoming `call` or `import` edge)        | +1     |
| All other adds                                                             | +1     |
| All other removes                                                          | +1     |
| `loc`-only change                                                          | 0      |

`securitySensitiveTypes` is configured per-repo and defaults to:
`["User", "Session", "Credentials", "ApiKey", "Token", "Payment",
"Card", "BankAccount", "SSN"]`. Matching is on the `valueType.display`
string with case-insensitive substring — crude but the right level of
fuzzy for the PR-comment use case.

### 6.2 Bucketing

Score → bucket: `>=10 critical, >=6 high, >=3 medium, else low`.
Weights compound — a new `db-write` edge to a `payment`-tagged node
collects +5 (sink) and +5 (tag), totaling 10 (critical). This is
intentional: "adding a DB write" is yellow, "adding a DB write to the
payments service" is red.

### 6.3 What severity is *not*

Severity is not a security verdict. It's a reading-order optimization
for the PR comment — "look at these N items first" — not a claim that
a vulnerability exists.

## 7. Subgraph diff (scope)

`opts.scope` is an array of POSIX globs (e.g. `services/payments/**`).
Rules: (1) a node is in scope iff its `path` — or, for tiers without
a `path`, the nearest ancestor's — matches at least one glob; (2) an
edge is in scope iff either endpoint is in scope; (3) records whose
primary node/edge is out of scope are dropped; (4) cross-boundary
edges are kept (the interesting case — "payments started talking to a
new external API") with the out-of-scope endpoint reported as a
boundary stub `{ id, name, path }` so the viewer can render it dimmed.

Use cases: sub-team PR comments (per-codeowner threads in a monorepo),
and the viewer's "diff this subgraph" drilldown button. Globs over
`service` paths use simplified prefix match; the action layer
resolves more complex patterns before calling diff.

## 8. Determinism

The diff is byte-deterministic for a given `(base, head, opts)`:

1. **Sorted output.** Every array in `GraphDiff` is sorted by a stable
   key — nodes by `id`, edges by `(sourceId, targetId, category,
   attrsHash)`, `ChangedNode.fields` by field name, `topItems` by
   `(score desc, key asc)` (secondary key resolves score ties).
2. **Stable hashes.** BLAKE3-128 throughout (per the IR spec).
   Canonical-string construction sorts keys lexicographically before
   hashing — no hash depends on object iteration order.
3. **No clocks, no randomness.** The diff is a pure function of
   inputs. `generatedAt` on the IR side is carried through but never
   read; there is no `diffGeneratedAt`.
4. **Stable iteration.** Internally we sort before iterating — never
   iterate a `Set` or `Map` directly into output.

CI assertion: run `diff(base, head)` twice and assert
`JSON.stringify(d1) === JSON.stringify(d2)`. Per-example golden files
live under `test-fixtures/diff/`.

## 9. Pseudocode for the core algorithm

```text
function diff(base: IR, head: IR, opts: DiffOptions): GraphDiff

  # ── 0. Validate ──────────────────────────────────────────────────
  assert base.schemaVersion.major == head.schemaVersion.major
  if base.schemaVersion.minor != head.schemaVersion.minor:
    warn("schemaVersion minor mismatch; comparing best-effort")

  # ── 1. Index ─────────────────────────────────────────────────────
  baseNodes = Map<id, Node> from base.ir.nodes
  headNodes = Map<id, Node> from head.ir.nodes

  baseEdges = Map<edgeKey, Edge> from base.ir.edges, keyed by
              edgeKey(e) = canonical( e.sourceId, e.targetId, e.category,
                                      attrsHash(e) )
  headEdges = Map<edgeKey, Edge> from head.ir.edges, similarly

  # Precompute incident-edge sets per node id, for §5.
  baseIncident = groupBy(base.ir.edges, e => [e.sourceId, e.targetId])
  headIncident = groupBy(head.ir.edges, e => [e.sourceId, e.targetId])

  # ── 2. Scope filter (optional) ───────────────────────────────────
  if opts.scope:
    inScope = nodeId => matchesAny(pathOf(nodeId), opts.scope)
    # (filter applied lazily in §3 and §4 emit steps)

  # ── 3. Node bucketing ────────────────────────────────────────────
  added    = []
  removed  = []
  changed  = []

  for id in headNodes.keys() \ baseNodes.keys():
    if !opts.scope || inScope(id):
      added.push({ id, node: headNodes[id] })

  for id in baseNodes.keys() \ headNodes.keys():
    if !opts.scope || inScope(id):
      removed.push({ id, node: baseNodes[id] })

  for id in headNodes.keys() ∩ baseNodes.keys():
    if opts.scope and !inScope(id): continue
    fields = []
    for f in COMPARED_NODE_FIELDS:                # see §5
      bv = readField(baseNodes[id], f)
      hv = readField(headNodes[id], f)
      if !deepEqual(bv, hv):
        fields.push({ field: f, before: bv, after: hv })
    edgeDelta = computeEdgeDelta(id, baseIncident, headIncident)
    if fields.length > 0 or edgeDelta.any() != 0:
      if fields.length == 1 and fields[0].field == "loc"
         and !opts.includeLocOnly:
        continue                                  # §5: drop loc-only
      changed.push({ id, fields: sortByField(fields), edgeDelta })

  # ── 4. Edge bucketing ────────────────────────────────────────────
  edgesAdded   = []
  edgesRemoved = []
  edgesChanged = []

  baseKeys = baseEdges.keys()
  headKeys = headEdges.keys()

  for k in headKeys \ baseKeys:
    if scopePassesEdge(headEdges[k]):
      edgesAdded.push({ key: k, edge: headEdges[k] })

  for k in baseKeys \ headKeys:
    if scopePassesEdge(baseEdges[k]):
      edgesRemoved.push({ key: k, edge: baseEdges[k] })

  for k in baseKeys ∩ headKeys:
    if !valueTypeEqual(baseEdges[k].valueType, headEdges[k].valueType):
      if scopePassesEdge(headEdges[k]):
        edgesChanged.push({
          key: k,
          before: baseEdges[k].valueType,
          after:  headEdges[k].valueType,
        })

  # ── 5. Rename hints (heuristic) ──────────────────────────────────
  hints = []
  if opts.renameDetection != "off":
    removedFns = removed.filter(r => r.node.tier == "function")
    addedFns   =   added.filter(a => a.node.tier == "function")

    fpHead = Map<fingerprint, addedFn[]>
    for a in addedFns: fpHead[fingerprint(a.node)].push(a)

    for r in removedFns:
      cands = fpHead[fingerprint(r.node)] or []
      if cands.length == 1:
        hints.push(RenameHint(r, cands[0], "high"))
      elif cands.length > 1 and opts.renameDetection == "structural+name":
        best = argmin(cands, c => levenshtein(c.node.name, r.node.name))
        if levenshtein(best.node.name, r.node.name) <= 3:
          hints.push(RenameHint(r, best, "medium"))
    if hints.length > opts.maxRenameHints:
      hints = hints.slice(0, opts.maxRenameHints)

  # ── 6. Severity ──────────────────────────────────────────────────
  scored = []
  for item in iterAllRecords(added, removed, changed,
                             edgesAdded, edgesRemoved, edgesChanged):
    s = score(item, opts.severity, baseNodes, headNodes)
    scored.push({ ref: item.ref, score: s, severity: bucket(s) })
  scored.sort((a, b) => b.score - a.score || compare(a.ref, b.ref))

  # ── 7. Assemble & sort ───────────────────────────────────────────
  return {
    schemaVersion: "0.1.0",
    base: { commit: base.ir.metadata.commit, generatedAt: base.ir.metadata.generatedAt },
    head: { commit: head.ir.metadata.commit, generatedAt: head.ir.metadata.generatedAt },
    scope: opts.scope ?? null,
    addedNodes:    sortById(added),
    removedNodes:  sortById(removed),
    changedNodes:  sortById(changed),
    addedEdges:    sortByEdgeKey(edgesAdded),
    removedEdges:  sortByEdgeKey(edgesRemoved),
    changedEdges:  sortByEdgeKey(edgesChanged),
    renameHints:   sortByEdgeKey(hints),
    summary: {
      counts:   countOf(added, removed, changed, edgesAdded, edgesRemoved, edgesChanged),
      severity: countBuckets(scored),
      topItems: scored.slice(0, 20),
    },
  }
```

### 9.1 `edgeKey` construction

```text
function edgeKey(e: Edge) -> string:
  attrs = pickCategorySpecificAttrs(e)            # see IR §4.3
  attrsCanonical = JSON.stringify(sortKeys(attrs))
  attrsHash = blake3_128_hex(attrsCanonical)
  return e.sourceId + "|" + e.targetId + "|" + e.category + "|" + attrsHash
```

`pickCategorySpecificAttrs` returns:

| category    | attrs                              |
|-------------|------------------------------------|
| `call`      | `{}`                               |
| `import`    | `{ kind?: "type"\|"value" }`       |
| `type-flow` | `{ role, argIndex? }`              |
| `http-route`| `{ method }`                       |
| `db-read`   | `{ op? }`                          |
| `db-write`  | `{ op? }`                          |
| `env-read`  | `{}`                               |
| `fs-read`   | `{}`                               |
| `fs-write`  | `{}`                               |
| `network`   | `{ method? }`                      |
| `exec`      | `{}`                               |

Optional fields, when absent, are simply omitted before the canonical
sort/stringify — so `{ method: "GET" }` and `{}` give different
hashes, but `{ op: "insert" }` and `{ op: "insert", _foo: undefined }`
give the same.

### 9.2 `valueTypeEqual`

```text
function valueTypeEqual(a, b) -> bool:
  if a == null and b == null: return true
  if a == null or b == null:  return false
  if a.lang != b.lang: return false

  # Prefer structural equality when both sides have it. Falling back to
  # `display` is intentional: an analyzer that can't produce structural
  # info for a given type still gets sensible diff behavior.
  if a.structural and b.structural:
    return deepEqual(a.structural, b.structural)
  return a.display == b.display
```

### 9.3 `fingerprint` (rename detection, repeated for clarity)

```text
function fingerprint(n: FunctionNode, incidence: Map) -> string:
  inE  = incidence.in[n.id]  or []
  outE = incidence.out[n.id] or []
  return canonical({
    parentId:   n.parentId,
    arity:      n.params.length,
    paramTypes: sorted(p.type.display for p in n.params),
    returnType: n.returnType.display,
    inEdges:    sorted({(e.category, tierOf(e.sourceId)) for e in inE}),
    outEdges:   sorted({(e.category, tierOf(e.targetId)) for e in outE}),
    sinks:      sorted multiset of descendant.sink.flavor,
    leaves:     sorted multiset of descendant.leaf.flavor,
  })
```

### 9.4 Complexity

Let `n_b, n_h` be node counts, `e_b, e_h` edge counts.

- Indexing: `O(n_b + n_h + e_b + e_h)`.
- Node bucketing: `O(n_b + n_h)` (hash-set ops).
- Edge bucketing: `O(e_b + e_h)`.
- Rename hints: `O(R + A + R*A_max)` where `R, A` are removed/added
  function counts and `A_max` is the largest fingerprint bucket. In
  practice fingerprint buckets have one element, so this is `O(R + A)`.
- Sorting: `O(N log N)` over output sizes, dominated by node + edge
  bucket sizes — bounded by `n_b + n_h + e_b + e_h`.

So total: `O((n_b + n_h + e_b + e_h) log(...))`. For a 50k-node graph
with 200k edges, we measure ~150ms in our benchmark fixture. Plenty of
headroom for the action runner's 30s budget.

## 10. Worked examples

These are the three fixtures in `test-fixtures/diff/`. Each shows
`base`, `head` (in IR sketch form), and the resulting `GraphDiff`
(also sketched — the real fixture is full JSON).

### 10.1 Example A — function added

**Story.** A PR adds a new utility function `formatPrice(amount: number,
currency: string): string` to `apps/api/src/util/money.ts`, and
`handleCheckout` calls it.

**IR delta (sketch).** `MOD_money` and `FN_handleCheckout` unchanged.
New node `FN_formatPrice` with signature
`function|MOD_money|formatPrice|2|number,string`, `pure: true`,
`exported: true`. New `call` edge from `FN_handleCheckout` to
`FN_formatPrice`, `valueType.display: "string"`.

**Diff result.**

```jsonc
{
  addedNodes: [
    { id: "FN_formatPrice", node: { ... } },
  ],
  removedNodes: [],
  changedNodes: [
    {
      id: "FN_handleCheckout",
      fields: [],                            // body unchanged
      edgeDelta: { added: 1, removed: 0, changed: 0 },
    },
  ],
  addedEdges: [
    { key: "FN_handleCheckout|FN_formatPrice|call|<hash-of-{}>",
      edge: { ..., valueType: { display: "string" } } },
  ],
  removedEdges: [],
  changedEdges: [],
  renameHints: [],
  summary: {
    counts: { addedNodes:1, removedNodes:0, changedNodes:1,
              addedEdges:1, removedEdges:0, changedEdges:0,
              renameHints:0 },
    severity: { low: 2, medium: 0, high: 0, critical: 0 },
    topItems: [
      { ref: "node:FN_formatPrice", score: 1, severity: "low" },  // new function, pure
      { ref: "edge:...",            score: 1, severity: "low" },
    ],
  }
}
```

**Walkthrough.**

- `FN_formatPrice` is a new id (it didn't exist in `base`), so it lands
  in `addedNodes`.
- `FN_handleCheckout` is in both. Fields didn't change (assume `loc`
  shifted but is suppressed per §5). Its incident-edge set gained one
  edge — the new `call` to `formatPrice` — so it lands in
  `changedNodes` with `edgeDelta = { added: 1 }`. The reviewer's
  attention is drawn to *both* the new node and the existing node that
  reaches into it.
- Severity: `formatPrice` is `pure: true` and has no descendant sinks,
  so it scores `+1` ("all other adds"). The new edge is a `call` (no
  sink, no cross-service flag if both ends are in the same service),
  so it also scores `+1`. Both end up in "low".

Contrast with the textual diff: a 6-line addition. The graph diff's
extra value here is small — one new util — which is correct. The
algorithm doesn't over-promise on trivial PRs.

### 10.2 Example B — route handler swapped

**Story.** A PR replaces the handler for `POST /api/signup`. The route
literal stays the same; the wired-up handler changes from `handleSignup`
(in `routes/signup.ts`) to `handleSignupV2` (in `routes/signup-v2.ts`).
The Express setup file's call changes from `app.post("/api/signup",
handleSignup)` to `app.post("/api/signup", handleSignupV2)`. Both
functions take `(Request, Response)` and read `req.body.email`.

**IR delta (sketch).** `EXPR_route_literal` keeps the same id (same
parent `FN_setupRoutes`, same canonical payload `"/api/signup"`, same
occurrence index). `FN_handleSignup` (parent `MOD_signup`) disappears;
`FN_handleSignupV2` (parent `MOD_signup_v2`) appears, with an
`http-route` edge to `EXPR_route_literal` carrying `method: "POST"`,
and a `type-flow` edge to its own `EXPR_email_field_v2` child.

**Diff result.**

```jsonc
{
  addedNodes: [
    { id: "FN_handleSignupV2", node: { ... } },
    { id: "EXPR_email_field_v2", node: { ... } },        // new expression child
  ],
  removedNodes: [
    { id: "FN_handleSignup", node: { ... } },
    { id: "EXPR_email_field", node: { ... } },
  ],
  changedNodes: [
    {
      id: "EXPR_route_literal",
      fields: [],
      edgeDelta: { added: 1, removed: 1, changed: 0 },     // incoming edge swapped
    },
  ],
  addedEdges: [
    // The new POST /api/signup binding.
    { key: "FN_handleSignupV2|EXPR_route_literal|http-route|<hash-of-{method:POST}>",
      edge: { ..., valueType: { display: "string" }, method: "POST" } },
    { key: "FN_handleSignupV2|EXPR_email_field_v2|type-flow|<hash-of-{role:read}>",
      edge: { ... } },
  ],
  removedEdges: [
    { key: "FN_handleSignup|EXPR_route_literal|http-route|<hash-of-{method:POST}>",
      edge: { ... } },
    { key: "FN_handleSignup|EXPR_email_field|type-flow|<hash-of-{role:read}>",
      edge: { ... } },
  ],
  changedEdges: [],
  renameHints: [
    {
      from: { id: "FN_handleSignup",   name: "handleSignup" },
      to:   { id: "FN_handleSignupV2", name: "handleSignupV2" },
      confidence: "high",
      reason: "identical fingerprint (parent diff: cross-file; arity/types match; same edge kinds)"
    },
  ],
  summary: {
    counts: { addedNodes:2, removedNodes:2, changedNodes:1,
              addedEdges:2, removedEdges:2, changedEdges:0,
              renameHints:1 },
    severity: { low: 2, medium: 0, high: 1, critical: 0 },
    topItems: [
      // The new POST route is the headliner.
      { ref: "edge:...|http-route|...", score: 5, severity: "high" },
      ...
    ],
  }
}
```

**Walkthrough.**

- Both functions are distinct ids — that's correct. `handleSignup` and
  `handleSignupV2` aren't the same code; they have different parent
  modules and different descendant expressions.
- The `EXPR_route_literal` node id is *the same on both sides* because
  its signature (`expression|FN_setupRoutes|literal|"/api/signup"|0`) is
  unchanged — same parent, same canonical payload, same occurrence
  index. It correctly lands in `changedNodes` with an `edgeDelta`
  showing one `http-route` edge added and one removed.
- The new `http-route` edge scores `+5` (new public route). It dominates
  the topItems list, so the PR comment leads with "POST /api/signup
  now binds to handleSignupV2" — exactly the right framing.
- A `renameHint` from `FN_handleSignup` → `FN_handleSignupV2` fires:
  same arity, same param types `[Request, Response]`, same
  `inEdges`/`outEdges` shape (both have one incoming `http-route`,
  edge etc.). Under `structural+name` mode the cross-file rename is
  picked up; under default `structural` it would not be (parents
  differ) — example uses `structural+name`. Either way, the *both
  nodes still appear* — the hint is advisory.
- Note we do NOT auto-merge. A reviewer can collapse them in the UI,
  but the underlying graph still has both — important if, e.g., V2
  silently dropped a leaf.

### 10.3 Example C — edge `valueType` changed (`string` → `User`)

**Story.** `createUser({email}: { email: string }): Promise<...>` keeps
its parameter shape (so its function id is stable), but the return type
changes from `Promise<string>` (the email of the inserted row) to
`Promise<User>` (the full row). The `db-write` edge from `createUser`
to its sink leaf was carrying `string` and now carries `User`. The
`call` edge from `FN_handleSignup` to `FN_createUser` was carrying
`Promise<string>` and now carries `Promise<User>`.

**IR delta (sketch).** All three nodes keep their ids — `FN_createUser`,
`EXPR_dbCreate` (the `db-write` sink leaf, parent `FN_createUser`), and
`FN_handleSignup`. Only `FN_createUser.returnType.display` changes
between IR documents. The two edges keep their identity tuples
(`(src, dst, category, attrsHash)` is identical) — only their
`valueType` changes.

**Diff result.**

```jsonc
{
  addedNodes: [],
  removedNodes: [],
  changedNodes: [
    {
      id: "FN_createUser",
      fields: [
        { field: "returnType.display",
          before: "Promise<string>",
          after:  "Promise<User>" },
      ],
      edgeDelta: { added: 0, removed: 0, changed: 2 },     // both incident edges' types changed
    },
    {
      id: "EXPR_dbCreate",
      fields: [],
      edgeDelta: { added: 0, removed: 0, changed: 1 },
    },
    {
      id: "FN_handleSignup",
      fields: [],                                         // body unchanged at the IR level
      edgeDelta: { added: 0, removed: 0, changed: 1 },
    },
  ],
  addedEdges: [],
  removedEdges: [],
  changedEdges: [
    {
      key: "FN_createUser|EXPR_dbCreate|db-write|<hash-of-{op:insert}>",
      before: { display: "string" },
      after:  { display: "User" },
    },
    {
      key: "FN_handleSignup|FN_createUser|call|<hash-of-{}>",
      before: { display: "Promise<string>" },
      after:  { display: "Promise<User>" },
    },
  ],
  renameHints: [],
  summary: {
    counts: { addedNodes:0, removedNodes:0, changedNodes:3,
              addedEdges:0, removedEdges:0, changedEdges:2,
              renameHints:0 },
    severity: { low: 1, medium: 0, high: 4, critical: 0 },
    topItems: [
      // db-write edge's valueType change involves "User" — security-sensitive substring.
      { ref: "edge:FN_createUser|EXPR_dbCreate|db-write|...",
        score: 6, severity: "high" },
      // call edge — same bump, "User" is in the post type.
      { ref: "edge:FN_handleSignup|FN_createUser|call|...",
        score: 6, severity: "high" },
      // Function returnType change.
      { ref: "node:FN_createUser",
        score: 6, severity: "high" },
      // EXPR_dbCreate body unchanged but its incident edge changed.
      { ref: "node:EXPR_dbCreate", score: 1, severity: "low" },
    ],
  }
}
```

**Walkthrough.**

- All node ids are stable. No add/remove. Three `changed` nodes:
  `FN_createUser` because its `returnType.display` changed (an IR-level
  field comparison hit), `FN_handleSignup` and `EXPR_dbCreate` because
  their incident-edge sets had `valueType` changes (no body change, but
  the neighborhood shifted).
- Two `changed` edges. Critically, neither is `removed + added`. The
  algorithm correctly identifies that the *same edge* (same identity
  tuple) now carries a different type.
- Severity: both edge changes hit "Changed edge `valueType` where
  either side is in `securitySensitiveTypes`" — `User` is the
  default-list match. Each scores `+6` (high). The function-node change
  also scores `+6` because its `returnType` involves `User`. The
  reviewer's PR comment leads with three high-severity items, all
  pointing at the User-type propagation.
- This is the case where the diff's value is highest: a textual diff
  shows ~10 lines, scattered. The graph diff says: "the type of value
  flowing on the `db-write` edge changed from `string` to `User`, and
  it propagated to the `call` edge from your route handler. If `User`
  contains PII you didn't expect, look here." That's the killer
  feature.

## 11. Testing, assumptions, future work

**Snapshot fixtures.** `test-fixtures/diff/` ships `base.ir.json`,
`head.ir.json`, `expected.diff.json` per worked example. The harness
calls `diff(base, head, opts)`, asserts byte-equality with
`expected.diff.json`, then calls `diff` a second time and asserts
`d1 === d2` (determinism). Two property tests run alongside:
**identity** — `diff(ir, ir)` is empty — and **inverse** — `diff(b, h)`
and `diff(h, b)` have swapped `added`/`removed` and identical
`changed`/`renameHint` arrays (modulo before/after swap).

**Assumptions.** IR is well-formed (every edge endpoint resolves to a
node id; uniqueness checked by the validator before diff runs).
Schema versions match in major. Path globs in `opts.scope` use POSIX
separators. `valueType.display` is the canonical string for type
comparison — adapters MUST whitespace-normalize their display strings
or two adapters emitting `Promise<User>` vs. `Promise< User >` will
register a spurious edge change.

**Deferred to v0.2+.** Type-rename hints (parallel to §4 but for
`type` tier). Smart "package moved" collapsing for monorepo
reorganizations. Diff-of-diffs (per-fixup-commit deltas inside one
PR). Per-repo severity weight learning from revert history (gated on
telemetry consent).
