# codegraph IR — Schema Design (v0.1.0)

> Status: design draft. Schema version: `0.1.0`.
> The companion files `ir.schema.json` (JSON Schema, draft 2020-12) and `ir.types.ts`
> (TypeScript) are the normative machine-readable forms; this document explains
> the *why* and provides a worked example.

## 1. Goals & non-goals

**Goals**

- Be a *deterministic*, *typed* graph IR for a polyglot codebase. No LLM is
  ever consulted to populate a node — every field is derivable by a static
  analyzer (tree-sitter + SCIP indexers + framework adapters).
- Be *diffable*. Two IR documents produced from two commits of the same repo
  must produce a structural diff that is dominated by the *real* code change,
  not by trivia like file renames, line-number drift, or analyzer non-determinism.
- Be *renderable* in a React Flow viewer without further transformation —
  every node carries enough info to draw, color, and label it.
- Be *forward-compatible*. Old viewers must keep working when new analyzers
  emit IR with new fields and (within rules below) new enum members.

**Non-goals**

- Modeling control flow or dataflow at instruction granularity. We stop at
  expression-level leaves; intra-function CFG is out of scope for v0.1.
- Full type-system fidelity. We carry enough to color edges and to detect
  shape changes; we are not a type checker.
- Cross-repo linking. A single IR document represents a single repo at a
  single commit. Cross-repo edges are encoded via `external-api` leaves.

## 2. Top-level shape

An IR document is a single JSON object:

```jsonc
{
  "schemaVersion": "0.1.0",          // semver, required
  "ir": {
    "metadata": { /* repo, commit, generatedAt, generators[] */ },
    "nodes":    [ /* Node[] */ ],
    "edges":    [ /* Edge[] */ ],
    "diagnostics": [ /* Diagnostic[] */ ]   // optional, analyzer-emitted
  }
}
```

`schemaVersion` lives at the document root rather than inside `ir` so that a
viewer can route to the right reader before parsing the body. `metadata.generators`
is an array because in practice multiple indexers (e.g. `tree-sitter-ts` plus
the Express adapter plus a Prisma adapter) all contribute to one IR; each
records its name and version so a regression can be traced to a specific
analyzer release.

## 3. Node tiers

Nodes have a strict, finite tier system. A node's `tier` field is a
discriminator: it determines which optional fields are meaningful and how the
viewer renders the node (size, default color, expandability).

| Tier         | Examples                                        | Containment              |
|--------------|-------------------------------------------------|--------------------------|
| `service`    | a deployable unit, an npm package, a Cargo crate| contains modules         |
| `module`     | a source file, a Python module                  | contains types/functions |
| `type`       | a TS interface, a Python class, a Go struct     | contains methods         |
| `function`   | a function, method, lambda with a stable name   | contains expressions     |
| `expression` | a leaf or sink expression (a fetch call, a `process.env.X`, an SQL literal) | terminal |

Tiers are *strictly nested* — a `function` node's `parentId` must be a `type`
or `module`; an `expression` node's `parentId` must be a `function`. The
viewer relies on this to render collapsible groups. The `parentId` field is
required for every tier except `service` (which is the root tier).

We do *not* model "block" or "statement" tiers. Adding them would explode node
counts (~10x) without giving the diff much signal; if a future need arises,
inserting a `block` tier between `function` and `expression` is a
forward-compatible change because tier is an open enum at the schema level
(see §8).

## 4. Edges: two-axis typing

Every edge carries **two** orthogonal tags:

- `category` — *what kind of relationship* (call, import, type-flow, etc.)
- `valueType` — *what kind of value flows along the edge* (a string, a
  `User`, a `Promise<Response>`, etc.), expressed in the source language's
  type-system surface.

This split is critical. A `call` edge from `handler` to `db.users.create`
and a `call` edge from `handler` to `logger.info` look identical if you only
have a category. The `valueType` lets the viewer color the first edge by
"writes a User" and the second by "void / log only". Likewise, the same
`valueType` (`string`) can flow along an `env-read` edge or a `network` edge
— very different security implications.

