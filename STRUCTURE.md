# codegraph — Monorepo Structure

This document is the source of truth for the codegraph repository layout.
It defines every package, its public API surface, its dependencies, and
the conventions every contributor must follow when adding or modifying a
package.

> codegraph is an MIT-licensed, deterministic, no-LLM static-analysis
> tool. It compiles a codebase to a typed graph IR, renders that IR in a
> React Flow viewer, and diffs successive IRs in a GitHub Action.

## 1. Top-level layout

```
codegraph/
├── packages/
│   ├── core/              # IR types, schema, indexer, diff       (lib)
│   ├── cli/               # `codegraph` command                    (bin)
│   ├── viewer/            # React + Vite + React Flow viewer       (app)
│   ├── action/            # GitHub Action wrapper around CLI       (app)
│   └── adapter-sdk/       # Public API for third-party adapters    (lib)
├── adapters/
│   ├── express/           # First-party adapter — Express routes
│   ├── fastapi/           # First-party adapter — FastAPI routes
│   ├── nextjs/            # First-party adapter — Next.js routes/RSC
│   ├── prisma/            # First-party adapter — Prisma schema → models
│   └── …                  # More first-party adapters added over time
├── docs/                  # User-facing documentation site source
├── design/                # Design tokens, Figma exports, mockups
├── brand/                 # Logos, color tokens, marks
├── marketing/             # Landing-page copy, screenshots
├── research/              # Prior-art notes, experiments
├── spec/                  # IR specification (versioned)
├── test-fixtures/         # Sample projects used by integration tests
├── .github/               # CI workflows, issue/PR templates
├── pnpm-workspace.yaml    # Workspace definition (this repo)
├── package.json           # Root scripts + dev tooling
├── turbo.json             # Turborepo task pipeline
├── tsconfig.base.json     # Shared TS compiler options
└── STRUCTURE.md           # ← you are here
```

`docs/`, `design/`, `brand/`, `marketing/`, `research/`, `spec/`, and
`test-fixtures/` are **not** workspace packages — they hold content, not
publishable code. Only `packages/*` and `adapters/*` are listed in
`pnpm-workspace.yaml` so pnpm does not waste time symlinking them and
turbo does not consider them as cache inputs.

## 2. Dependency graph

### 2.1 Build-time dependency graph

```
                    ┌─────────────────────┐
                    │   @codegraph/core   │
                    │ (IR + schema + diff)│
                    └──────────┬──────────┘
            ┌──────────────────┼──────────────────────────────┐
            │                  │                              │
            ▼                  ▼                              ▼
 ┌────────────────────┐ ┌─────────────────┐  ┌────────────────────────┐
 │ @codegraph/        │ │ @codegraph/cli  │  │ @codegraph/viewer      │
 │ adapter-sdk        │ │  (codegraph)    │  │ (React + Vite + Flow)  │
 └─────────┬──────────┘ └────────┬────────┘  └────────────────────────┘
           │                     │
           │                     ▼
           │           ┌──────────────────────┐
           │           │  @codegraph/action   │
           │           │ (GitHub Action shim) │
           │           └──────────────────────┘
           ▼
   ┌──────────────────────────────────────────────────┐
   │  adapters/express  fastapi  nextjs  prisma  …    │
   │  (each depends on  @codegraph/adapter-sdk only)  │
   └──────────────────────────────────────────────────┘
```

Cardinal rules:

1. **Adapters never import `@codegraph/core` directly.** They import
   `@codegraph/adapter-sdk`, which re-exports the *stable* subset of
   core's types. This is the only mechanism that lets us refactor
   `core`'s internals without breaking the adapter ecosystem.
2. **`viewer` never imports `cli` or `action`.** The viewer is a pure
   client that loads a JSON IR document. It depends only on `core` for
   the IR type definitions.
3. **`action` is a thin wrapper.** It depends on `cli` (to invoke
   `codegraph`) and on `@actions/core` and `@actions/github` for the
   GitHub Action runtime; it never reaches into `core` directly.
