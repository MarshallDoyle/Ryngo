# Edge Typing & Visual Scheme

> Status: Design spec, v1
> Owner: codegraph core
> Scope: How edges are categorized, typed, rendered, filtered, and inspected.

## 0. Why this exists

Most graph tools draw edges as anonymous arrows. codegraph edges are
**typed**: every edge carries (a) a *category* describing the kind of
relationship and (b) a *value type* describing what flows through it,
pulled directly from the source language's type system (TypeScript types,
Python type hints, Go types, Rust types).

This makes the graph **self-documenting**:

- Hover an arrow from `controllers/users.ts:createUser` to `db.users.insert`:
  see `db-write` in red, label `User`. You instantly know "user-shaped data
  is being written to the database here," without opening either file.
- Filter the canvas to "edges carrying `User`": the entire user data path
  through HTTP routes, services, sinks lights up as a connected subgraph.
- See a dashed gray edge: dynamic dispatch the analyzer could not resolve
  statically. Honest unknowns, not guessed.

No LLM is involved. All categories and types come from deterministic
static analysis (AST + type-checker output for the host language) or from
adapter rules (e.g. "`fs.writeFile(path, buf)` is an `fs-write` sink with
type `Buffer`"). When a type cannot be determined, it is `unknown` -
**never inferred-by-vibes**.

---

## 1. Edge categories

There are 13 first-class categories. Each has a fixed semantic and a
fixed visual encoding. Adapters emit edges tagged with one of these;
nothing else gets through.

| Category          | Meaning                                                        | Sub-class      |
| ----------------- | -------------------------------------------------------------- | -------------- |
| `call`            | Function/method call within process                            | control        |
| `import`          | Module/package import                                          | structural     |
| `type-flow`       | Value passed/returned/assigned between named symbols           | data           |
| `http-route`      | HTTP request crossing a process boundary (client to server)    | data, x-tier   |
| `db-read`         | Read from a persistent store (SQL, KV, document, search index) | effect, source |
| `db-write`        | Write to a persistent store                                    | effect, sink   |
| `env-read`        | Read of an environment variable / config value                 | effect, source |
| `fs-read`         | Read of a file or directory                                    | effect, source |
| `fs-write`        | Write of a file or directory                                   | effect, sink   |
| `network`         | Outbound network call not classified as `http-route`           | effect, sink   |
| `exec`            | Spawning a subprocess / shell command                          | effect, sink   |
| `message-publish` | Enqueueing a message to a broker (Kafka, SQS, NATS, Redis pub) | effect, sink   |
| `message-consume` | Receiving a message from a broker                              | effect, source |

**Rules.**

1. Categories are mutually exclusive at the *edge* level. A call into
   `fs.writeFile` produces both a `call` edge to the function symbol *and*
   an `fs-write` edge to the filesystem-sink node. Two edges, two
   categories - we don't fuse.
2. `type-flow` is the workhorse. It connects symbol-to-symbol whenever a
   value is passed: function arg, return value, assignment, destructure,
   field access into a parameter. It is *the* edge that lets you trace
   "where does `User` go?"
3. `http-route` is separate from `network` because it is the most common
   cross-tier link in modern apps and the one users most want to see
   highlighted (frontend `fetch('/users/:id')` to backend
   `app.get('/users/:id', ...)`). Adapters are responsible for
   recognizing both ends and emitting one `http-route` edge across them.
4. The seven effect categories (`db-*`, `env-read`, `fs-*`, `network`,
   `exec`, `message-*`) always terminate on a *sink node* or *source
   node* (a synthetic, well-known node like `sink:postgres:users` or
   `source:env:DATABASE_URL`). This keeps effect topology visible and
   filterable.

---

## 2. Edge type (the value)

Every edge carries a `type` field whose **shape and origin** depend on
the category:

| Category          | What the type describes                                                   | Source                                                  |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| `call`            | Callee signature: `(args) => returnType`                                  | Host type system                                        |
| `import`          | Imported binding's type (or `module<...>` for namespace imports)          | Host type system                                        |
| `type-flow`       | The value's type at the point of flow                                     | Host type system                                        |
| `http-route`      | `{ request: ReqShape, response: ResShape }`                               | Host types on both ends, unified by adapter             |
| `db-read`         | Row/document type returned                                                | Host type if typed ORM, else schema-derived if adapter has access, else `unknown` |
| `db-write`        | Payload type written                                                      | Host type, same fallback as above                       |
| `env-read`        | Always `string` unless the codebase wraps with `parseInt`/zod/etc.        | Host type at first transformation site                  |
| `fs-read`         | `Buffer`, `string`, or wrapped type                                       | Host type                                               |
| `fs-write`        | Payload type                                                              | Host type                                               |
| `network`         | Request body / response body type if available, else `unknown`            | Host type                                               |
| `exec`            | `{ argv: string[], stdin?: ... }`                                         | Host type                                               |
| `message-publish` | Message payload type                                                      | Host type, sometimes schema-derived (Avro/Proto)        |
| `message-consume` | Message payload type                                                      | Host type, sometimes schema-derived                     |

**Type representation.**

Internally the edge stores three things:

```
type: {
  display:   "Promise<Result<User, AuthError>>"   // single-line, language-flavored
  canonical: { kind: "Promise", of: { kind: "Result", ok: { ref: "User" }, err: { ref: "AuthError" } } }
  origin:    { file: "src/auth/login.ts", line: 42, symbol: "User", kind: "ts-checker" }
}
```

- `display` is what shows on the edge label. Language-faithful: TS
  unions render with `|`, Rust generics with `<>`, Python with PEP 604.
- `canonical` is the structural form used for **type filtering** (`User`
  carried inside `Promise<...>` still matches a "show edges carrying
  `User`" query - see section 6).
- `origin` lets the inspector deep-link to the *definition site* of the
  named type. If the adapter cannot determine origin (e.g. the type is
  anonymous like `{ id: string }`), origin is `null` and the inspector
  shows the structural form only.

**Unknown.**

If the host type system returns `any` / `unknown` / `interface{}` /
`object` (Python), or the adapter cannot map a value to a type, the edge
type is the literal string `unknown`. We do **not** synthesize a
plausible type. `unknown` is a first-class value; it shows differently
(see visual scheme) so users can spot the analysis frontier.

---

## 3. Visual mapping

Three orthogonal channels: **color** (category), **style** (certainty),
**width** (traffic). One textual channel: **label** (type). Plus icons
for sinks/sources.

### 3.1 Color = category

Palette is semantic and grouped, not rainbow. Hex values are tuned for
both light and dark canvas backgrounds (sRGB AA contrast vs `#0E1116`
dark and `#FBFBF9` light).

| Group            | Categories                        | Color name      | Light hex | Dark hex   |
| ---------------- | --------------------------------- | --------------- | --------- | ---------- |
| Data flow (blue) | `type-flow`                       | flow blue       | `#1F6FEB` | `#5AA9FF`  |
|                  | `http-route`                      | route indigo    | `#5B5BD6` | `#8B8BFF`  |
|                  | `db-read`, `message-consume`      | source teal     | `#0E8C8B` | `#3CC4C2`  |
| Control (gray)   | `call`                            | call slate      | `#3F4651` | `#A8B0BD`  |
|                  | `import`                          | import gray     | `#6B7280` | `#9AA3B2`  |
| Effects (warm)   | `db-write`, `message-publish`     | sink red        | `#C0392B` | `#FF6B58`  |
|                  | `fs-read`, `fs-write`             | fs orange       | `#D17B1A` | `#FFAA45`  |
|                  | `network`, `exec`                 | exec amber      | `#B8860B` | `#E8B33A`  |
|                  | `env-read`                        | env olive       | `#6B7B27` | `#A6C24C`  |

Reads stay cool (teal/olive); writes/sinks are warm (red/orange/amber).
Control flow is desaturated so data-flow stands out at a glance. No two
categories share a hue at the same saturation step.

### 3.2 Style = certainty

The line itself encodes how confident the analyzer is.

| Style             | Meaning                                                     | When emitted                                                                          |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Solid             | Resolved statically with full confidence                    | Direct call, named import, typed return value                                         |
| Dashed (long)     | Unresolved or dynamic dispatch                              | Virtual call with multiple subclasses, `any`-typed value, computed import path        |
| Dotted            | Inferred by adapter, not by the type checker                | `prisma.user.create(...)` - adapter knows it's `db-write` with `User` shape from schema |
| Solid + double    | Cross-process / cross-tier                                  | `http-route`, `message-publish`/`consume` between two services in the workspace       |

These four are the only allowed line styles. Combinations are read
left-to-right: e.g. a *dotted* edge with the cross-tier *double* line is
"adapter-inferred, cross-service" - which is exactly what you'd see for
a frontend fetch to a backend route resolved by route-string matching.

### 3.3 Width = traffic / frequency (optional overlay)

Width is **off by default**. When toggled on (a "Heatmap" canvas
control), width maps to one of:

- *Static call count*: how many call sites in the codebase use this
  edge. Useful for "what's the hot path?"
- *Runtime sample* (if the user has imported a profile / OpenTelemetry
  trace dump): real call frequency. Hot edges fatten.

Three buckets, never a continuous gradient (a continuous gradient is
hard to read at a glance):

```
thin   1.0 px   <  p50
medium 2.0 px   p50 - p90
thick  3.5 px   >= p90
```

Width and certainty compose: a *thick dashed* edge means "we see this
called a lot, but at least one site is dynamic dispatch" - which is
itself useful information.

### 3.4 Label = type signature

Edges show their `type.display` string, truncated.

- Default truncation at **24 characters**, ellipsis in the middle:
  `Promise<Result<U…AuthError>>`. Middle-ellipsis preserves the leading
  type constructor and the trailing parameter, both of which are usually
  the most informative.
- Hovering the edge reveals the full `display` string in a tooltip,
  along with `origin.file:line` if available.
- Clicking the edge opens the inspector (section 5).
- `unknown`-typed edges show the literal label `unknown` rendered in
  italic and at 80% opacity, so the analysis frontier is visible at a
  glance without being shouty.
- `call` edges by default show just the callee name + return type
  (`createUser → User`), since the full signature is usually long and
  the parameter shapes are visible on the *type-flow* edges feeding the
  call. Toggleable per-canvas.

### 3.5 Arrowheads

| Arrowhead       | Used for                                                |
| --------------- | ------------------------------------------------------- |
| Filled triangle | Default direction (caller to callee, source to sink)    |
| Open triangle   | Bidirectional / round-trip (`http-route` request+resp)  |
| Diamond         | Sink terminator (head sits on a sink node)              |
| Circle          | Source originator (tail sits on a source node)          |

Sinks/sources additionally render a small **glyph** (16px) at the head
or tail respectively (section 4.2).

---

## 4. Special edges

### 4.1 Cross-service edges

When an edge crosses a service boundary - typically frontend to backend,
or service to service via message broker - we render it distinctly so
users immediately see "this jumps tiers."

Specifically:

- **Double line** (parallel two-stroke), not single. The two strokes are
  the category color at full saturation and at 60% saturation, giving a
  subtle banded look that survives small zoom.
- **Tier badges** at both ends: a small rectangle showing the service
  name (e.g. `web` and `api`), pinned to the edge near each endpoint.
- The edge **routes around** other nodes with a wider clearance (the
  layout engine treats cross-tier edges as higher-priority for routing).
- The label includes both the value type and the route/topic key:
  `User · GET /users/:id` for HTTP, `OrderPlaced · orders.placed` for
  pub/sub.

Cross-service edges are emitted by adapters that operate across the
multi-package/multi-service boundary - the HTTP-route adapter unifies a
client `fetch('/users/:id', { method: 'GET' })` site with a server
`router.get('/users/:id', handler)` site by matching method + path
template, after normalizing path params. When matching is ambiguous
(two backends register the same route), the edge is rendered *dashed*
(dynamic) and the inspector lists all candidates.

### 4.2 Sink/source connections

Effect categories always terminate on a synthetic node. These nodes
have a fixed visual:

- A pill-shaped node, the category color as background, white text.
- A small glyph (Lucide-style, monochrome, 16px) communicating the kind
  of sink/source. The glyph also appears as a head/tail icon on every
  edge entering or leaving the node, so even at low zoom you can see at
  a glance "this arrow ends in a database write."

| Sink/source category      | Glyph (concept)                              |
| ------------------------- | -------------------------------------------- |
| `db-read` / `db-write`    | Cylinder (database)                          |
| `env-read`                | Square brackets `[ENV]`                      |
| `fs-read` / `fs-write`    | Folder                                       |
| `network`                 | Globe                                        |
| `exec`                    | Terminal prompt `>_`                         |
| `message-publish`         | Outbox (envelope with up arrow)              |
| `message-consume`         | Inbox (envelope with down arrow)             |

Sink and source nodes are clustered into a "Boundaries" lane on the
right side of the default layout, so effect topology reads top-to-bottom
without polluting the call-graph in the center.

---

## 5. Type drilling (the edge inspector)

Click an edge -> right-side inspector panel slides in. Three sections:

### 5.1 Header

```
    User                                       [ 14 edges carry this type ]
    ──────────────────────────────────────────────────────────
    type-flow · src/services/users.ts:88 → src/db/users.ts:12
```

- Big type name (clickable, jumps to definition site).
- Edge count for the same type (clicking opens the type-filter view).
- Endpoints with file paths.

### 5.2 Type definition

The full structural definition of the type, language-faithful:

```ts
// src/types/user.ts:7
export interface User {
  id: string
  email: string
  createdAt: Date
  // …4 more fields
}
```

Below: a list of **structural members**, each a clickable atom. Clicking
`createdAt: Date` filters the canvas to "edges carrying `Date`" - this is
how a user discovers that `User.createdAt` is the only path through
which `Date` flows in their system.

For unnamed types (`{ id: string }`, anonymous unions), the structural
form is shown without a definition link.

For `unknown` edges, the panel explains *why* it's unknown ("declared as
`any` here", "callee uses generic `T`", "adapter cannot resolve dynamic
key"), so users can fix the analysis at the source.

### 5.3 All edges of this type

A scrollable list of every other edge in the graph carrying the same
type (matched by `canonical`, not by `display` string - see 6). Each row:

```
db-write     OrdersService.create        →   sink:postgres:orders     resolved
type-flow    POST /orders handler        →   OrdersService.create     resolved
type-flow    fetch('/orders')            →   POST /orders handler     adapter
http-route   web.cart.checkout           →   api.POST /orders         resolved
```

Clicking a row pans/zooms the canvas to that edge and selects it.

This turns the inspector into a **reverse index of value flow**: pick
any type, see every place that type travels. This is the core of the
"self-documenting graph" pitch.

---

## 6. Filter by type

A search bar pinned to the top of the canvas:

```
   ┌─────────────────────────────────────────────────────────────┐
   │  filter:  [ User           ] [ ✕ ]    [ exact | structural ]│
   └─────────────────────────────────────────────────────────────┘
```

Two match modes:

- **Exact** - matches edges whose canonical type *is* `User`.
- **Structural** (default) - matches edges whose canonical type
  *contains* `User`. So `Promise<User>`, `User[]`, `Result<User, E>`,
  `{ user: User }` all match. This is what users actually want most of
  the time.

Behavior on match:

- Matching edges are drawn at full opacity.
- Non-matching edges drop to **15% opacity** rather than disappearing,
  so the user keeps spatial context.
- Nodes touched by no matching edge dim to 30% opacity.
- The matched subgraph's node count and edge count display next to the
  search bar: `42 nodes · 67 edges carry User`.
- The URL updates with the filter, so links into the graph are
  shareable: `?type=User&match=structural`.

Multiple filters compose with AND: `type=User type=Date` highlights the
intersection (edges carrying both - rare but meaningful, e.g. an edge
with type `{ user: User, at: Date }`).

A filter-by-category control sits next to the type filter: checkboxes
for each of the 13 categories, useful for "show me only `db-write` and
`fs-write` carrying `User`" - the GDPR audit query.

---

## 7. Color blindness & accessibility

Color is **never** the only signal.

- Every category has a unique **line style** (section 3.2) *or* a unique
  **arrowhead/glyph** at the head. Effect categories all share the
  rule that the head terminates on a glyph-bearing sink node, so even
  total monochromatic rendering preserves category at the head.
- A "Patterns" toggle in the canvas chrome enables an explicit
  per-category dash pattern overlay. With Patterns on, the four primary
  groups (data, control, effect-sink, effect-source) get distinct
  hatchings even when their colors are remapped:

  | Group           | Pattern (Patterns on)            |
  | --------------- | -------------------------------- |
  | data            | solid                            |
  | control         | dot-dot-dash                     |
  | effect-sink     | long-dash                        |
  | effect-source   | dash-dot                         |

- A built-in **monochrome** mode replaces all category colors with a
  single neutral, leaving style and glyph as the only signals. Useful
  for printing, reviews, and as a sanity check that the graph is
  legible without color.
- Two preset palettes ship: default (above) and a deuteranopia-safe
  variant where the warm/cool split is preserved but blues shift toward
  cyan and reds toward magenta. Both palettes are tested against the
  three common color-vision deficiency simulators (deuter, protan,
  tritan) for a minimum 3:1 contrast between adjacent category groups.
- Labels meet WCAG AA 4.5:1 contrast against the canvas background in
  both light and dark themes.
- All interactive elements (edges, nodes, inspector rows) are keyboard
  reachable. `Tab` cycles through edges incident to the focused node;
  `Enter` opens the inspector; `/` focuses the type filter.

---

## 8. ASCII edge-style legend

A printable, all-in-one-place reference. This is what ships in the
docs page and the README cheat sheet.

```
================================================================================
  codegraph EDGE LEGEND
================================================================================

  CATEGORY (color)                  LINE STYLE (certainty)
  ────────────────────────────      ────────────────────────────
  type-flow      ──────▶ blue        solid    ────────▶  resolved
  http-route     ══════▶ indigo      dashed   ─ ─ ─ ─ ▶  unresolved / dynamic
  db-read        ──────▶ teal        dotted   · · · · ▶  adapter-inferred
  call           ──────▶ slate       double   ══════▶    cross-service / tier
  import         ──────▶ gray
  db-write       ──────▶ red         WIDTH (traffic, optional)
  fs-read        ──────▶ orange      ────────────────────────────
  fs-write       ──────▶ orange      thin     ──────▶   < p50 calls
  network        ──────▶ amber       medium   ━━━━━━▶   p50 – p90
  exec           ──────▶ amber       thick    ▬▬▬▬▬▬▶   ≥ p90
  env-read       ──────▶ olive
  message-pub    ──────▶ red
  message-cons   ──────▶ teal


  ARROWHEADS / TERMINATORS
  ───────────────────────────────────────────────
   ──────▶   default direction (caller→callee, source→sink)
   ◀─────▶   bidirectional (e.g. http-route req+res)
   ──────◆   sink (db, fs, network, exec, message-publish)
   ●──────   source (env, db-read result, message-consume)


  CROSS-TIER (frontend → backend, service → service)
  ───────────────────────────────────────────────
   web ══════ User · GET /users/:id ══════▶ api          resolved http-route
   web ┄┄┄┄┄┄ User · GET /users/:id ┄┄┄┄┄┄▶ api          ambiguous route match


  ANATOMY OF AN EDGE LABEL
  ───────────────────────────────────────────────

           type-flow color
                │
                ▼
    [createUser] ─────────  User  ─────────▶ [db.users.insert]
                            ▲                       ▲
                            │                       │
                  type.display (truncated         sink node
                   to ~24 chars, full on hover)   with cylinder glyph


  WORKED EXAMPLE: tracing User end-to-end
  ───────────────────────────────────────────────

          web (frontend)
          ┌──────────────────┐
          │ submitSignupForm │
          └──────────────────┘
                  │
                  │  type-flow:  SignupFormValues
                  ▼
          ┌──────────────────┐
          │ fetch('/signup') │
          └────────┬─────────┘
                   │
                   │  http-route (cross-tier, double line):
                   │      User · POST /signup
                   ▼
       ╔══════════════════════════════════════════╗
       ║  api (backend)                           ║
       ║                                          ║
       ║  ┌──────────────────────┐                ║
       ║  │ POST /signup handler │                ║
       ║  └──────────┬───────────┘                ║
       ║             │  type-flow: User           ║
       ║             ▼                            ║
       ║  ┌──────────────────────┐                ║
       ║  │ UsersService.create  │                ║
       ║  └──────────┬───────────┘                ║
       ║             │                            ║
       ║             │  db-write (red, dotted –   ║
       ║             │     adapter-inferred       ║
       ║             │     from prisma schema):   ║
       ║             │     User                   ║
       ║             ▼                            ║
       ║         ◆ sink:postgres:users            ║
       ║                                          ║
       ╚══════════════════════════════════════════╝

  Filter the canvas to type=User → every edge above lights up;
  unrelated edges drop to 15% opacity. Click any edge → inspector shows
  the User type definition and lists all 14 edges that carry it.

================================================================================
```

---

## 9. Open questions / future work

- **Generic instantiations.** When the same generic function is called
  with `User` and `Order` at different sites, do we collapse to one
  generic edge labeled `T` or split per instantiation? Current plan:
  split when the host type checker monomorphizes (Rust, Go generics
  post-1.18, TS in many cases), collapse otherwise. Worth revisiting
  after dogfooding.
- **Effect propagation through type-flow.** A function that returns a
  `Promise<User>` opened by a `db-read` is itself effectively a `db-read`
  source from the caller's perspective. We currently keep these as two
  edges (type-flow then db-read). Considering an opt-in
  "transitive-effect" view that propagates effect tags up the call graph.
- **Schema-first projects.** For codebases with OpenAPI / GraphQL /
  Protobuf schemas, the schema is often more authoritative than the
  host type system. Adapter precedence rules (schema vs. host type, on
  conflict) are TBD.
- **Edge bundling.** At low zoom, many parallel `type-flow` edges
  between the same node pair should bundle into one fat edge with a
  multiplicity badge. Bundling rules need to preserve "filter by type"
  semantics: bundles whose constituents all carry `User` highlight as
  one; mixed bundles partial-highlight.

---

## 10. Glossary

- **Adapter** - a per-language or per-framework module that walks the
  host AST/type-checker output and emits codegraph nodes and edges. The
  Prisma adapter, the Express adapter, the FastAPI adapter, etc.
- **Sink** - a node representing an outside-world destination for a
  value (DB write, file write, network call, subprocess spawn,
  published message).
- **Source** - a node representing an outside-world origin of a value
  (env var, file read, DB read result, consumed message).
- **Canonical type** - the structural, language-agnostic representation
  of a type used for filtering and equality. Two edges with the same
  canonical type are matched together regardless of how each language
  spells it.
- **Type-flow edge** - an edge whose category is `type-flow`; the
  primary mechanism by which values are traced through the graph.
- **Cross-tier edge** - an edge whose endpoints live in different
  services/processes; rendered with a double line and tier badges.