### 4.1 Edge categories (closed enum at v0.1, extension policy in §8)

| Category     | Source tier   | Target tier  | Meaning                                   |
|--------------|---------------|--------------|-------------------------------------------|
| `call`       | function/expr | function     | function or method invocation             |
| `import`     | module        | module/type/function | static import, `require`, `use` clause |
| `type-flow`  | function/expr | function/expr| value of one expression flows to another (return value, argument, assignment) |
| `http-route` | function      | expression   | this function handles requests matching a route literal (the leaf) |
| `db-read`    | function/expr | expression   | reads from a DB sink/source leaf          |
| `db-write`   | function/expr | expression   | writes to a DB sink                       |
| `env-read`   | function/expr | expression   | reads `process.env.X` / equivalent leaf   |
| `fs-read`    | function/expr | expression   | reads from filesystem                     |
| `fs-write`   | function/expr | expression   | writes to filesystem                      |
| `network`    | function/expr | expression   | initiates an outbound HTTP/RPC request    |
| `exec`       | function/expr | expression   | spawns a subprocess / shell command       |

`type-flow` is the most general category. The `call` category could be modeled
as `type-flow` with extra attributes, but we keep it separate because (a) calls
dominate visualizations and need a distinct color, and (b) call edges are
where most analyzers' SCIP output is densest, so isolating them simplifies
the analyzer→IR mapping.

### 4.2 Edge `valueType`

`valueType` is a structured object, not a string, because we want diff to
detect shape changes:

```jsonc
{
  "lang": "ts",                  // source language tag
  "display": "Promise<User>",    // human-readable, for the viewer label
  "structural": {                // optional, analyzer-dependent
    "kind": "generic",
    "name": "Promise",
    "args": [{ "kind": "ref", "name": "User" }]
  },
  "nullable": false,
  "source": "inferred"           // "annotated" | "inferred" | "unknown"
}
```

`lang` exists because the same `display` string means different things in
different languages (`Optional<User>` in Java vs. Kotlin). Analyzers that
cannot produce `structural` may omit it; the viewer falls back to `display`.

### 4.3 Edge identity

Edges are identified by `(sourceId, targetId, category, attributes-hash)`,
*not* by an opaque ID. This is deliberate: it makes parallel edges with
different categories (a `call` and a `type-flow` between the same pair of
nodes) distinct, while merging duplicate edges that some analyzer might emit
twice. See §6 for hashing rules.

## 5. Leaves and sinks

`expression`-tier nodes split into two non-exclusive roles:

### 5.1 Leaf flavors (sources of value)

| Flavor         | Example                                | Required attributes                |
|----------------|----------------------------------------|------------------------------------|
| `literal`      | `"GET"`, `42`, `true`                  | `value` (canonicalized)            |
| `env`          | `process.env.DATABASE_URL`             | `name`                             |
| `config-file`  | `fs.readFileSync("config.json")`       | `path`, `format` (`json`,`toml`,`env`,`yaml`,`other`) |
| `cli-arg`      | `process.argv[2]`, `clap` derive        | `name?`, `index?`                  |
| `http-input`   | `req.body.email`, `useParams().id`     | `field`, `from` (`body`,`query`,`path`,`header`,`cookie`) |
| `db-read`      | `db.users.findUnique({...})`           | `store`, `entity`, `op`            |
| `external-api` | a `fetch("https://stripe…")` call site | `url?`, `service?`                 |

Note that `db-read` is *both* a leaf flavor (the data flowing out of the DB)
*and* an edge category (the act of reading). The first describes "what kind
of expression node this is", the second describes "what kind of edge points
to it". They co-occur naturally: a function reads the DB, so there's a
`db-read` edge pointing to a `db-read` leaf.

### 5.2 Sink flavors (destinations of value)

| Flavor      | Example                                                   |
|-------------|-----------------------------------------------------------|
| `db-write`  | `db.users.create({...})`, `INSERT INTO …`                |
| `network`   | `fetch(url, {method:"POST", body})`, `axios.post(...)`   |
| `fs`        | `fs.writeFile(path, data)`                                |
| `exec`      | `child_process.spawn("git", [...])`                       |
| `log`       | `console.log`, `logger.info`                              |

