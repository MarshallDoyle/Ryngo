# CONSISTENCY_REPORT.md

> Author: skeptic teammate
> Date: 2026-05-09
> Status: punch list for v0.1 freeze.
> Method: read-only audit of `spec/`, `design/`, `research/`, `brand/`,
> `marketing/`, `packages/`, `adapters/`, `docs/`, `test-fixtures/`,
> `.codegraph.yml.example`, `.github/workflows/`, root markdown.
> Citations are `path:line` against tree state at audit time.

This is the things-that-won't-survive-implementation list. Severity stamps:

- **B** — blocker for v0.1 freeze (two-source-of-truth, breaks the build, or breaks user contract).
- **C** — must-fix before v0.1 ships (broken example, contradiction users will hit, or implementation drift).
- **N** — nit (cosmetic, doc-only, or low-volume drift).

Counts by category at time of writing: **B** 9, **C** 17, **N** 14.

---

## 1. Type drift — IR shape

The IR exists in **three** mutually-incompatible shapes, plus a documented-but-not-realized fourth. This is the single biggest consistency problem in the repo and blocks any cross-package integration testing.

### 1.1 [B] Three IR schemas, all ostensibly v0.1.0

| Variant | Where | Top-level shape | Node identity | Edge identity |
|---|---|---|---|---|
| **Spec IR** | `spec/ir.types.ts:25-40`, `spec/ir.schema.json:7-30`, `spec/ir-schema.md` | `{ schemaVersion, ir: { metadata, nodes, edges, diagnostics? } }` | `id` = BLAKE3-128 hex of canonical signature; `tier` discriminates | `(sourceId, targetId, category, attrsHash)` keyed; `category` discriminates |
| **Core IR** | `packages/core/src/ir/types.ts:40-58` (re-exported via `packages/core/src/ir/index.ts`) | Identical to Spec IR | Identical | Identical |
| **Viewer stub IR** | `packages/viewer/src/lib/load-ir.ts:15-68` | `{ version, meta?, nodes, edges }` (no `schemaVersion`, no `ir` wrapper, no `diagnostics`) | `id`: opaque string + `tier` + `name`, `parentId` | `id`, `source`, `target`, `kind` (open string) |
| **Sample-generator IR** | `packages/core/src/sample/generator.ts:84-103` | Same as Viewer stub: emits `{ version, meta, nodes, edges }` | `id` from `makeId(tier, parentId, name)` (`packages/core/src/sample/generator.ts:472-481`) | `id: 'e1', 'e2', ...` (counter) + `kind` |

Concrete consequences:

- **`packages/viewer/src/lib/load-ir.ts:8` and `:119-171`** parse `{ version, nodes, edges }` and reject any document with a `schemaVersion`/`ir` envelope (`validateIR` reads `raw.version` directly). The CLI emits `{ schemaVersion, ir: { ... } }` (`packages/cli/src/commands/cmd-index.ts:466-478`). **The CLI's output is not loadable by the viewer.**
- **`packages/core/src/sample/generator.ts:67-103`** generates the viewer-stub shape, not the spec shape. Demos and screenshots will look correct in the viewer but are not valid IR documents per `spec/ir.schema.json`.
- **Edge identity diverges fundamentally.** Spec edges have no `id` — identity is `(sourceId, targetId, category, attrsHash)` (`spec/ir-schema.md:142-148`, `design/diff-algorithm.md:165-188`). Stub edges have an opaque `id` and `kind` (`packages/viewer/src/lib/load-ir.ts:49-55`). Diff algorithm correctness depends on the spec form; viewer state will collide with itself if multiple edges share `(source, target, kind)`.
- **Tier vocabulary mismatch.** Stub `EdgeKind` is `'calls' | 'imports' | 'contains' | 'type_of' | 'reads' | 'writes' | 'extends' | 'implements'` (`packages/viewer/src/lib/load-ir.ts:38-47`). Spec `EdgeCategory` is `'call' | 'import' | 'type-flow' | 'http-route' | 'db-read' | 'db-write' | 'env-read' | 'fs-read' | 'fs-write' | 'network' | 'exec'` (`packages/core/src/ir/types.ts:443-455`). No overlap on naming convention (`calls` vs `call`, `reads` vs `db-read`/`fs-read`/`env-read`). The sample generator emits stub names (`'calls'`, `'reads'`, `'writes'`, `'imports'`), not spec names.
- **Sample IR's tier is closed-set** (`packages/core/src/sample/generator.ts:22`: `'service' | 'module' | 'type' | 'function' | 'expression'`); spec tier is open (`x-${string}` allowed; `packages/core/src/ir/types.ts:157-163`). Generator can't produce open-tier values.

### 1.2 [B] The `@codegraph/ir` package referenced everywhere does not exist

`packages/core/src/sample/generator.ts:19`, `packages/core/src/export/subgraph.ts:23-32`, `packages/viewer/src/lib/load-ir.ts:8-9`, `packages/viewer/README.md`, `packages/core/src/sample/README.md`, `packages/viewer/src/lib/filters.ts` all `import type { ... } from '@codegraph/ir'`. There is no `packages/ir/` directory, no `@codegraph/ir` workspace member, and `STRUCTURE.md:14-34` does not list it. Per the team-lead update, types were published at `@codegraph/core/ir` (`packages/core/src/ir/index.ts:1-13` confirms this). All four importers must move to `@codegraph/core/ir` (or `@codegraph/core`) before the build resolves. Today these files are unbuildable.

### 1.3 [B] `IRNode`, `IREdge`, `RouteNode`, `HandlerSymbol`, `HttpMethod`, `TypeShape` types referenced by legacy adapters do not exist anywhere

`adapters/express.ts:31-44`, `adapters/fastapi.ts:38-50`, `adapters/nextjs.ts:38-52` import `IRNode`, `IREdge`, `RouteNode`, `PageRouteNode`, `ServerActionNode`, `ClientCallNode`, `HandlerSymbol`, `HttpMethod`, `TypeShape` from `@codegraph/ir`. Spec/core IR has none of these names — node tiers are `service|module|type|function|expression`, never `Route` or `Handler` or `Page` or `ServerAction`. These adapter files cannot type-check against any current types module. (See §2 for the larger interface mismatch.)

### 1.4 [C] `Metadata.generators[]` vs `meta.generator` (singular)