4. **No cycles.** Any new edge in the graph requires updating this
   document and `turbo.json` in the same PR.

### 2.2 Runtime adapter discovery (NOT a build-time edge)

The CLI loads adapters at runtime, not at compile time. See §7.

## 3. Build order

Turborepo computes the order from `dependsOn: ["^build"]` plus the
explicit per-package overrides in `turbo.json`. The resulting topological
order is:

| Phase | Package(s) built in parallel                                       |
| ----- | ------------------------------------------------------------------ |
| 1     | `@codegraph/core`                                                  |
| 2     | `@codegraph/adapter-sdk` (parallel with phase-2 leaf packages)     |
| 2     | `@codegraph/cli`                                                   |
| 2     | `@codegraph/viewer`                                                |
| 3     | All `adapters/*` (each depends only on `adapter-sdk`)              |
| 3     | `@codegraph/action` (depends on `cli`)                             |

Run `pnpm build` from the repo root and turbo handles the rest. Use
`pnpm build:core` (etc.) to build a single package. Filtered builds via
`pnpm turbo run build --filter='./adapters/*'` build all adapters
without rebuilding `cli` or `viewer`.

## 4. Package details

### 4.1 `packages/core` — `@codegraph/core`

**Purpose.** The single source of truth for the IR. Nothing else in the
repo defines IR types. Owns three concerns:

1. **IR types and schema.** TypeScript types + a Zod schema kept in
   lockstep. The schema is the runtime validator; the types are derived
   via `z.infer`.
2. **Indexer orchestration.** Takes a project root + a list of resolved
   adapter modules and produces a fully-typed IR document.
3. **Diff algorithm.** Computes a structural diff between two IR
   documents (added/removed/changed nodes + edges, with stable IDs).

**Build target.** ESM library, dual-published with CJS fallback via
`tsup`. Emits `.d.ts` for every public export.

**Public exports** (from `src/index.ts`):

```ts
// Types
export type { IR, IRNode, IREdge, IRMetadata } from "./ir/types";
export type { NodeKind, EdgeKind } from "./ir/kinds";
export type { DiffResult, DiffEntry } from "./diff/types";
export type { IndexerOptions, IndexerResult } from "./indexer/types";

// Runtime
export { IRSchema, validateIR } from "./ir/schema";
export { createIndexer, runIndexer } from "./indexer";
export { diffIR } from "./diff";
export { IR_SCHEMA_VERSION } from "./ir/version";

// Errors (named — no default export)
export {
  CodegraphError,
  IRValidationError,
  AdapterLoadError,
} from "./errors";
```

**Internal-only modules** (NOT exported, NOT imported by other packages):

- `src/indexer/walker.ts` — file-system traversal
- `src/indexer/registry.ts` — adapter registry (used internally by `cli`)
- `src/diff/hash.ts` — content-addressed node hashing

If a third-party tool needs one of those, it goes through
`@codegraph/adapter-sdk`, not direct import.

**Dependencies.**

- Runtime: `zod` (catalog), `mri` (tiny argv parser), `@types/node` (dev)
- Peer: none

**Build commands.**

```bash
pnpm --filter @codegraph/core build       # tsup → dist/{esm,cjs,types}
pnpm --filter @codegraph/core test
pnpm --filter @codegraph/core typecheck
```

### 4.2 `packages/cli` — `@codegraph/cli`

**Purpose.** The user-facing `codegraph` command. Subcommands:

| Subcommand          | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `codegraph index`   | Scan a project, run adapters, emit `codegraph.json` (the IR).   |
| `codegraph diff`    | Compare two IR files (or two refs); emit a structured diff.     |
| `codegraph serve`   | Spawn the bundled viewer pointing at a local IR file.           |
| `codegraph export`  | Render an IR to SVG / DOT / Mermaid for static docs.            |

**Build target.** Node CJS + ESM bundle via `tsup`. Ships a single
`bin/codegraph.mjs` entry resolved from `package.json#bin`.

