<div align="center">

<img src="brand/logo.svg" alt="codegraph" width="180" />

### See your codebase as a graph. Diff it on every PR.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/codegraph.svg)](https://www.npmjs.com/package/codegraph)
[![GitHub stars](https://img.shields.io/github/stars/codegraph/codegraph?style=social)](https://github.com/codegraph/codegraph)
[![Discord](https://img.shields.io/discord/000000000000000000?label=discord&logo=discord&color=5865F2)](https://discord.gg/codegraph)
[![CI](https://img.shields.io/github/actions/workflow/status/codegraph/codegraph/ci.yml?branch=main&label=CI)](https://github.com/codegraph/codegraph/actions)

</div>

---

**codegraph** is a static-analysis tool that compiles your codebase into a typed graph IR — services, modules, functions, types, side effects — and renders it as an interactive map. No LLM. No hosted backend. No telemetry. Plug it into a GitHub Action and every PR shows you exactly what shifted in the architecture.

![demo](docs/demo.gif)

<div align="center"><sub>Indexing a 40k-LOC TypeScript monorepo, exploring service boundaries, and diffing a PR. <em>(asset coming soon)</em></sub></div>

## Quickstart

```bash
npm install -g codegraph        # install the CLI
codegraph index                 # produce ./.codegraph/graph.json
codegraph serve                 # open the viewer at http://localhost:4747
```

That's it. No config required for TypeScript projects with Express or Prisma — adapters auto-detect.

## Why codegraph

- **PR-diffed.** Every pull request renders an architectural diff: nodes added, edges rerouted, cycles introduced. Reviewers stop guessing what a 600-line refactor actually changed.
- **Typed edges.** Edges aren't just "calls" — they're `http-route`, `db-query`, `event-publish`, `imports-type`, each with the resolved type flowing through them. Filter by edge kind to see only the I/O graph, only the type graph, only the data graph.
- **Pure vs. effectful coloring.** Functions are classified by their effect set (pure, IO, network, DB, mutation). Spot the unexpectedly-impure leaf in a "pure" module before it ships.
- **MIT, no backend.** Runs entirely in your CI and on `localhost`. Your source never leaves your machine. Fork it, vendor it, ship it inside an enterprise — there's nothing to phone home.

## Features

| | | |
|---|---|---|
| 🧭 | **Interactive viewer** | React Flow canvas with service / module / function tiers and one-click drilldown. |
| 🔬 | **Typed graph IR** | Stable JSON schema you can query, diff, or pipe into your own tooling. |
| 🧩 | **Framework adapters** | Pluggable resolvers that lift HTTP routes, DB queries, queues, and env vars into first-class edges. |
| 🟢 | **Effect classification** | Every function tagged pure / IO / network / DB / mutation, propagated through the call graph. |
| 🔁 | **PR diff mode** | Symmetric graph diff renders added / removed / changed nodes and edges in the viewer and a PR comment. |
| 🦀 | **SCIP-backed** | Indexing rides on Sourcegraph's SCIP — the same indexer that powers Sourcegraph and code-search at scale. |
| ⚡ | **Incremental** | Re-indexes only changed files via SCIP delta + adapter cache. |
| 🪶 | **Zero runtime overhead** | Pure static analysis. Nothing is injected, instrumented, or run. |

## Supported frameworks

| Language | Framework | Status |
|---|---|---|
| TypeScript | Express | ✓ |
| TypeScript | Prisma | ✓ |
| TypeScript | Next.js | planned (v0.4) |
| TypeScript | Drizzle | planned (v0.4) |
| TypeScript | tRPC | wishlist |
| TypeScript | NestJS | wishlist |
| Python | FastAPI | planned (v0.2) |
| Python | SQLAlchemy | planned (v0.2) |
| Python | Django | wishlist |
| Go | net/http, chi | planned (v0.5) |
| Go | sqlc, GORM | planned (v0.5) |
| Rust | Axum | planned (v0.5) |
| Rust | sqlx, Diesel | planned (v0.5) |
| IaC | Terraform | planned (v0.5) |
| IaC | Kubernetes manifests | wishlist |

Authoring a new adapter is ~200 LOC against the adapter SDK. See [`docs/adapter-authoring.md`](docs/adapter-authoring.md) *(coming soon)*.

## How it works

```
   ┌──────────┐    ┌──────────┐    ┌──────────────┐    ┌──────────┐    ┌────────┐
   │  source  │ -> │   SCIP   │ -> │   adapters   │ -> │ graph IR │ -> │ viewer │
   │  files   │    │  indexer │    │ (framework-  │    │  (json)  │    │ (react │
   │          │    │          │    │  aware lift) │    │          │    │  flow) │
   └──────────┘    └──────────┘    └──────────────┘    └─────┬────┘    └────────┘
                                                             │
                                                             v
                                                       ┌──────────┐    ┌────────┐
                                                       │   diff   │ -> │   PR   │
                                                       │  engine  │    │ comment│
                                                       └──────────┘    └────────┘
```

1. **SCIP indexer** emits language-level symbols and references.
2. **Adapters** lift framework patterns (`app.get('/users')`, `prisma.user.findMany()`) into typed edges.
3. **Graph IR** is the canonical artifact — committed, diffed, served.
4. **Viewer** renders it. **Diff engine** compares two IRs and emits the PR comment payload.

## Compared to alternatives

| | codegraph | Sourcegraph | Madge | Dependency-cruiser | Mermaid-from-AST |
|---|---|---|---|---|---|
| Typed edges (HTTP, DB, events) | ✓ | partial | — | — | — |
| Framework-aware | ✓ | — | — | — | — |
| PR diff | ✓ | — | — | partial | — |
| Pure-vs-effectful coloring | ✓ | — | — | — | — |
| Self-hosted, no backend | ✓ | — | ✓ | ✓ | ✓ |
| MIT | ✓ | — | ✓ | mixed | mixed |

Full comparison: [`docs/comparison.md`](docs/comparison.md) *(coming soon)*.

## Installation

**npm**

```bash
npm install -g codegraph
```

**pnpm**

```bash
pnpm add -g codegraph
```

**yarn**

```bash
yarn global add codegraph
```

**bun**

```bash
bun add -g codegraph
```

**Homebrew** *(coming soon)*

```bash
brew install codegraph
```

**From source**

```bash
git clone https://github.com/codegraph/codegraph
cd codegraph
pnpm install && pnpm build
pnpm link --global
```

## GitHub Action

Drop this in `.github/workflows/codegraph.yml` to render an architectural diff on every PR:

```yaml
name: codegraph
on:
  pull_request:
    branches: [main]

jobs:
  graph-diff:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: codegraph/action@v1
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
          comment: true            # post a PR comment
          fail-on: cycle,orphan    # optional: fail CI on these graph deltas
```

## Configuration

`codegraph` works zero-config for most projects. Drop a `.codegraph.yml` at the repo root to override:

```yaml
# .codegraph.yml
version: 1

include:
  - "src/**/*.ts"
  - "packages/*/src/**/*.ts"
exclude:
  - "**/*.test.ts"
  - "**/dist/**"

adapters:
  - express
  - prisma
  - env-vars

tiers:
  service: { match: "packages/*" }
  module:  { match: "src/*/index.ts" }

effects:
  # treat these symbols as effect roots
  network: ["fetch", "axios.*", "got.*"]
  db:      ["prisma.*", "knex.*"]

viewer:
  port: 4747
  layout: layered            # layered | force | radial
  defaultTier: module

diff:
  failOn: []                 # cycle | orphan | publicApiBreak
```

Full schema: [`docs/configuration.md`](docs/configuration.md) *(coming soon)*.

## Documentation

- [Getting started](docs/getting-started.md) *(coming soon)*
- [Graph IR schema](docs/ir-schema.md) *(coming soon)*
- [Adapter authoring guide](docs/adapter-authoring.md) *(coming soon)*
- [PR diff format](docs/diff-format.md) *(coming soon)*
- [CLI reference](docs/cli.md) *(coming soon)*
- [Configuration reference](docs/configuration.md) *(coming soon)*
- [Architecture](docs/architecture.md) *(coming soon)*
- [Roadmap](ROADMAP.md)

## Contributing

We love contributors. Adapters are the highest-leverage place to start — most production stacks need one.

- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) *(coming soon)*.
- Browse [good-first-issue](https://github.com/codegraph/codegraph/labels/good%20first%20issue).
- Join the [Discord](https://discord.gg/codegraph) — there's a `#adapters` channel for design discussion.

## Sponsors

codegraph is independent and MIT. If your team relies on it, [sponsor on GitHub](https://github.com/sponsors/codegraph) — that's how the maintainers keep adapters landing every week.

*Become the first sponsor.*

## License

[MIT](LICENSE). Use it anywhere, including inside commercial and enterprise codebases. No attribution required, but always appreciated.