A single expression node may carry both a leaf flavor and a sink flavor
(e.g. `await fetch(url)` is `external-api` leaf + `network` sink). The
`leaf` and `sink` fields on an `expression` node are independent optionals;
either, both, or neither may be set. An expression node with neither set is
"plain" — typically an intermediate computation that a `type-flow` edge
passes through.

The `pure` boolean on every `function` node and `expression` node drives the
viewer's pure-vs-effectful coloring. An expression with any sink is
automatically `pure: false`. A function is `pure: true` iff transitively
none of its expressions or callees have a sink — analyzers compute this in a
fixpoint pass and stamp the result onto the node.

## 6. Node identity

Node identity is the linchpin of diffability. Position-based IDs (line/column)
make trivial reformatting look like deletions. We use **signature-based IDs**:
an `id` is the lowercase hex of `BLAKE3(canonical_signature_string)`,
truncated to 16 bytes (32 hex chars). The signature string is built from
tier-specific tuples:

| Tier        | Signature components                                                    |
|-------------|-------------------------------------------------------------------------|
| `service`   | `repo` + `service-path` (e.g. `apps/api`)                              |
| `module`    | parent service id + repo-relative file path (POSIX-normalized, no leading `./`) |
| `type`      | parent module id + fully-qualified type name                           |
| `function`  | parent (module or type) id + symbol name + arity + parameter type displays (joined with `,`) + receiver-type display if method |
| `expression`| parent function id + role discriminator + canonical literal-or-symbol payload + lexical-occurrence index within the function |

A few notes:

- The expression "lexical-occurrence index" is intentionally *not* a line
  number. It's "the N-th expression of this role inside this function in
  source order". Reformatting a function body does not change it; reordering
  two adjacent calls does. This is the right trade-off: we want reorderings
  to show in the diff, but not whitespace.
- Parameter type displays are taken from the analyzer's surface form
  (TypeScript annotation if present, else `unknown`). This means renaming a
  parameter does *not* change the function id, but changing its type does
  — that matches the intuition that "this is a different function now".
- For overloaded functions, arity + types disambiguate.
- The `repo` field for `service` ids is the canonical repo URL when known
  (e.g. from `git remote get-url origin`), or the empty string for local
  analysis. This means the same code analyzed in two checkout locations
  produces identical IDs as long as the remote matches.

### 6.1 Why hash, not the signature itself?

Signatures get long (a deeply nested function in a deep type in a deep file
easily exceeds 200 chars). Hash IDs keep edge `sourceId`/`targetId` cheap to
serialize and quick to index. The collision risk at 128 bits, with realistic
node counts (≤ 10⁷), is negligible.

The full signature string is *also* stored on the node as `signature` —
opaque to the viewer, useful for debugging "why did this id change?".

### 6.2 Renames

A rename changes the signature and therefore the id. The diff tool sees a
delete + add. A future cross-version rename detector (heuristic, post-hoc)
can bridge these by matching on `(parentId, kind, neighborhood-edge-set)` —
that lives in the diff tool, *not* the IR. Keeping the IR rename-blind
preserves determinism: two analyzers must produce byte-identical IR for the
same input.

## 7. Versioning

`schemaVersion` follows semver. The two relevant invariants:

- **MINOR** bumps may add new optional fields, new node tiers (positions in
  the containment hierarchy), new edge categories, new leaf/sink flavors.
  Old viewers MUST silently ignore unknown fields and nodes/edges whose
  discriminator they don't recognize (degraded but not broken).
- **MAJOR** bumps may remove or rename fields, change discriminator values,
  or change node-id derivation. Old viewers MUST refuse to load.

`PATCH` bumps are reserved for clarifying spec text and JSON Schema
tightening that does not invalidate any previously valid document.

A viewer encountering a higher *minor* version than it knows about should
log "schema vX.Y, viewer vX.Z; rendering with degraded coverage" and
proceed; a higher *major* should fail loudly.

## 8. Evolution rules for enums