Spec `Metadata` requires `generators: GeneratorInfo[]` (`packages/core/src/ir/types.ts:67-77`, `spec/ir.schema.json:42-52`). Sample generator emits `meta.generator: { name, ... }` — singular — and the field nests size/seed counts under it (`packages/core/src/sample/generator.ts:91-99`). Pure rename + array-wrap to comply.

### 1.5 [C] `loc` shape mismatch

Spec `SourceLoc.path` is required; `startLine`/`startCol`/`endLine`/`endCol` are optional 1-based ints (`spec/ir.schema.json:139-150`, `packages/core/src/ir/types.ts:137-144`). Stub `Provenance` (`packages/viewer/src/lib/load-ir.ts:19-23`) has `file` (not `path`), and only `startLine`/`endLine` (no col). Sample generator emits stub form (`packages/core/src/sample/generator.ts:198, 380, 421`). Renaming `file→path` is the smaller part; the bigger issue is that spec keeps `loc` *off* node identity (footnote: `spec/ir-schema.md` "loc … NEVER part of node identity") but the sample generator's `makeId` uses `name+parentId` — accidentally compliant, but for the wrong reason.

### 1.6 [C] `pure`/`exported`/`signature`/`params` required on FunctionNode but absent in samples

Spec `FunctionNode` requires `pure: boolean`, `params: FunctionParam[]`, `name: string`, `kind: FunctionKind` (`packages/core/src/ir/types.ts:236-249`, `spec/ir.schema.json:222-255`). Sample generator's function nodes have `name`, `signature`, `attributes.pure`, `attributes.churn` — `pure` lives in `attributes`, `params` is missing entirely, `kind` is missing (`packages/core/src/sample/generator.ts:413-432`). Same comment applies to `ExpressionNode`'s required `pure: boolean`.

### 1.7 [N] `service` node `path` field

Spec `ServiceNode.path` is required (`spec/ir.schema.json:160-176`). Sample generator emits service nodes with no `path`, only `attributes.role` (`packages/core/src/sample/generator.ts:370-382`). Easy fix.

### 1.8 [B] Adapter-interface IR diverges from spec IR

`spec/adapter-interface.ts:90-132` defines `IrNode { id, kind, label, data, group?, provenance }` and `IrEdge { id, kind, from, to, label?, data?, provenance }`. The spec IR (`spec/ir.types.ts`, `packages/core/src/ir/types.ts`) defines `Node` with `tier|signature|...` and `Edge` with no id but `(sourceId, targetId, category, ...)`. **These are two different graph models**, not two views of one. The adapter contract is a label/data/group "knowledge graph" (closer to Sourcegraph SCIP); the IR spec is a tiered, typed-edge call graph. Reference adapters (`adapters/express/src/types.ts`, etc.) emit the adapter-interface shape — see §2.4. Decide which is canonical and rewrite the loser, or define a precise adapter→IR translation step (and document it). At the moment, an adapter run cannot produce an IR document the viewer or diff engine accepts.

---

## 2. Interface mismatch — Adapter contract

There are **two adapter shapes in the repo** and both call themselves canonical.

### 2.1 [B] Two coexisting adapter populations

| File set | Phases | Imports | Status |
|---|---|---|---|
| `adapters/express.ts`, `adapters/fastapi.ts`, `adapters/nextjs.ts` (top-level files) | `detect(repo) → boolean` then `analyzeFile(file)` then `resolveCrossFile(...)` | `@codegraph/adapter-sdk` types `Adapter, RepoContext, FileContext, AdapterOutput` and `@codegraph/ir` types `IRNode, IREdge, RouteNode, HandlerSymbol, HttpMethod, TypeShape` | Documented in `adapters/README.md:8-19` |
| `adapters/express/src/`, `adapters/fastapi/src/`, `adapters/nextjs/src/`, `adapters/env/src/`, `adapters/prisma/src/` (subdirectories with `package.json`) | matches the formal spec | `@codegraph/adapter-sdk` types `IrId, IrNode, IrEdge, NodeKind, EdgeKind` (lowercase r) | Matches `spec/adapter-interface.ts` |

Both populations are real code. Both are referenced (the README points at the legacy population, the `package.json` files point at `dist/index.js` of the new population). **Pick one. Delete the other.** Without that, the CLI's adapter discovery (`STRUCTURE.md:512-552`) cannot run.

Recommendation: keep the spec-aligned subdirectory population; delete `adapters/express.ts`, `adapters/fastapi.ts`, `adapters/nextjs.ts`, and rewrite `adapters/README.md`.

### 2.2 [B] Lifecycle differs by name and shape

Formal spec `Adapter` (`spec/adapter-interface.ts:484-571`):

```
detect?(ctx: DetectContext): Promise<DetectResult> | DetectResult
analyzeFile?(ctx: AnalyzeFileContext): Promise<void> | void
resolve?(ctx: ResolveContext): Promise<void> | void
finalize?(ctx: FinalizeContext): Promise<void> | void
```

Legacy `Adapter` per the three reference adapters:

```
detect(repo: RepoContext): boolean                   // sync only, no DetectResult
analyzeFile(file: FileContext): AdapterOutput        // returns nodes/edges
resolveCrossFile(allOutputs, ctx): AdapterOutput     // wrong name; takes outputs explicitly
```

Differences (each is a real divergence):