**Public exports.** The CLI is a binary, not a library. `package.json`
intentionally has no `main`/`module`/`exports` for programmatic use —
consumers who want CLI behavior in-process should use `@codegraph/core`
directly. (We may add a programmatic `runCommand()` export later, but
explicitly behind a `0.x` unstable flag.)

**Dependencies.**

- `@codegraph/core` (workspace, exact)
- `commander` (subcommand parsing — `mri` from core is too minimal here)
- `picocolors` (no-emoji terminal coloring)
- `tinyglobby` (fast glob)
- `@codegraph/viewer` (workspace, exact) — for `codegraph serve` to find
  the prebuilt viewer assets at `node_modules/@codegraph/viewer/dist`.

**Build commands.**

```bash
pnpm --filter @codegraph/cli build
pnpm --filter @codegraph/cli test
pnpm codegraph -- index .         # exec the local CLI
```

### 4.3 `packages/viewer` — `@codegraph/viewer`

**Purpose.** Browser app that loads an IR JSON document and renders it
as a React Flow graph. Includes layout (ELK), filters, search, and a
side panel for node details.

**Build target.** Vite static-site build. The output is a fully static
`dist/` directory (HTML + hashed JS/CSS) that:

- the CLI ships and serves via `codegraph serve`, and
- the docs site embeds via an `<iframe>` on the demo page.

**Public exports.** None as a library. The package's `main` points at
the prebuilt `dist/index.html` location for the CLI to find. We
deliberately do **not** publish the React components for reuse at
`0.x` — keeping the viewer's internals private lets us refactor the
component tree without semver pain. Consumers who want to embed graphs
in their own React app should consume the IR + React Flow directly.

**Dependencies.**

- `@codegraph/core` (workspace, exact) — IR types only, tree-shaken
- `react`, `react-dom` (peer 18 || 19)
- `reactflow`
- `elkjs` (layout)
- `zustand` (UI state)
- `vite`, `@vitejs/plugin-react` (dev)

**Build commands.**

```bash
pnpm --filter @codegraph/viewer dev        # vite dev server
pnpm --filter @codegraph/viewer build      # vite build → dist/
pnpm --filter @codegraph/viewer preview    # vite preview of dist/
```

### 4.4 `packages/action` — `@codegraph/action`

**Purpose.** GitHub Action that runs `codegraph` on a PR, posts a diff
comment, and uploads the IR + viewer build as a workflow artifact.