Enum-typed fields (`category`, `tier`, leaf/sink `flavor`) are split into
two layers in the JSON Schema:

- A *known* set, validated by `enum`. These are the v0.1 categories listed
  above.
- An *unknown* escape hatch: any string is also accepted, with the
  convention that unknown values use the prefix `x-` (e.g. `x-grpc-call`)
  for analyzer experimentation.

A new value being promoted from `x-` to known is a MINOR bump. Removing
a known value is a MAJOR bump. This lets framework adapters ship faster
than the central spec and lets the viewer render unknown values with a
generic "experimental" style.

## 9. Diagnostics

The optional `ir.diagnostics` array is for analyzer-emitted notes that
shouldn't be silently swallowed: skipped files, partial parses, type
inference failures. Each diagnostic has a severity, a message, an
analyzer name, and an optional `nodeId` (so the viewer can decorate the
node with a warning indicator). Diagnostics never affect node identity
or graph topology.

## 10. Worked example: a tiny 3-file repo

The repo:

- `apps/web/src/SignupForm.tsx` — a React component that posts to `/api/signup`
- `apps/api/src/routes/signup.ts` — an Express handler for `POST /api/signup`
- `apps/api/src/db.ts` — a Prisma client wrapper that creates a User row

A faithful IR has many more nodes than what's shown (every import is a
node, every literal is a node). For readability the example shows only
the load-bearing nodes; `…` indicates omitted siblings.