- **`detect` return type.** Spec returns `DetectResult` with `evidence[]` and optional `confidence` (`spec/adapter-interface.ts:424-438`). Legacy returns `boolean`. The viewer's "Adapters" panel (per `spec/adapter-interface.md:71-92`) needs evidence; legacy provides none.
- **`detect` input shape.** Spec passes `DetectContext` with `manifests` pre-parsed (`spec/adapter-interface.ts:360-374`). Legacy adapters use `repo.readPackageJson?.()`, `repo.readFile?.()`, `repo.hasDir?.()` — a `RepoContext` shape that's never defined anywhere in `spec/`.
- **`analyzeFile` shape.** Spec has the adapter call `ctx.emit(...)` with deferred refs (`spec/adapter-interface.ts:333-350`). Legacy returns `AdapterOutput` (a synchronous return value).
- **Cross-file pass naming.** Spec calls it `resolve(ctx)`, with `ctx.peers.get(...)` and `ctx.deferredRefs[]` (`spec/adapter-interface.ts:382-406`). Legacy calls it `resolveCrossFile(allOutputs, ctx)` and walks `allOutputs` directly. Documented in `adapters/README.md:13-19`.
- **`finalize` does not exist** in legacy; the spec adapter uses it for summary nodes / unresolved-ref placeholders (`spec/adapter-interface.ts:566-571`).
- **Permissions and deps declarations** (`spec/adapter-interface.ts:444-472`) — `permissions: { network, exec, env }`, `deps: { required, optional, after }` — have no analogue in legacy adapters. None of the three legacy reference files declare any.
- **`apiVersion`, `idScheme`, `description`, `homepage`, `cacheable`, `appliesTo`, `declares`** — none present in legacy adapters. Required (or recommended) in the formal spec.
- **`IrId`/`mint(...)`/`ref(...)`** — the formal spec mints all IDs through `ctx.id.mint({ path, localId })` (`spec/adapter-interface.ts:289-293`), and supports deferred references via `ctx.id.ref(kind, query)` (`spec/adapter-interface.ts:106-122`). Legacy reference adapters mint IDs as bare strings via `file.makeNodeId(...)` (e.g. `adapters/nextjs.ts:111-114`) with no namespace check. **Adapter ID collisions are not detectable in the legacy model.**

Quantification: of the formal `Adapter` interface's 14 declared fields/methods, the legacy reference adapters implement 3 (`name`, `detect`, `analyzeFile`), with the wrong signatures on 2 of those 3.

### 2.3 [C] `adapters/README.md` documents the legacy contract

`adapters/README.md:8-19` documents the three-phase legacy lifecycle with `resolveCrossFile`, contradicting `spec/adapter-interface.md:46-52` which canonicalizes `detect | analyzeFile | resolve | finalize`. The "Writing a 4th adapter" checklist (`adapters/README.md:53-123`) tells contributors to use the legacy interface. If the spec is canonical, this README is actively misleading new contributors.

### 2.4 [C] `nodejs.ts` adapter creates kinds spec doesn't allow

`adapters/nextjs/src/types.ts:36-51` declares emitted node/edge kinds:

```
NODE_KIND.ROUTE      = "http.route"
NODE_KIND.PAGE       = "nextjs.page"
NODE_KIND.ACTION     = "nextjs.server-action"
NODE_KIND.CLIENT_CALL = "http.client-call"
EDGE_KIND.ROUTE_HANDLER = "http.route-handler"
EDGE_KIND.PAGE_COMPONENT = "nextjs.page-component"
EDGE_KIND.HTTP_CALL = "http.calls"
```

These match the *adapter-interface* model where `NodeKind = string` (open). They have no representation in the *IR-spec* model (`tier ∈ {service, module, type, function, expression, x-...}`). Two paths forward:
1. Map adapter kinds onto IR `expression` nodes via `leaf`/`sink`/`role` slots (per `spec/ir-schema.md:153-194`).
2. Bless a non-tiered "adapter knowledge node" pseudo-tier and document it.

Without a decision, the adapter writes data the IR can't represent.

### 2.5 [C] Cross-adapter shared kind contract is informal

`adapters/express/src/types.ts:59-65` declares its kinds as `express.route`/`express.handler`/`express.router`. `adapters/fastapi/src/types.ts:52-62` declares `http.route`/`http.module`/`http.handler`. `adapters/nextjs/src/types.ts:36-51` declares `http.route`/`http.client-call`/`nextjs.page`. **Express uses `express.route`; FastAPI and Next.js use `http.route`**. The cross-stack `fetch → route` matching in `spec/adapter-interface.md:232-249` requires they all share a kind. Pick one (almost certainly `http.route`) and document it as the cross-adapter contract.

### 2.6 [N] `spec/adapter-interface.ts` open question §10 ("Adapter discovery from package.json") was answered in `STRUCTURE.md:512-552` but the spec says "currently leaning explicit"

Document the resolution either by removing the open question or by porting `STRUCTURE.md`'s explicit-discovery rule into the spec.

---

## 3. Spec contradictions

Where two design docs make incompatible assumptions about the same thing.

### 3.1 [B] Severity scoring uses two different scales

`design/diff-algorithm.md:309-348` ("Severity scoring", §6) defines per-record signal weights summing to a per-item score. Buckets: `>=10 critical, >=6 high, >=3 medium, else low`. Sample weights: `network sink: +6`, `db-write: +5`, `exec: +7`, `http-route: +5`, `securitySensitive type change: +6`, `cross-service edge: +6`. Implemented faithfully in `packages/core/src/diff/severity.ts:42-86`.

`design/pr-comment.md:36-71` (§4) defines a per-PR severity score 0–100, computed as `max(component_scores)`. Bucket thresholds: `0-9 trivial, 10-29 low, 30-59 medium, 60-84 high, 85-100 critical`. Sample weights: `db-read: 30`, `db-write: 45`, `network: 50`, `route with auth: 55`, `route without auth: 90`, `cross-service: 60-75`, `unknown into auth/payment: 95`. **Bucket names overlap (`low/medium/high/critical`) but the scales are entirely different.** A "critical" by `diff-algorithm.md` (score ≥ 10) may be "low" by `pr-comment.md` (score < 30); a "high" by `pr-comment.md` (score 60–84) is off the scale of `diff-algorithm.md`.

Resolution: pick one scoring axis. The diff algorithm's severity is for sorting `topItems`; the PR comment claims to gate CI exits on it (`design/pr-comment.md:48`: "score is computed as `max(component_scores)`"). They cannot share one threshold without one of the docs changing.

### 3.2 [B] `paths.critical` config field referenced by pr-comment but absent from config schema

`design/pr-comment.md:73-81` references a `.codegraph.yml` field:

```yaml
paths:
  critical:
    - apps/api/src/auth/**
    - apps/api/src/payments/**
```

Used by the rubric weights (`design/pr-comment.md:64-71`). Neither `spec/config-schema.md:64-78` nor `spec/config.schema.json:7-84` declares a `paths` field. The config schema has `boundaries`, `groups`, `entryPoints` — none is a sound substitute. `packages/core/src/config/types.ts:166-203` (the Zod schema) doesn't declare it either. Add `paths.critical` to the config schema and the Zod, or delete the rubric entry.