**Build target.** A single bundled `dist/index.js` produced by `ncc`
(Vercel's bundler). GitHub Actions requires the action's runtime
dependencies be checked in to the repo, so `dist/` is committed. (This
is the standard Actions convention; see `.github/workflows/build.yml`
for the verification step that fails CI if `dist/` is stale.)

**`action.yml`** declares the inputs and the entry point. Inputs:

| Input         | Required | Default            | Description                              |
| ------------- | -------- | ------------------ | ---------------------------------------- |
| `path`        | no       | `.`                | Project root to index                    |
| `base-ref`    | no       | `${{ github.base_ref }}` | Ref to diff against                |
| `comment`     | no       | `true`             | Post a PR comment with the diff summary  |
| `upload`      | no       | `true`             | Upload the IR JSON as an artifact        |

**Public exports.** None — it is an Action, not a package consumers
import.

**Dependencies.**

- `@codegraph/cli` (workspace, exact) — bundled into `dist/index.js`
- `@actions/core`, `@actions/github`, `@actions/exec`
- `@vercel/ncc` (devDependency, build-only)

### 4.5 `packages/adapter-sdk` — `@codegraph/adapter-sdk`

**Purpose.** The contract between codegraph and the framework adapter
ecosystem. Every adapter — first-party or third-party — implements the
`Adapter` interface from this package and depends only on this package.

**Build target.** ESM + CJS dual-build via `tsup`. Tiny — mostly types
and a handful of helper functions.

**Public exports** (from `src/index.ts`):

```ts
// The contract.
export interface Adapter {
  readonly name: string;            // unique adapter id, e.g. "express"
  readonly version: string;         // adapter package version
  readonly supportedIRVersion: string; // semver range against IR_SCHEMA_VERSION

  /** Decide whether this adapter applies to the given project. */
  detect(ctx: DetectContext): Promise<boolean>;

  /** Walk the project and yield IR fragments. */
  index(ctx: IndexContext): AsyncIterable<IRFragment>;
}

export type { DetectContext, IndexContext, IRFragment } from "./types";

// Re-export the *stable* subset of @codegraph/core types so adapters
// only ever import from `@codegraph/adapter-sdk`.
export type {
  IR,
  IRNode,
  IREdge,
  NodeKind,
  EdgeKind,
} from "@codegraph/core";

// Test helpers (importable at @codegraph/adapter-sdk/testing).
// See `package.json#exports`.
```

**Why this exists.** Without `adapter-sdk`, adapters would import
`@codegraph/core` directly and any change to core's internals would
break every adapter at once. The SDK gives us a versioned shim where
breaking changes are explicit and rare.

**Dependencies.**

- `@codegraph/core` (workspace, peer + dev) — see §6 for the peer-dep
  pattern that prevents duplicate IR type identities at runtime.

### 4.6 `adapters/*` — first-party framework adapters

Each adapter is its own package, `@codegraph/adapter-<name>`:

- `adapters/express`  → `@codegraph/adapter-express`
- `adapters/fastapi`  → `@codegraph/adapter-fastapi`
- `adapters/nextjs`   → `@codegraph/adapter-nextjs`
- `adapters/prisma`   → `@codegraph/adapter-prisma`

**Common rules.**

- Each `package.json` includes the keyword `"codegraph-adapter"` so the
  CLI can auto-discover it (see §7).
- Each must export a default `Adapter` from `src/index.ts`:
  ```ts
  import type { Adapter } from "@codegraph/adapter-sdk";
  const adapter: Adapter = { /* … */ };
  export default adapter;
  ```
- Each declares `@codegraph/adapter-sdk` as a `peerDependency` (so a
  user's project resolves a single SDK version across all adapters) and
  as a `devDependency` (so the adapter's own tests run).
- No adapter may import `@codegraph/core` directly. The lint config
  enforces this with a `no-restricted-imports` rule.

## 5. Shared TypeScript strategy

### 5.1 `tsconfig.base.json`

Lives at the repo root. Every leaf `tsconfig.json` extends it:

```jsonc
// packages/core/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "./.tsbuildinfo"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/*.test.ts"]
}
```

The base config sets every `strict` flag plus `noUncheckedIndexedAccess`
and `exactOptionalPropertyTypes`. We don't make those opt-in: codegraph
is a static-analysis tool — the IR's correctness is the entire product.

### 5.2 We do NOT use TypeScript project references

Project references (`composite: true` + per-package `references`) are a
common monorepo pattern, but they fight tsup/vite's bundler-style module
resolution and add a parallel build graph that duplicates turbo's work.
Instead:

- Each package builds its own `.d.ts` via tsup (`dts: true`).
- Cross-package imports resolve through `package.json#exports` at build
  time (turbo guarantees `^build` runs first).
- `paths` in `tsconfig.base.json` (see file) only exists so the editor's
  TS server jumps to source instead of `.d.ts`. It is not used by tsup
  or vite — both honor `package.json#exports`.

### 5.3 `tsconfig.json` per package — required overrides

Every package's `tsconfig.json` MUST set, at minimum:

| Field                        | Reason                                        |
| ---------------------------- | --------------------------------------------- |
| `compilerOptions.rootDir`    | Pin source root so emitted layout is stable.  |
| `compilerOptions.outDir`     | Write to package-local `dist/`.               |
| `include`                    | Whitelist `src/**/*`; never use `**/*`.       |
| `exclude`                    | Always exclude `dist`, `node_modules`, tests. |