```jsonc
{
  "schemaVersion": "0.1.0",
  "ir": {
    "metadata": {
      "repo": "git@github.com:example/codegraph-demo.git",
      "commit": "9f1c0a3b…",
      "generatedAt": "2026-05-08T17:30:00Z",
      "generators": [
        { "name": "codegraph-tree-sitter-ts", "version": "0.1.0" },
        { "name": "codegraph-adapter-express", "version": "0.1.0" },
        { "name": "codegraph-adapter-prisma",  "version": "0.1.0" }
      ]
    },
    "nodes": [
      // ──────────────────── services ───────────────────────────────────
      {
        "id": "a1b2c3d4e5f60718",
        "tier": "service",
        "name": "web",
        "signature": "service|git@github.com:example/codegraph-demo.git|apps/web",
        "path": "apps/web",
        "lang": "ts"
      },
      {
        "id": "b2c3d4e5f6071829",
        "tier": "service",
        "name": "api",
        "signature": "service|git@github.com:example/codegraph-demo.git|apps/api",
        "path": "apps/api",
        "lang": "ts"
      },

      // ──────────────────── modules ────────────────────────────────────
      {
        "id": "c3d4e5f607182930",
        "tier": "module",
        "parentId": "a1b2c3d4e5f60718",
        "name": "SignupForm.tsx",
        "signature": "module|a1b2c3d4e5f60718|apps/web/src/SignupForm.tsx",
        "path": "apps/web/src/SignupForm.tsx",
        "lang": "tsx"
      },
      {
        "id": "d4e5f60718293041",
        "tier": "module",
        "parentId": "b2c3d4e5f6071829",
        "name": "routes/signup.ts",
        "signature": "module|b2c3d4e5f6071829|apps/api/src/routes/signup.ts",
        "path": "apps/api/src/routes/signup.ts",
        "lang": "ts"
      },
      {
        "id": "e5f6071829304152",
        "tier": "module",
        "parentId": "b2c3d4e5f6071829",
        "name": "db.ts",
        "signature": "module|b2c3d4e5f6071829|apps/api/src/db.ts",
        "path": "apps/api/src/db.ts",
        "lang": "ts"
      },

      // ──────────────────── functions ──────────────────────────────────
      {
        "id": "f607182930415263",
        "tier": "function",
        "parentId": "c3d4e5f607182930",
        "name": "SignupForm",
        "signature": "function|c3d4e5f607182930|SignupForm|0|",
        "kind": "component",
        "pure": false,
        "exported": true,
        "params": [],
        "returnType": { "lang": "ts", "display": "JSX.Element", "source": "inferred" }
      },
      {
        "id": "071829304152637a",
        "tier": "function",
        "parentId": "c3d4e5f607182930",
        "name": "onSubmit",
        "signature": "function|c3d4e5f607182930|onSubmit|1|FormEvent",
        "kind": "function",
        "pure": false,
        "exported": false,
        "params": [
          { "name": "e", "type": { "lang": "ts", "display": "FormEvent", "source": "annotated" } }
        ],
        "returnType": { "lang": "ts", "display": "Promise<void>", "source": "inferred" }
      },
      {
        "id": "1829304152637a8b",
        "tier": "function",
        "parentId": "d4e5f60718293041",
        "name": "handleSignup",
        "signature": "function|d4e5f60718293041|handleSignup|2|Request,Response",
        "kind": "function",
        "pure": false,
        "exported": true,
        "params": [
          { "name": "req", "type": { "lang": "ts", "display": "Request",  "source": "annotated" } },
          { "name": "res", "type": { "lang": "ts", "display": "Response", "source": "annotated" } }
        ],
        "returnType": { "lang": "ts", "display": "Promise<void>", "source": "annotated" }
      },
      {
        "id": "29304152637a8b9c",
        "tier": "function",
        "parentId": "e5f6071829304152",
        "name": "createUser",
        "signature": "function|e5f6071829304152|createUser|1|{email:string}",
        "kind": "function",
        "pure": false,
        "exported": true,
        "params": [
          { "name": "input", "type": { "lang": "ts", "display": "{email:string}", "source": "annotated" } }
        ],
        "returnType": { "lang": "ts", "display": "Promise<User>", "source": "annotated" }
      },

      // ──────────────────── expressions: leaves & sinks ────────────────

      // 1. The frontend route literal "/api/signup" (a literal leaf, used
      //    by the network sink below).
      {
        "id": "304152637a8b9cad",
        "tier": "expression",
        "parentId": "071829304152637a",
        "signature": "expression|071829304152637a|literal|\"/api/signup\"|0",
        "pure": true,
        "leaf":  { "flavor": "literal", "value": "/api/signup", "valueLang": "ts" }
      },
      // 2. The frontend `fetch(...)` call — both an external-api leaf
      //    (its return value is data from outside) AND a network sink
      //    (it sends a POST).
      {
        "id": "4152637a8b9cadbe",
        "tier": "expression",
        "parentId": "071829304152637a",
        "signature": "expression|071829304152637a|call|fetch|0",
        "pure": false,
        "leaf": { "flavor": "external-api", "url": "/api/signup", "service": "api" },
        "sink": { "flavor": "network", "method": "POST" }
      },
      // 3. Express route literal — the http-route adapter promotes this
      //    string literal to "the route this handler serves".
      {
        "id": "52637a8b9cadbecf",
        "tier": "expression",
        "parentId": "1829304152637a8b",
        "signature": "expression|1829304152637a8b|literal|\"/api/signup\"|0",
        "pure": true,
        "leaf": { "flavor": "literal", "value": "/api/signup", "valueLang": "ts" }
      },
      // 4. `req.body.email` — http-input leaf.
      {
        "id": "637a8b9cadbecfd0",
        "tier": "expression",
        "parentId": "1829304152637a8b",
        "signature": "expression|1829304152637a8b|http-input|req.body.email|0",
        "pure": true,
        "leaf": { "flavor": "http-input", "field": "email", "from": "body" }
      },
      // 5. `db.users.create({...})` — db-write sink.
      {
        "id": "7a8b9cadbecfd0e1",
        "tier": "expression",
        "parentId": "29304152637a8b9c",
        "signature": "expression|29304152637a8b9c|call|db.users.create|0",
        "pure": false,
        "sink": { "flavor": "db-write", "store": "postgres", "entity": "User", "op": "insert" }
      }
    ],

    "edges": [
      // SignupForm renders / owns onSubmit (call edge).
      {
        "sourceId": "f607182930415263",
        "targetId": "071829304152637a",
        "category": "call",
        "valueType": { "lang": "ts", "display": "Promise<void>", "source": "inferred" }
      },
      // onSubmit calls fetch (call edge).
      {
        "sourceId": "071829304152637a",
        "targetId": "4152637a8b9cadbe",
        "category": "call",
        "valueType": { "lang": "ts", "display": "Promise<Response>", "source": "inferred" }
      },
      // The literal "/api/signup" flows into the fetch call (type-flow).
      {
        "sourceId": "304152637a8b9cad",
        "targetId": "4152637a8b9cadbe",
        "category": "type-flow",
        "valueType": { "lang": "ts", "display": "string", "source": "inferred" },
        "role": "argument",
        "argIndex": 0
      },
      // Cross-service network edge: fetch hits something at /api/signup.
      // The "target" is the leaf itself; the http-route adapter on the
      // server side will pair these via the matching literal value.
      {
        "sourceId": "071829304152637a",
        "targetId": "4152637a8b9cadbe",
        "category": "network",
        "valueType": { "lang": "ts", "display": "Request", "source": "inferred" }
      },
      // Express route binding: handleSignup is the handler for the literal.
      {
        "sourceId": "1829304152637a8b",
        "targetId": "52637a8b9cadbecf",
        "category": "http-route",
        "valueType": { "lang": "ts", "display": "string", "source": "inferred" },
        "method": "POST"
      },
      // handleSignup reads req.body.email (env-style leaf for http input).
      {
        "sourceId": "1829304152637a8b",
        "targetId": "637a8b9cadbecfd0",
        "category": "type-flow",
        "valueType": { "lang": "ts", "display": "string", "source": "inferred" },
        "role": "read"
      },
      // handleSignup calls createUser.
      {
        "sourceId": "1829304152637a8b",
        "targetId": "29304152637a8b9c",
        "category": "call",
        "valueType": { "lang": "ts", "display": "Promise<User>", "source": "annotated" }
      },
      // createUser writes to db.users (db-write sink).
      {
        "sourceId": "29304152637a8b9c",
        "targetId": "7a8b9cadbecfd0e1",
        "category": "db-write",
        "valueType": { "lang": "ts", "display": "User", "source": "annotated" }
      }
    ],

    "diagnostics": [
      {
        "severity": "info",
        "analyzer": "codegraph-adapter-express",
        "message": "Paired client fetch \"/api/signup\" with server route POST /api/signup by literal match."
      }
    ]
  }
}
```