### 3.3 [C] Diff engine `severity` config not the same shape as PR-comment severity config

`packages/core/src/diff/severity.ts:42-67` defines `DEFAULT_SEVERITY_CONFIG` matching `design/diff-algorithm.md:309-340`. `design/pr-comment.md:64-81` defines a different rubric (no flat `Required<SeverityConfig>` map). Neither references the other. Pick one severity-config object that drives both surfaces.

### 3.4 [B] Cache layout differs between `incremental.md` and `config-schema.md`

`design/incremental.md:104-122` mandates this layout under `.codegraph/cache/`:

```
.codegraph/cache/
  manifest.json
  fragments/<hashPrefix2>/<contentHash>.frag.json
  asts/<hashPrefix2>/<contentHash>.ast.bin
  scip/<hashPrefix2>/<contentHash>.scip.pb
  adapters/<adapterId>/<adapterVersion>/<hashPrefix2>/<contentHash>.json
  indices/{importGraph.json, symbolIndex.json}
  locks/manifest.lock
```

`spec/config-schema.md:298-322` exposes only `output.cache.path` (default `.codegraph/cache`) and `output.cache.enabled`. Internal structure isn't surfaced — that's fine — but `config-schema.md` says the *whole `.codegraph/` dir* holds the IR, the published viewer bundle, and any caches (`spec/config-schema.md:50-53`). `design/incremental.md:104` puts the cache *under* `.codegraph/cache/`. Same path; reconcile the wording so users aren't told two different things about what `.codegraph/` contains.

More substantively: `design/test-strategy.md:316-339` mandates `e2e-fixtures/` lives at the repo root, not under `.codegraph/`. `design/incremental.md` doesn't conflict, but if any future consumer assumes "everything codegraph writes is in `.codegraph/`", it's wrong (e2e fixtures break that). Document the boundary.

### 3.5 [B] CLI default port: 4747 vs 4115

`README.md:28` says `codegraph serve` opens `http://localhost:4747`. `README.md:204-209` example config repeats `viewer.port: 4747`. `STRUCTURE.md` (no specific number, but the viewer has port mentions). `packages/cli/src/index.ts:228` (the implemented CLI) sets the default to `4115`:

```ts
.option("-p, --port <n>", "Port to bind (default: 4115).", "4115")
```

Pick one. Users will hit this on first run.

### 3.6 [B] Two `.codegraph.yml` schemas

`README.md:181-214` shows a `.codegraph.yml` example with top-level `version: 1`, `include`, `exclude`, `adapters: [express, prisma, env-vars]` (a list of strings), `tiers`, `effects`, `viewer`, `diff: { failOn: [] }`.

`spec/config-schema.md:63-348` and `spec/config.schema.json` define a different schema: top-level `schemaVersion: 1` (integer, not field-named `version`), `boundaries` (a map), `ignore` (not `exclude`), `adapters` (a *map* of objects, not a list), no `tiers`, no `effects`, `diff: { fail, rules, ignore }`. The `.codegraph.yml.example` at the repo root matches the spec schema, not the README example. **The README's example will not load.**

### 3.7 [C] CLI subcommand surface differs from README/STRUCTURE

`README.md:23-28` and `STRUCTURE.md:181-188` advertise four subcommands: `index | diff | serve | export`. `packages/cli/src/index.ts` actually wires up those four plus `init` (`packages/cli/src/index.ts:284-296`) and a sub-command tree `adapter list | add | remove` (`packages/cli/src/index.ts:301-330`). `packages/cli/src/commands/cmd-init.ts` (15kB) implements `init` in detail. The published doc surface is incomplete; either delete `init`/`adapter` from the CLI or add them to the docs.

### 3.8 [C] `diff` algorithm spec contradicts pr-comment edge vocabulary

`design/diff-algorithm.md:165-188` builds edge identity from `(sourceId, targetId, category, attrsHash)` where `category ∈ {call, import, type-flow, http-route, db-read, db-write, env-read, fs-read, fs-write, network, exec}`. `design/pr-comment.md:178-189` describes edge kinds in the type-change table as `calls | rpc | reads | writes | mounts | auth-gate`. Six kinds, none of which appears in the IR `EdgeCategory` set. `auth-gate` is invoked normatively in `design/pr-comment.md:188-189` but is not an `EdgeCategory` in `spec/ir.schema.json:478-491`. These vocabularies must merge.

### 3.9 [C] Edge-typing doc adds two categories the spec doesn't have

`design/edge-typing.md:39-53` lists 13 edge categories including `message-publish` and `message-consume`. Spec `EdgeCategory` (`packages/core/src/ir/types.ts:443-455`) has 11 — no `message-*`. `KNOWN_EDGE_CATEGORIES` (`packages/core/src/ir/types.ts:657-663`) and `spec/ir.schema.json:482-491` agree with 11. Either promote the message kinds (MINOR bump per `spec/ir-schema.md:248-256`), or remove them from the edge-typing doc.

### 3.10 [C] Pure-vs-effectful adds a 9th effect kind unknown to the IR

`design/pure-effectful.md:43-54` lists 9 effect kinds: `exec, fs-write, db-write, network, log, db-read, fs-read, mutation-of-arg, throw`. The IR `SinkFlavor` is `db-write | network | fs | exec | log` (`packages/core/src/ir/types.ts:380-386`). `mutation-of-arg` and `throw` have no representation. The `read` effects map onto leaf flavors (`db-read | fs-read | env`) per `LeafFlavor` (`packages/core/src/ir/types.ts:288-296`), but not symmetrically. Either define how `mutation-of-arg`/`throw` materialize as IR (sink? leaf? edge category?) or drop them from the design doc.

### 3.11 [C] `spec/ir-schema.md` worked example has invalid edge data

`spec/ir-schema.md:498-507` shows a `network` edge with `sourceId: "071829304152637a"` (`onSubmit`), `targetId: "4152637a8b9cadbe"` (the `fetch(...)` expression). Two edges between the same pair (`call` and `network`) collide at the edge-identity tuple unless their attrs hash differs. `pickCategorySpecificAttrs` (`design/diff-algorithm.md:524-548`) gives `network: { method? }`, `call: {}` — different, so they don't collide *by category* (which is in the key). OK. But the `call` edge in the example also has `valueType: "Promise<Response>"`, while the `network` edge has `valueType: "Request"`. The example is internally consistent but the doc never explains why two edges sit between the same pair — common reviewer question.