The viewer additionally sets `jsx: "react-jsx"` and includes the DOM
lib. The action additionally sets `module: "CommonJS"` because GitHub
Actions' Node runtime resolves the bundled `dist/index.js` as CJS.

## 6. Version policy

### 6.1 Recommendation: independent versioning via Changesets

We recommend **independent versioning** for all packages, managed by
[Changesets](https://github.com/changesets/changesets). Each PR that
ships a user-visible change adds a markdown changeset declaring which
packages bump and at what semver level.

#### Why not lockstep (single version for all packages)?

Lockstep is appealing for a young project — one version number, no
matrix to think about, no skew between packages. But it has three
specific costs that hurt codegraph in particular:

1. **Adapters churn at a different cadence than core.** A bug fix in
   `@codegraph/adapter-fastapi` should not force a new release of
   `@codegraph/viewer`. With lockstep, every adapter patch bumps every
   package — and users who pin `@codegraph/cli@1.4.2` see version drift
   they did not opt into.
2. **The IR schema version is the real contract.** The promise we make
   to users is *"this CLI version produces IR vN, which this viewer
   version can render"*. That contract is encoded as
   `IR_SCHEMA_VERSION` inside `@codegraph/core` — it is cleaner to
   surface that explicitly than to pretend npm version numbers
   guarantee compatibility.
3. **Third-party adapters can't be lockstepped.** The moment we tell
   the community "publish your own adapter", a single global version
   number stops describing reality. Independent versioning matches the
   actual topology.

#### What independent versioning looks like in practice

- `@codegraph/core` and `@codegraph/adapter-sdk` advance together
  whenever the IR schema changes. Bumping core's major usually bumps
  the SDK's major too — Changesets makes this trivial: one changeset
  with both packages listed.
- `@codegraph/cli` advances on its own for CLI-only changes (new flags,
  better error messages).
- Each adapter advances on its own. The adapter's `peerDependencies`
  declares the `@codegraph/adapter-sdk` major it supports; npm's
  resolver then enforces the contract.
- `@codegraph/viewer` advances on its own for UI changes; it pins the
  `@codegraph/core` version it was built against because IR JSON
  shapes flow across the wire.

#### Compatibility matrix

The user-visible compatibility story is the IR schema version, not the
package versions:

```
@codegraph/core@1.x         → IR_SCHEMA_VERSION = 1
@codegraph/adapter-sdk@1.x  → supports IR_SCHEMA_VERSION ^1
@codegraph/adapter-*@*      → declares its supportedIRVersion
@codegraph/cli@*            → reports the IR version it emits
@codegraph/viewer@*         → reports the IR version range it can render
```

The CLI checks `adapter.supportedIRVersion` against the running
`IR_SCHEMA_VERSION` and refuses to load adapters that disagree.

### 6.2 Pre-1.0 caveat

While the project is on `0.x`, every change is treated as potentially
breaking and every release bumps minor. We will move to 1.0 only when
the IR schema is stable enough that we are willing to commit to semver
across it. That commitment lives in `spec/IR_VERSIONING.md` (separate
document).

### 6.3 Internal workspace ranges

In each `package.json`, workspace deps use `workspace:^` for runtime
dependencies between our own packages. pnpm rewrites these at publish
time to the matching version. Example from `packages/cli`:

```jsonc
{
  "dependencies": {
    "@codegraph/core": "workspace:^",
    "@codegraph/viewer": "workspace:^"
  }
}
```

For peer-dep declarations (e.g. an adapter declaring it needs
`@codegraph/adapter-sdk`), use `workspace:*` so pnpm pins to the exact
in-repo version during local development; Changesets rewrites it to a
semver range on publish.

## 7. Adapter discovery

The CLI discovers adapters at **runtime**, not at build time. This is
how the third-party adapter ecosystem works without us having a
hard-coded import list.

### 7.1 Discovery algorithm

When the user runs `codegraph index`, the CLI does the following, in
order:

1. **Read explicit config.** If `codegraph.config.{ts,js,json}` exists
   at the project root and lists adapters, use exactly that list. This
   is the escape hatch — explicit always wins.

2. **Scan `package.json#dependencies` and `devDependencies`.** For each
   entry whose name matches `@codegraph/adapter-*` OR
   `codegraph-adapter-*` (the third-party convention), the CLI does a
   `require.resolve` from the project root and dynamically `import()`s
   it. The default export must satisfy the `Adapter` interface from
   `@codegraph/adapter-sdk`.

3. **Validate via the `codegraph-adapter` keyword.** The CLI reads each
   candidate's `package.json` and confirms `keywords` includes the
   string `"codegraph-adapter"`. Packages without the keyword are
   skipped with a warning. This prevents accidental name collisions.

4. **Validate the IR version.** Every loaded adapter must have a
   `supportedIRVersion` semver range that includes the running
   `IR_SCHEMA_VERSION`. Mismatches abort with a clear error pointing the
   user at the upgrade path.

5. **De-duplicate.** If the same adapter `name` is loaded twice (e.g.
   the user has both `@codegraph/adapter-express` and a fork at a
   different path), the CLI errors out unless the config file
   explicitly picks one.

### 7.2 Why runtime discovery, not bundled imports?

We considered three alternatives and rejected each:

| Alternative                                        | Why we rejected it                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| Hard-code first-party adapter imports in the CLI   | Excludes third-party adapters entirely. Non-starter.               |
| Plugin manifest committed to the codegraph repo    | Requires a release of the CLI for every new third-party adapter.   |
| Auto-fetch adapters from npm at run time           | Network at index time = non-deterministic. Violates the no-LLM/    |
|                                                    | deterministic premise of the product.                              |

Runtime discovery via `package.json` keywords keeps the CLI hermetic
(no network), keeps third-party authorship friction-free, and matches
how ESLint, PostCSS, and other static-analysis tools have solved the
same problem.

### 7.3 Authoring a third-party adapter (concise checklist)

A separate `docs/AUTHORING_ADAPTERS.md` covers this in depth. The
condensed version:

1. `pnpm create codegraph-adapter my-framework` (template scaffold —
   future work).
2. Implement the `Adapter` interface from `@codegraph/adapter-sdk`.
3. In `package.json`:
   - Name: `codegraph-adapter-<framework>` (recommended) or anything
     containing the literal string `codegraph-adapter`.
   - `keywords` includes `"codegraph-adapter"`.
   - `peerDependencies` includes `@codegraph/adapter-sdk@^X`.
4. Publish to npm. The user installs your adapter in their project and
   the CLI picks it up automatically on the next `codegraph index`.

## 8. Workspace scripts (root `package.json`)

Every script delegates to turbo so caching works:

| Script                | What it runs                                            |
| --------------------- | ------------------------------------------------------- |
| `pnpm build`          | `turbo run build` — full build in topological order     |
| `pnpm build:core`     | Build only `@codegraph/core`                            |
| `pnpm build:adapters` | Build all `adapters/*`                                  |
| `pnpm dev`            | Run every package's `dev` task in parallel              |
| `pnpm dev:viewer`     | Just the viewer's vite dev server                       |
| `pnpm test`           | `turbo run test`                                        |
| `pnpm test:unit`      | Unit tests only (no integration fixtures)               |
| `pnpm test:integration` | Integration tests using `test-fixtures/`              |
| `pnpm lint`           | `turbo run lint`                                        |
| `pnpm lint:fix`       | ESLint with `--fix`                                     |
| `pnpm typecheck`      | `turbo run typecheck` — `tsc --noEmit` per package      |
| `pnpm format`         | Prettier write across the whole tree                    |
| `pnpm format:check`   | Prettier check (used in CI)                             |
| `pnpm check`          | `turbo run lint typecheck test` — the CI gate           |
| `pnpm clean`          | Remove `dist/`, `node_modules`, `.turbo`                |
| `pnpm changeset`      | Author a new changeset                                  |
| `pnpm version-packages` | Apply pending changesets to bump versions             |
| `pnpm release`        | Build everything publishable + `changeset publish`      |

## 9. Conventions and constraints

### 9.1 No emoji in source, output, or docs

The CLI never prints emoji. Terminal coloring goes through `picocolors`,
which is opt-out via `NO_COLOR=1`. This document follows the same rule.

### 9.2 Public API is `src/index.ts`

Every package's public API is precisely what `src/index.ts` re-exports.
Anything else is private. The lint config bans deep imports across
package boundaries (`@codegraph/core/internal/foo` is a lint error).

### 9.3 No default exports from libraries

`core`, `adapter-sdk`, and `cli` use only named exports (TypeScript
ergonomics + auto-import behavior + clean tree-shaking). Adapter
packages are the sole exception — they MUST `export default` an
`Adapter` so the CLI can `import(pkg).then(m => m.default)`.

### 9.4 Tests live next to source

`packages/core/src/diff/diff.test.ts` rather than
`packages/core/test/diff.test.ts`. Integration tests that need a fixture
project go under `packages/<pkg>/test/integration/` and reference
`test-fixtures/` via relative paths.

### 9.5 No circular workspace deps, ever

Enforced by `turbo` (which would refuse to compute a build order) and
by a CI step that runs `pnpm list --recursive --depth=0 --json` and
asserts no cycles.

## 10. Assumptions and open questions

These are the assumptions made in this layout. Each is testable; if any
proves wrong we revise this document and the corresponding files.

1. **Node 20 is the minimum.** `package.json#engines.node` enforces it.
   We assume contributors are on Node 20+ locally.
2. **pnpm 9 is the package manager.** Locked via `packageManager` in
   `package.json` so Corepack picks the right version.
3. **Turborepo is acceptable.** Alternatives (Nx, Moon, Lage) were
   considered; turbo's lower ceremony and good remote-cache story won.
   Switching later would require rewriting `turbo.json` but no other
   files.
4. **Changesets is the version manager.** Could swap for `release-please`
   without changing this layout.
5. **The viewer is bundled with the CLI.** `codegraph serve` resolves
   the viewer's prebuilt `dist/` from `node_modules`. An alternative
   was to publish the viewer as a separate `npx codegraph-viewer`; we
   chose the bundled path so users only install one package.
6. **Prebuilt action checked in.** `packages/action/dist/` is committed
   per GitHub Actions convention. CI verifies it is up to date.
7. **First-party adapters live in this repo.** They could live in their
   own repo for independence, but co-locating them lets us run
   integration tests against `core` and `adapter-sdk` on every PR. This
   trade-off can be revisited when the adapter count exceeds ~10.
8. **The `adapters/*` directory contains only adapter packages.** No
   shared adapter utilities live there; if we need them, they go into
   `packages/adapter-sdk` or a new `packages/adapter-utils` package, so
   the discovery glob never matches a non-adapter.

## 11. Quick reference — adding a new package

To add a new first-party package (rare):

1. Create `packages/<name>/` with `package.json`, `src/index.ts`,
   `tsconfig.json` (extending `tsconfig.base.json`), and `tsup.config.ts`.
2. Set the package name to `@codegraph/<name>`.
3. Declare any `@codegraph/*` workspace deps with `workspace:^`.
4. Add an entry to the dependency graph diagram in §2.1 of this file.
5. If the build order is non-trivial, add a `<name>#build` task to
   `turbo.json`.
6. Add a changeset describing the addition.

To add a new first-party adapter (common):

1. Create `adapters/<framework>/` with `package.json`, `src/index.ts`,
   `tsconfig.json`, `tsup.config.ts`, and a `README.md`.
2. Set the package name to `@codegraph/adapter-<framework>`.
3. Add `"codegraph-adapter"` to `keywords`.
4. `peerDependencies`: `@codegraph/adapter-sdk: workspace:*`.
5. Implement and `export default` an `Adapter`.
6. Add a fixture project under `test-fixtures/<framework>/` and a
   smoke test that runs the CLI against it.
7. Add a changeset.