### 10.1 Reading the example

What this graph shows the viewer:

- Two services (`web`, `api`) appear as top-level groups. The `network` edge
  from `onSubmit` to its `external-api` leaf, paired with the `http-route`
  edge in the api service via matching `/api/signup` literals, lets the
  viewer draw a *cross-service* arrow with the label `POST /api/signup`.
- `handleSignup` is colored effectful (`pure: false`) and reachable from
  it is a `db-write` sink — the viewer paints the path red as a "writes
  to DB" trace.
- `createUser`'s edge to its sink is *not* a `call` edge — it's a `db-write`
  edge, distinct from any control-flow call to `db.users.create` that
  could happen elsewhere. This is what "typed edges" buys: the viewer
  can filter by category to show only DB-touching paths.

## 11. Assumptions made

The following are explicit assumptions (anywhere they're relaxed in a future
release will be a MINOR bump):

- **One repo per IR document.** Multi-repo views are composed at the
  viewer/diff layer, not in the IR.
- **UTF-8 paths, POSIX separators.** The IR is a JSON document and paths are
  always forward-slash. Windows analyzers must normalize.
- **Stable parameter ordering.** Analyzers must emit `params` in source order;
  the JSON Schema can't enforce this but determinism requires it.
- **Hash function is BLAKE3-128** (i.e. BLAKE3 truncated to 16 bytes). A
  major version may switch this; minor versions may not.
- **The `service` tier is shallow.** A monorepo with many packages produces
  many `service` nodes, not a service-of-services. Nesting services is
  representable (parentId on `service` is allowed but optional) but its
  semantics are reserved for v0.2.
- **`pure` is best-effort.** If an analyzer cannot decide, it sets
  `pure: false` (the safe over-approximation) and records a diagnostic.