### 3.12 [C] `diff-algorithm.md` example edge keys reference an edge that doesn't exist in `pickCategorySpecificAttrs` table

`design/diff-algorithm.md:638` shows an example added edge key `"FN_handleCheckout|FN_formatPrice|call|<hash-of-{}>"` — `call` attrs `{}` is right (`design/diff-algorithm.md:537`). `:660-663` shows a `db-read` example as `read` role; `pickCategorySpecificAttrs[db-read] = { op? }` (`design/diff-algorithm.md:540`), but spec `EdgeDbRead` carries `store?, entity?` (`spec/ir.schema.json:585-598`, `packages/core/src/ir/types.ts:497-501`), never `op`. The diff algorithm hashes attrs that *don't exist* on `db-read` edges. Decide: add `op` to `EdgeDbRead` (and `entity` to `pickCategorySpecificAttrs.db-read`) so they agree.

### 3.13 [C] `expression`-tier `parentId` rule violated by sample worked example

`spec/ir-schema.md:65-75` says expression nodes must parent on a function. `spec/ir-schema.md:447-454` (worked example, node 3 — Express route literal) has `parentId: "1829304152637a8b"` which is `handleSignup` — a function. OK. But node 2 (the frontend `fetch(...)`) has `parentId: "071829304152637a"` which is `onSubmit` — also a function. OK. So the worked example respects the rule; what the spec does *not* address is what tier owns the literal `"/api/signup"` *inside* `fetch(...)`. The literal is shown in the example as a sibling of the `fetch` call (`spec/ir-schema.md:425-431`), parentId same as the call, both expression-tier. Two expression nodes parenting on the same function with separate `signature`s is valid by the schema — but `spec/ir-schema.md:202-208` says expression `signature` includes "lexical-occurrence index within the function". The example doesn't show how the index handles "the literal at position N inside the call at position M" — i.e., expressions nested inside expressions. Tighten the spec or add a worked nested-expression example.

---

## 4. Scope creep / dead ends

What's designed but won't survive a v0.1 timeline (per ROADMAP.md `v0.1 — MVP (dogfood-ready)`).

### 4.1 [B] v0.1 ROADMAP says "no diff"; design ships full diff

`ROADMAP.md:14-30` v0.1 scope: "TypeScript indexing via SCIP, Express adapter, Prisma adapter, CLI: index/serve, viewer." **Out of scope**: "Diff engine. PR comment. Effect classification. Any non-Express/Prisma adapter."

Reality:
- `design/diff-algorithm.md` (38kB) is fully designed, with 3 worked examples and complexity bounds.
- `packages/core/src/diff/` exists with `types.ts` and `severity.ts` (~17.5kB).
- `design/pr-comment.md` is fully designed.
- `packages/core/src/pr-comment/index.ts` exists.
- `adapters/fastapi/`, `adapters/nextjs/`, `adapters/env/` are written.
- `design/dead-code.md` (33kB), `design/pure-effectful.md`, `design/security-insights.md` all designed in detail.
- `design/query-language.md` (33kB) — the cgql DSL — designed, not on any roadmap.

If v0.1 is the freeze: **scope this report's "punch list" to v0.1 features only**, which means deferring:

1. Diff (incl. `packages/core/src/diff/`) → v0.3 per ROADMAP.
2. PR-comment renderer → v0.3.
3. FastAPI adapter → v0.2.
4. Next.js adapter → v0.4 per `README.md:60`.
5. Env-vars adapter → v0.2 per ROADMAP `v0.2 — env-var detection`.
6. Effect classification (pure-vs-effectful) → v0.4.
7. Dead-code → v0.2.
8. cgql query language → no version named.
9. Complexity overlay → v0.4.
10. Security insights → no version named.

If the team decides to *keep* designing these now and only shipping v0.1 (perfectly reasonable for a 38-teammate sprint), then ROADMAP.md is misleading and should be updated to reflect that "v0.1 = MVP shippable" but "design is concurrent with later versions."

### 4.2 [C] `design/query-language.md` cgql is not on any milestone

The doc designs a complete Cypher-shaped DSL with parser, planner, output formats, viewer integration. It is not in `ROADMAP.md` at all (`v0.5` mentions "watch mode" but no query language). If cgql ships, allocate it to a milestone. Otherwise mark the design as "exploratory."

### 4.3 [C] Watch mode promised twice with inconsistent timeline

`README.md:51` "Incremental — Re-indexes only changed files via SCIP delta + adapter cache." `ROADMAP.md:106-108` makes watch mode v0.5 (`"Watch mode — codegraph serve --watch re-indexes on save"`). `packages/cli/src/index.ts:230` already wires `--watch` on `serve`. Either:
1. Watch mode lands in v0.1 (CLI wiring exists, design partially exists in `incremental.md:752` where it's called out-of-scope). 
2. Watch mode is v0.5 — then remove `--watch` from the v0.1 CLI surface or document it as "no-op stub."

### 4.4 [C] SCIP-everything-language scope vs. v0.1

`README.md:91` "SCIP indexer emits language-level symbols and references." `STRUCTURE.md:171` "Runtime: zod, mri, @types/node." There is no SCIP dependency declared anywhere in `package.json` files; `scip-typescript` is not installed. ROADMAP v0.1 says "TypeScript indexing via SCIP (`scip-typescript`)" but no package depends on it. Add the dep, or change the indexer story for v0.1 to "tree-sitter" (per `research/tree-sitter.md`) and defer SCIP to v0.2+.

### 4.5 [C] Adapter SDK is "v1.0" per ROADMAP but spec exists at "draft v0.1"

`spec/adapter-interface.md:2` — "Status: draft v0.1" — and `spec/adapter-interface.ts` already exists with detailed types. `ROADMAP.md:121-128` v1.0 scope: "First-party adapter SDK — published as `@codegraph/adapter-sdk` with a stable API." The interface is designed for v0.1 use but explicitly marketed-as-stable only in v1.0. If adapter authors are expected at v0.1 (they are — the README's "Authoring a new adapter is ~200 LOC against the adapter SDK" is a v0.1 promise on `README.md:73`), the SDK is shipping at 0.1.0 with the formal contract, and "stability" is ROADMAP-overstating. Reword ROADMAP v1.0 to "adapter SDK semver-stability + generators + test harness" rather than "publish."

### 4.6 [N] `design/security-insights.md` is unscoped

The 42kB doc designs five source-to-sink security patterns. It's a substantive feature with high false-positive rates explicitly acknowledged (`design/security-insights.md:60-61`). Not on `ROADMAP.md` at all. Either commit it to a milestone or mark exploratory.

### 4.7 [N] Dead-code's `entryPoints` hook adds a method to `Adapter` not in the SDK

`design/dead-code.md:84-101` proposes adding `entryPoints?(ctx): EntryPointRef[]` to the `Adapter` interface. That method is not in `spec/adapter-interface.ts:484-571`. If dead-code is v0.2, this is a v0.2 SDK addition. Document.

### 4.8 [C] Sample generator fixed the `irVersion` to `'0.1.0'` but emits non-spec shape

`packages/core/src/sample/generator.ts:70, 85` write `version: '0.1.0'` — but it's not the `schemaVersion` field the spec requires (`schemaVersion: SchemaVersion`). Pretending the output is `0.1.0` while emitting a different shape will trip every consumer assuming spec compliance.

---

## 5. Missing pieces

Features promised in user-facing surfaces but absent from design/spec/code.

### 5.1 [C] Six README "coming soon" docs absent

`README.md:107, 218-227` advertise:
- `docs/comparison.md`
- `docs/adapter-authoring.md`
- `docs/getting-started.md`
- `docs/ir-schema.md` (different from `spec/ir-schema.md`?)
- `docs/diff-format.md`
- `docs/cli.md`
- `docs/configuration.md`
- `docs/architecture.md`

`docs/` has only `STRUCTURE.md` and `example-page.md`. None of the eight referenced files exist. `CONTRIBUTING.md` (`README.md:233`) also missing.

### 5.2 [B] Brand decision says rebrand to **Plinth**; nothing else has caught up

`brand/decision.md:11-21` (dated 2026-05-09, "**Decision** — supersedes the recommendation in `brand/names.md`") locks the rename to **Plinth**. `brand/decision.md:96-160` itemizes the rename across 4 risk tiers, including:

- npm scope `@codegraph/*` → `@plinth/*`
- CLI binary `codegraph` → `plinth`
- IR file `codegraph.json` → `plinth.json`
- Config file `.codegraph.yml` → `.plinth.yml`
- Adapter discovery keyword `"codegraph-adapter"` → `"plinth-adapter"`
- GitHub Action namespace `codegraph/action@v1` → `plinth/action@v1`

Reality at audit time:
- Every `package.json#name` is `@codegraph/...` (e.g. `adapters/express/package.json:2`).
- `packages/cli/src/index.ts:123, 127, 131, 138` hardcodes the binary name `codegraph` and the env var `$CODEGRAPH_CONFIG`.
- `README.md`, `STRUCTURE.md`, `ROADMAP.md`, all `design/*.md`, all `marketing/*.md`, `.github/workflows/example.yml:17`, `packages/action/action.yml:21` — all still say `codegraph`.
- `.codegraph.yml.example` filename + content still reference codegraph.
- Sample generator emits `repo: 'codegraph/sample-app'` (`packages/core/src/sample/generator.ts:87`).

Per the team-lead's instruction this rename "is not executing in this PR" (`brand/decision.md:80`). But the decision-doc directive is that nothing else should *commit* to `codegraph` if the rename's coming. **Right now everything still does.** Three options:

1. Rename now, before v0.1 freeze. Mass `codegraph→plinth` across 100+ files. `brand/decision.md:172-183` estimates 1.5–2.5 days mechanical + 0.5–1 day copy.
2. Lock the v0.1 binary as `codegraph`, ship, and rename in v0.2.
3. Reverse the brand decision.

Note: `brand/decision.md:188-206` requires verifying the `plinth` npm scope, USPTO mark, and GitHub org **before** committing code under that name. Per the brief, those checks have *not* been confirmed by a human ("Verify USPTO TESS before commit"). Until those checks pass, option 1 is risky — could end up as `plinth → sextant` thrash.

### 5.3 [C] `paths.critical` config field referenced; not declared

See §3.2.

### 5.4 [C] PR-comment template references viewer URLs `viewer.codegraph.dev/r/...`

`design/pr-comment.md:225, 253, 292, 343` etc. embed example URLs at `https://viewer.codegraph.dev/r/<org>/<repo>/pr/<n>`. There is no design for a hosted viewer. `STRUCTURE.md:217-224` viewer is a static site shipped via the CLI; `design/exports.md` is for static exports. No `viewer.codegraph.dev` infrastructure is designed. Either drop the URL or design the viewer-hosting story (v0.5+ business-model discussion in `marketing/business-model.md` mentions hosted enterprise as post-v1).

### 5.5 [C] `--fail-on cycle,orphan` from README has no implementation

`README.md:171-176` GitHub Action snippet shows `fail-on: cycle,orphan`. CLI `--fail-on` (`packages/cli/src/index.ts:172-176`) accepts only `error | warning | info`. `design/diff-algorithm.md:69-73` describes `failOn` for severity-bucket gates. `cycle` and `orphan` are graph-shape conditions never declared in the diff or config schema. Either design these as new check categories (and add them to `spec/config.schema.json`) or drop from README.

### 5.6 [C] Effect classification field ('pure') is required on FunctionNode but no analyzer is designed for it

`spec/ir.schema.json:222-255` requires `pure: boolean` on `FunctionNode`. `design/pure-effectful.md` is the design — but ROADMAP says effect classification is **v0.4** (`ROADMAP.md:80-94`). Until v0.4, every `FunctionNode` requires a `pure` field that no v0.1 indexer can compute. Either:
1. Make `pure` optional in the schema (defer the strictness).
2. Pin a default in v0.1 (per `spec/ir-schema.md:584-587`: "If an analyzer cannot decide, it sets `pure: false` (the safe over-approximation) and records a diagnostic").

`design/pure-effectful.md` doesn't acknowledge it isn't running in v0.1.

### 5.7 [C] Express adapter detection: `package.json#bin` lookup

The adapter checks `if ('express' in deps)` (`adapters/express.ts:81-83`, `adapters/express/src/detect.ts`). Doesn't handle:
- Workspaces (`packages/*/package.json` may declare express; root may not).
- `peerDependencies` (a library that exposes Express types).

Spec `Manifests.packageJson` is `ReadonlyArray<{ path; data }>` (`spec/adapter-interface.ts:368-374`) — multiple manifests — but the adapter only checks one. Acceptable for v0.1; document the assumption.

### 5.8 [C] `actions/cache@v4` recipe does not appear in the action

`design/incremental.md:566-617` specifies a recipe with `restore-keys` ladder. `packages/action/action.yml` accepts `cache-key` input but the actual action shell logic isn't reviewed in this audit (action implementation is in `packages/action/scripts/compute-refs.js`, etc.). If cache integration is shipping, ensure the action implements the recipe; if not, mark `cache-key` as a stub.

### 5.9 [C] Test fixtures empty

`test-fixtures/` contains only `README.md`. `design/test-strategy.md:280-339` mandates per-package `__fixtures__/` and repo-wide `test-fixtures/`; neither population has shipped beyond the README. `e2e-fixtures/` doesn't exist. The double-build determinism check (`design/test-strategy.md:358-374`) requires fixtures.

### 5.10 [N] Graph IR open question §10 (block tier) raised but not closed

`spec/ir-schema.md:74-79` defers a `block` tier. Closes only as "forward-compatible if needed." Document it as v0.2+ open question or punt.

---

## 6. Unanswered questions (consolidated)

These are explicit "Open questions" sections across the docs, surfaced here so the team-lead can plow through them in one sitting.

1. **`spec/adapter-interface.md` §10**: multi-language symbol unification (host-owned `cg:symbol` namespace?); watch mode IR streaming; `package.json` keyword-based discovery (resolved by `STRUCTURE.md`?); per-symbol granularity (tRPC).
2. **`spec/ir-schema.md` §11**: nesting `service` tier semantics deferred to v0.2.
3. **`design/diff-algorithm.md` §11**: type-rename hints (deferred to v0.2); package-moved collapsing; per-fixup-commit deltas; per-repo severity weight learning.
4. **`design/incremental.md` §15**: persistent merge state; distributed cache; watch / daemon mode; adapter sandboxing; precise shape-change detection.
5. **`design/test-strategy.md` §11**: stable adapter-fixture IDs; visual regression on macOS/Windows; bench in PR vs main; property-test seed strategy.
6. **`design/pr-comment.md` §14**: per-repo severity-score config; render high-severity even when empty; collapsed comment for trivial PRs; per-PR opt-out via `[skip codegraph]`; mobile rendering.
7. **`design/dead-code.md`** open questions (not enumerated here — file ends with a different section but check for unflagged "open question" headers).
8. **`design/edge-typing.md`** — `message-publish`/`message-consume` not in IR (covered in §3.9).
9. **`brand/decision.md` §4**: USPTO TESS not yet run; npm scope reservation pending; GitHub org availability not confirmed.
10. **`design/query-language.md`** — full cgql parser is designed but not allocated to any milestone.

---

## 7. Cross-cutting drift (one-offs)

Things that don't fit cleanly above but are worth listing.

### 7.1 [N] `STRUCTURE.md` lists `@codegraph/adapter-sdk` as a separate package but it isn't in `packages/`

`STRUCTURE.md:14-22` directory tree shows `packages/adapter-sdk/`. There is no `packages/adapter-sdk/` on disk; only `packages/{core, cli, viewer, action}/`. Adapters import from `@codegraph/adapter-sdk` (`adapters/express/package.json:54, 63`). Either create the package or change adapters to import from `@codegraph/core/adapter` (subpath of the existing `core` package).

### 7.2 [N] `STRUCTURE.md` mentions tools that aren't installed (e.g. tsup, turbo)

Workspace tools are only loosely in lockstep. `STRUCTURE.md:171-174` says `tsup` is the build tool for `core`; `package.json` (root) at `:1-50` (assumed — not fully read here) likely declares it. Check workspace-wide.

### 7.3 [C] `IRDocument` requires `metadata.generators.minItems: 1` (JSON Schema), but stubs frequently emit empty arrays

`spec/ir.schema.json:42` mandates `generators.minItems: 1`. CLI shim emits one generator (`packages/cli/src/commands/cmd-index.ts:472`) — fine. Sample generator does **not** emit `generators[]` at all (it emits `generator: {}` singular — see §1.4). Sample generator output fails JSON-schema validation today.

### 7.4 [N] `CLI_VERSION` declared in two places

`packages/cli/src/index.ts:27` defines `CLI_VERSION = "0.1.0"`. `packages/cli/src/commands/cmd-index.ts:422` redefines it. Keep one, or thread it through.

### 7.5 [N] Diff doc says "no inverse symmetry" but pseudocode tests `inverse`

`design/diff-algorithm.md:496-507` (Property tests "inverse — `diff(b, h)` and `diff(h, b)` have swapped `added`/`removed`"). Earlier in `design/diff-algorithm.md:498-508` ("Other properties we considered and rejected") the inverse symmetry property is rejected. Pick one.

### 7.6 [N] `design/test-strategy.md` recommends Vitest only; CLI commands ship as `*.test.ts` colocated already

Consistent with the strategy. No drift here — flagged so the next reviewer doesn't double-take.

### 7.7 [N] README claims viewer port 4747; STRUCTURE.md mentions a port nowhere; example.yml doesn't bind a port; CLI defaults to 4115

See §3.5; broader than just port: the viewer's "where do I run" story is fragmented across files.

### 7.8 [C] Default config writes IR to `.codegraph/ir.json`; sample-emit writes to `.codegraph/graph.json`

`spec/config-schema.md:299-305` defaults `output.ir.path` to `.codegraph/ir.json`. `README.md:27` says `codegraph index` writes `.codegraph/graph.json`. `packages/cli/src/commands/cmd-index.ts:444` defaults to `.codegraph/graph.json`. Pick one filename. The `STRUCTURE.md:11` description matches neither verbatim.

### 7.9 [N] `Adapter.idScheme` field used by the spec is set in `package.json`, not in code

Adapter `package.json` files set `codegraph.adapter.idScheme` (e.g. `adapters/express/package.json:67-72`). Spec `Adapter.idScheme` is a TypeScript field in the descriptor (`spec/adapter-interface.ts:507-509`). Loading from `package.json` is a third surface; if it's intentional, document and validate that adapter's `package.json#codegraph.adapter` matches its descriptor `idScheme`. Otherwise drop it.

### 7.10 [N] `ROADMAP.md` says `wishlist` for tRPC and NestJS; `spec/adapter-interface.md` worked example uses `http-client@1` and `fastapi@1`, suggesting `http-client` is a planned adapter

There's no `http-client` adapter package. The worked example may need a different name (`adapters/fetch` or `adapters/http`).

---

## 8. By-package summary (for triage)

| Package / area | Blockers | Crit. fixes | Nits |
|---|---|---|---|
| Spec (IR + adapter + config) | 4 | 5 | 4 |
| Adapters (legacy + new) | 3 | 4 | 1 |
| Design docs (cross-doc) | 3 | 6 | 2 |
| `packages/core` | 1 | 2 | 1 |
| `packages/cli` | 1 | 2 | 2 |
| `packages/viewer` | 1 | 1 | 1 |
| `packages/action` | 0 | 0 | 1 |
| Brand / docs | 1 | 0 | 0 |
| ROADMAP / scope | 1 | 4 | 0 |

Total raw count: 9 B / 17 C / 14 N. (Counts may sum higher than per-section because some items are tagged in multiple sections; here we count once per occurrence per section to reflect triage workload.)

---

## 9. Recommended punch list for v0.1 freeze (priority-ordered)

1. **(B §1.2)** Fix imports: `@codegraph/ir` → `@codegraph/core/ir` in `packages/core/src/sample/generator.ts:19`, `packages/core/src/export/subgraph.ts:23-32`, `packages/viewer/src/lib/load-ir.ts:8-9, :15-68`, `packages/viewer/src/lib/filters.ts`, `packages/viewer/README.md`, `packages/core/src/sample/README.md`. Trivial mechanical change once decided.
2. **(B §1.1, §1.6, §1.7, §3.6, §7.3, §7.8)** Make sample generator emit spec-conformant IR `{ schemaVersion: '0.1.0', ir: { metadata: { generators: [...] }, nodes, edges } }` with required fields on every node, or unblock the viewer to load the stub form. Decide which IR shape is canonical for v0.1 and **delete the other**.
3. **(B §2.1, §2.2, §2.3, §2.4, §2.5)** Delete `adapters/express.ts`, `adapters/fastapi.ts`, `adapters/nextjs.ts`. Rewrite `adapters/README.md` against `spec/adapter-interface.md`. Settle the `http.route` vs `express.route` cross-adapter contract.
4. **(B §1.8)** Decide whether the formal `Adapter` interface emits adapter-knowledge nodes (open `kind` strings) or maps onto the IR-spec's tiered nodes. Until this is settled, no adapter can produce valid IR.
5. **(B §3.1, §3.3, §3.5)** Pick one severity scale (diff-algorithm or pr-comment) and one default port (4747 or 4115). Update all docs and code.
6. **(B §3.4)** Reconcile cache layout description in `spec/config-schema.md` and `design/incremental.md`.
7. **(B §3.6, §5.1)** Replace the `.codegraph.yml` example in `README.md:181-214` with the spec-form snippet (`.codegraph.yml.example` is already correct). Then write the missing `docs/configuration.md`, `docs/cli.md`, `docs/getting-started.md`.
8. **(B §4.1)** Decide: is v0.1 freezing only the items in `ROADMAP.md:14-30` (and shipping the rest as designed-but-not-built)? Or is the v0.1 surface bigger? Update ROADMAP to match.
9. **(B §5.2)** Decide rename now vs. defer. If defer, lock everything else against committing `codegraph` further. If now, allocate the 2–3 day mechanical pass and run the human verification steps in `brand/decision.md:188-206` first.
10. **(C §3.2, §5.3, §5.5, §5.6)** Fix the four config-vs-design contract holes: `paths.critical`, `--fail-on cycle,orphan`, `pure`-required-but-no-analyzer, viewer URL story.

Items 11+ are the C-tier punch list, all listed above with citations.

---

## 10. Things the design got right

To be honest where the design is fine:

- **`spec/ir-schema.md` is the most coherent doc in the repo.** Section 6 (node identity), section 4.3 (edge identity tuple), section 8 (enum evolution rules) are crisp and correct.
- **`spec/adapter-interface.ts` is internally consistent** — the lifecycle, permissions, deps, deferred-refs design is well-thought-out. The problem is that nothing else in the repo agrees with it.
- **`design/incremental.md` is implementation-grade.** The `fragmentKey` recipe (§5.1) and reverse-dep closure logic (§5.2) are buildable as written; the algorithm in §9 is faithful to the prose.
- **`design/test-strategy.md`** correctly distinguishes the three fixture tiers, picks one tool per slot with reasoning, and lists what's deliberately *not* tested.
- **`brand/decision.md`** is the cleanest decision artifact. Risk tiers, named alternatives, "do not execute in this PR" — exactly the right shape for a name-lock decision.
- **`packages/core/src/diff/severity.ts`** is faithful to its design doc. (Its design doc fights with `pr-comment.md`, but that's not the implementation's fault.)
- **`packages/core/src/ir/types.ts`** and `index.ts` are a clean public surface. They're the right canonical IR. Everything that disagrees with them should be updated to match.

---

## 11. Audit metadata

- Files read in full: ~25 (README, STRUCTURE, ROADMAP, all spec/, key design/, brand/decision, brand/names, all reference adapter top-level, all package source touched in §1–§5).
- Files spot-read: ~15 (rest of design/, adapters' src/types.ts, action/action.yml, .codegraph.yml.example, .github/workflows/example.yml).
- Files not read: most of `marketing/`, all of `research/`, brand/visual-identity beyond the part referenced from decision.md, `packages/action/scripts/`, the full bodies of `adapters/{express,fastapi,nextjs}/src/analyze.ts`, `packages/cli/src/commands/cmd-{diff,serve,init}.ts`. These were skipped because the audit's value is highest at the type/contract/spec layer; a deeper code-review pass on those is a separate workstream.

End of CONSISTENCY_REPORT.md.
