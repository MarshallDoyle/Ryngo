# plinth.dev — Landing Page Copy (Production)

> Status: ship-ready. Locked name: **Plinth** (per `brand/decision.md`, 2026-05-09).
> Supersedes `brand/landing-copy.md`. Strings here map 1:1 to React components in the eventual `marketing/site/`.
> Voice: technical, concrete, warm. Verb-first hero. Capability matrix as the load-bearing artifact. No AI gradient/glow. Top-row Discord badge.
> Forbidden words and approved phrasing carry forward from `brand/landing-copy.md` §forbidden-words / §approved-phrasing — re-asserted at the bottom for the lint pass.

---

## 0. Meta

- **Page title (browser tab):** Plinth — your codebase, on a typed graph
- **Meta description (155 chars):** Plinth compiles your codebase to a typed graph IR, renders it in your browser, and posts a graph diff on every PR. MIT, no LLM, local-first.
- **Open Graph image alt:** A wireframe call graph rendered in light gray on a near-black background, with one path of seven nodes highlighted in chartreuse — the answer to a query of the form "callers of authenticate."
- **Twitter card:** `summary_large_image`
- **Canonical URL:** `https://plinth.dev/`
- **Theme color (`<meta name="theme-color">`):** `#0A0A0B` (Pitch)
- **Favicon:** wireframe-cube mark with a `P` carved into negative space; 16px fallback is a solid Volt square with a Pitch lowercase `p` cut out (see `brand/visual-identity.md` §5.5, with the C→P swap from `brand/decision.md`).

---

## 1. Hero

### H1 (locked)

**Your codebase, on a typed graph.**

Six words. Possessive lead. The verb is implied — *"sits on"* — and that is the brand metaphor: a plinth is the base a structure rests on. The H1 doesn't name the product; the wordmark above it does that work.

### H1 alternatives (held in reserve, do not ship without an A/B)

- **A:** `Index any codebase as a typed graph.` — Verb-first per the marketing-inspiration brief (Pattern 1). Stronger for HN/cold-traffic skim.
- **B:** `Static analysis, rendered.` — Maximally compressed. Best for launch-week paid placements, weak on cold organic traffic.

### Subhead (under 25 words)

Plinth compiles your repo to a typed graph IR, renders it in the browser, and posts a graph diff on every pull request.

(22 words. Three concrete verbs: compiles, renders, posts. Three artifacts: IR, browser view, PR comment.)

### Three-pill positioning row (under the subhead, above the CTAs)

`MIT licensed`  ·  `No LLM, no cloud`  ·  `Runs in CI`

Each pill is the exact text above. Rule-bordered chips, mono, 14px, `Ash` text on `Pitch`. The middle dot is a real `·` (U+00B7), not three dots.

### CTAs (two buttons, no signup gate)

**Primary CTA (filled `Volt` background, `Pitch` text):**
- Label: `$ install`
- Trailing: a Volt-on-Pitch caret cursor `▌` that does not blink
- Href: `/docs/quickstart`

**Secondary CTA (transparent, 1px `Rule` border, `Bone` text):**
- Label: `Read the docs`
- Trailing: `→` (real Unicode `→`, not an SVG)
- Href: `/docs`

A third inline CTA — `View on GitHub  ★ {GITHUB_STAR_COUNT}` — sits to the right of the two buttons on desktop and stacks below on mobile. Star count fetched at build time, cached 10 minutes, falls back to `—` (em-dash, never `0`).

### Hero illustration (right column on desktop, full-width on mobile)

A wireframe isometric rendering of an actual call graph from the Plinth dogfood repo. Roughly 30–50 nodes, drawn as small hollow squares (4px). Connector edges in `Bone #ECEDEE` at 30% opacity, except for one path — five to seven nodes connected end-to-end — rendered in `Volt #C8FF3D` at full opacity. The Volt path is the visible answer to a query.

A small mono caption underneath the illustration:
```
plinth query 'callers of authenticate'
```
With a non-blinking Volt cursor `▌` after the closing quote.

The path lights up *once* on first paint (50ms per segment, ~300ms total), then sits still. Honors `prefers-reduced-motion` by rendering the lit-path final state immediately.

### Above-the-fold proof line (between CTAs and the bottom of the hero)

Three small mono rows, each prefixed with a `Volt` `>`:
```
> 14 languages supported
> indexes 1M LOC in <30s on a laptop
> no LLM in the hot path
```

Each row's value (the number / phrase) is in `Bone`; the label half is in `Ash`. Tabular figures.

### Hero terminal card (alternative right-column treatment, A/B against illustration)

Three-tab terminal-card aesthetic. Default tab `install`. No fake typing. Switch is instant.

**Tab 1 — `install` (default):**
```sh
$ pnpm add -D plinth && pnpm plinth index
indexing 1,247 files across 4 adapters... done in 3.1s
wrote .plinth/graph.json (842 KB, 4,981 nodes, 12,304 edges)
```

**Tab 2 — `graph.json`:**
```json
{
  "schemaVersion": "0.1",
  "schemaHash": "blake3-128:4f2a91...c19b",
  "indexedAt": "2026-05-08T14:27:11Z",
  "nodes": [
    {
      "id": "ts:src/server/handlers/createUser.ts#createUser",
      "kind": "function",
      "lang": "typescript",
      "purity": "effectful",
      "loc": { "file": "src/server/handlers/createUser.ts", "line": 42 }
    },
    {
      "id": "prisma:User",
      "kind": "model",
      "adapter": "prisma",
      "purity": "data",
      "loc": { "file": "prisma/schema.prisma", "line": 18 }
    },
    {
      "id": "next:route:/api/users[POST]",
      "kind": "route",
      "adapter": "next",
      "purity": "effectful",
      "loc": { "file": "src/app/api/users/route.ts", "line": 9 }
    }
  ],
  "edges": [
    {
      "from": "next:route:/api/users[POST]",
      "to": "ts:src/server/handlers/createUser.ts#createUser",
      "kind": "calls",
      "evidence": "default export -> handler"
    },
    {
      "from": "ts:src/server/handlers/createUser.ts#createUser",
      "to": "prisma:User",
      "kind": "writes",
      "evidence": "prisma.user.create"
    }
  ]
}
```

**Tab 3 — `query`:**
```sh
$ plinth query 'paths from "next:route:/api/users[POST]" to "prisma:User"'
1 path, 2 hops:
  next:route:/api/users[POST]
    -> ts:src/server/handlers/createUser.ts#createUser  (calls)
    -> prisma:User                                       (writes)
```

**Caption beneath the card (small, muted):**
The same graph feeds the viewer, the PR action, the query CLI, and any tool you build on top.

---

## 2. The problem

### Section eyebrow

`Why a graph`

### Section H2

**Code search shows you strings. You need to see structure.**

### Body — paragraph 1

Grep finds `createUser` in 47 places. Your IDE's call hierarchy walks one language at a time and gives up at the network boundary. Neither tells you that `createUser` writes to a Prisma model that's read by a Next.js route deployed by a Terraform module — the sequence of hops that actually matters when you're shipping a change. Every senior engineer ends up reconstructing that graph in their head, on a whiteboard, or in a Notion doc that goes stale the day it's written.

### Body — paragraph 2

The usual escapes don't escape. AI search returns confident summaries with no edges to click on, and re-derives the same graph badly on every query. Hand-drawn architecture diagrams age out within a sprint. Static-analysis tools like ctags and language servers stop at the file or language boundary, so a TypeScript handler calling a Python worker over HTTP looks like two unrelated programs. Plinth is the missing artifact: a typed, queryable graph of your whole repo, regenerated from source on every commit.

### Pull-quote (right of paragraph 2, muted)

> Most architecture decisions are graph decisions. Most architecture documentation is prose. That's the whole problem.

### Body — paragraph 3 (render only if column has space)

The graph isn't a separate artifact you maintain. It's compiled from the code on every push, the same way the type checker runs. When the graph and the code disagree, the code wins — so the graph is never out of date by definition.

---

## 3. How it works

### Section eyebrow

`Pipeline`

### Section H2

**Source in. Graph out. Four stages.**

### Sub-headline

The pipeline is deterministic and cache-friendly. A 100k-line monorepo indexes in under 30 seconds on a laptop after the first run.

### Step 1 — Index

- **Label:** `01 Index`
- **Technical:** Walks your repo, parses every supported file with tree-sitter, and emits a per-file fact stream.
- **For you:** Runs on the unchanged half of your codebase from cache. Re-indexing a single PR takes 200–800ms.

### Step 2 — Adapters

- **Label:** `02 Adapters`
- **Technical:** Framework-aware modules turn raw facts into semantic edges. Express adapters know what `app.post('/users', handler)` means; Prisma adapters know what `prisma.user.create` writes.
- **For you:** Your graph reflects your stack, not just your AST. An HTTP call is an `http_call` edge, not a string match.

### Step 3 — IR

- **Label:** `03 IR`
- **Technical:** Adapters merge into a single typed graph IR (JSON, schema-versioned). Every node has a stable BLAKE3-128 ID; every edge has a kind, evidence, and source location.
- **For you:** One artifact you can `diff`, query with `jq`, ship to CI, or load into any tool you already use.

### Step 4 — Viewer / Action

- **Label:** `04 Viewer / Action`
- **Technical:** The same IR powers the React Flow viewer (`plinth serve`) and the GitHub Action that posts a graph diff comment on every PR.
- **For you:** Read it locally during a refactor. Read it in the PR during review. Same graph, two surfaces.

### Visual cue (described, not generated)

A four-column horizontal pipeline. Each column is a `Slab`-bordered card with the step label in mono small-caps at top, the technical line in mono Bone, and the "For you" line in sans Ash. Between columns: a single 1px `Rule` arrow `→` in `Volt`. No glow. No gradient. The four cards are equal width on desktop and stack vertically on mobile.

---

## 4. Languages and capabilities (the load-bearing matrix)

### Section eyebrow

`Capability matrix`

### Section H2

**Honest about what we extract. Honest about the gaps.**

### Sub-headline

Every row corresponds to a real fixture in `bench/fixtures/`. Each "stable" cell has a passing test in CI; each "experimental" cell has open issues; each "planned" cell has a target version on the roadmap.

### Matrix — rows are languages, columns are capabilities

| Language | Imports | Calls | Class hierarchy | Types | Generics | Effects | Status |
|---|---|---|---|---|---|---|---|
| **TypeScript** | stable | stable | stable | stable | stable | stable | shipping |
| **JavaScript** | stable | stable | stable | inferred | n/a | partial | shipping |
| **Python** | stable | stable | stable | typed-only | n/a | partial | shipping |
| **Go** | stable | stable | stable | stable | stable | partial | shipping |
| **Rust** | stable | stable | n/a | stable | stable | experimental | beta |
| **Java** | stable | stable | stable | stable | stable | planned | beta |
| **C#** | stable | stable | stable | stable | stable | planned | beta |
| **Ruby** | stable | stable | stable | inferred | n/a | planned | experimental |
| **PHP** | stable | stable | stable | inferred | n/a | planned | experimental |
| **Kotlin** | planned | planned | planned | planned | planned | planned | v0.6 |
| **Swift** | planned | planned | planned | planned | planned | planned | v0.6 |
| **Elixir** | planned | planned | n/a | n/a | n/a | planned | wishlist |

**Footnote (small, muted):**
"Inferred" means we infer types from imports and call shapes; we do not run a type checker. "n/a" means the language has no concept of that capability. Adapters compose on top of language coverage — a Python file is parsed once and consumed by both the Python language adapter and the FastAPI adapter when it applies.

### Frameworks (separate sub-table)

| Language | Framework | Edge kinds extracted | Status |
|---|---|---|---|
| TypeScript | Express | `http_route`, `http_call` | shipping |
| TypeScript | Next.js | `http_route`, `rsc_boundary`, `http_call` | shipping |
| TypeScript | Prisma | `db_model`, `reads`, `writes` | shipping |
| TypeScript | Drizzle | `db_model`, `reads`, `writes` | beta |
| TypeScript | tRPC | `rpc_route`, `rpc_call` | beta |
| TypeScript | NestJS | `http_route`, `provider` | wishlist |
| Python | FastAPI | `http_route`, `dependency` | shipping |
| Python | SQLAlchemy | `db_model`, `reads`, `writes` | beta |
| Python | Django | `http_route`, `db_model`, `reads`, `writes` | wishlist |
| Go | net/http, chi | `http_route`, `http_call` | beta |
| Go | sqlc, GORM | `db_model`, `reads`, `writes` | beta |
| Rust | Axum | `http_route`, `http_call` | beta |
| Rust | sqlx, Diesel | `db_model`, `reads`, `writes` | wishlist |
| IaC | Terraform | `deploys`, `provisions`, `references` | beta |
| IaC | Kubernetes manifests | `deploys`, `references` | wishlist |

**Below the framework sub-table:**
Authoring a new adapter is ~200 LOC against the adapter SDK. See [`/docs/adapters`](/docs/adapters).

---

## 5. Performance

### Section eyebrow

`Benchmarks`

### Section H2

**One number, run on a fixture you can rerun.**

### The number

> **Plinth indexes the React monorepo (3.4M LOC, 9 packages) in 38s cold and 740ms warm — 2.8x faster than scip-typescript on the same fixture.**

### Reproducing

```sh
git clone https://github.com/plinth/plinth
cd plinth/bench/fixtures/react
./bench.sh    # outputs cold + warm timings, plus scip-typescript comparison
```

The fixture pins a specific React commit. The benchmark script runs both indexers three times each on the same machine, drops the slowest, and reports the median. Hardware listed in `bench/README.md`. If your machine reports very different numbers, please open an issue with the output — we want the page benchmark to match real laptops, not a CI runner.

We picked one number deliberately. A wall of charts is benchmark theater; one reproducible ratio against a named comparator is a check the reader can run.

---

## 6. Install

### Section eyebrow

`Install`

### Section H2

**Three commands.**

### Sub-headline

Works in any pnpm, npm, or yarn workspace. Node 20+. No global install, no daemon, no account.

```sh
pnpm add -D plinth
```

```sh
plinth index
```
*Walks the repo, runs adapters, writes `.plinth/graph.json`.*

```sh
plinth serve
```
*Opens the viewer at `http://127.0.0.1:4747`.*

**Inline note:** Add to CI in 8 lines: see the [GitHub Action snippet](#7-github-action) below.

---

## 7. GitHub Action

### Section eyebrow

`On every PR`

### Section H2

**Reviewers see the change in the graph, not just the diff.**

### Sub-headline

The Action runs on `pull_request`, indexes the head and base commits, and posts a single comment with what changed in the IR. The viewer link opens a side-by-side render of the same diff.

### Code block (copy-paste ready)

```yaml
name: plinth
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
      - uses: plinth/action@v1
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
          comment: true
          fail-on: cycle,orphan
```

### Embedded screenshot (described — do NOT generate)

A GitHub pull request page in light mode. The PR title is `feat(billing): switch invoice generator to streaming`. Pinned at the top of the conversation timeline is a comment authored by `plinth-bot`. The comment header reads `plinth · graph diff for #482`.

**Comment body (rendered as it would appear in GitHub):**

> **+12 nodes  ·  -3 nodes  ·  18 edges changed**
>
> - **Added:** `streamInvoice` (effectful), `chunkPDF` (pure), `flushBuffer` (effectful), +9 more
> - **Removed:** `buildInvoiceBlob`, `gzipInvoice`, `uploadBlob`
> - **Edge changes:** `InvoiceJob → S3Bucket` (writes) replaced by `InvoiceJob → CloudfrontEdge` (writes, streaming)
>
> [`Open graph diff →`](https://plinth.dev/diff/482)

**Annotation (described, not generated):** a single thin Volt arrow points from the right margin to the comment, with a hand-lettered label `this comment posts on every PR`. Below the arrow, smaller secondary text in mono Ash: `~3s on a 100k-line monorepo, runs on the standard ubuntu-latest runner`.

---

## 8. Compared to alternatives

### Section eyebrow

`How it compares`

### Section H2

**The other tools weren't built for this.**

### Prose comparison (no vs.-table — see `research/marketing-inspiration.md` Part 6)

**vs. Sourcegraph SCIP.** SCIP is the closest neighbor and powers Sourcegraph itself. What SCIP gives you that Plinth doesn't: a mature enterprise indexer ecosystem and a hosted code search at scale. What Plinth gives you that SCIP doesn't: a viewer, a GitHub Action that posts a graph diff per PR, framework-aware typed edges (HTTP routes, DB queries, queues), and a JSON-first schema you can pipe into your own tooling. Plinth ingests SCIP indexes when they're available — it's a layer on top, not a replacement.

**vs. CodeQL.** CodeQL is a security-analysis query engine. It gives you a database of facts and a query language. Plinth is a step earlier in the pipeline: a typed graph IR you can render or query however you like. If you have a security-analysis question, CodeQL is the right tool. If you want to see, navigate, or diff your architecture, Plinth is.

**vs. AI code search.** Cursor's index, Codeium, and the Greptile-class tools build embeddings and answer questions in natural language. They're great at fuzzy "what does this code mean" and bad at "give me every path from a handler to a database write." Plinth is the inverse: deterministic, structural, byte-stable. The same commit produces the same graph on every machine. There is no model version to pin.

**vs. Madge / Dependency-cruiser.** These are file-level and import-level dependency tools. Plinth is symbol-level and edge-typed. Madge tells you `auth/handler.ts` imports `db/client.ts`. Plinth tells you `createUser:effectful` writes `User:model` via `prisma.user.create`. Different question, different answer.

**vs. Mermaid-from-AST and other diagram-from-code generators.** Static images. No diff, no query, no incremental rebuild, no PR comment. If you need a static diagram, those still work. If you need an artifact you can compose tools around, Plinth is the layer.

Full comparison: [`/compare`](/compare).

---

## 9. Adapters

### Section eyebrow

`Adapters`

### Section H2

**Works with what you're already using.**

### Sub-headline

Adapters turn framework-specific patterns into typed graph nodes and edges. Each one is a small module under `adapters/`. Write your own in an afternoon — the API is one function: `adapt(facts: Fact[]): GraphFragment`.

### Logo grid (described, not generated)

A 6-column responsive grid. Each cell is a square card with the framework's wordmark/logo (monochrome on hover, muted by default), the language it's tied to in small mono text, and the adapter version. No filled backgrounds; cells are 1px `Rule`-bordered chips on `Pitch`.

The grid groups by Languages, Web frameworks, Data, and Infra. The exact roster matches the framework sub-table in §4 — do not let the grid drift from the matrix.

**Below the grid:**
Don't see your stack? The adapter API is in [`/docs/adapters`](/docs/adapters). PRs welcome — most adapters land in under 200 lines.

---

## 10. FAQ

### Section eyebrow

`FAQ`

### Section H2

**The questions we get most.**

### FAQ items (collapsible, first one open by default)

#### Q1 — Is it really no-LLM?

Yes. There are no embeddings, no model calls, no remote inference, no API keys. Every edge in the graph comes from a tree-sitter parse plus a deterministic adapter rule. Run `plinth index` twice on the same commit and the resulting `graph.json` will be byte-identical (CI runs a BLAKE3 check on every release). The reason isn't ideology — it's that an LLM that hallucinates 1% of edges produces a graph nobody can rely on for refactors.

#### Q2 — Does it work on monorepos?

Yes, and that's the case it was built for. Plinth reads `pnpm-workspace.yaml`, `nx.json`, `turbo.json`, and `lerna.json`, and indexes packages in parallel with a shared cache. We test on monorepos up to ~1.2M lines / ~120 packages; cold index is ~45s on a recent laptop, warm re-index for a typical PR is under 1s. If you point it at a monorepo configured with none of those tools, it falls back to walking from the repo root.

#### Q3 — Does it work without types?

Mostly. For typed languages (TypeScript with `tsconfig.json`, Python with type hints, Go, Rust) edges are precise and the `purity` field is reliable. For untyped JavaScript or Python the graph is still useful — call edges, import edges, framework-aware edges from adapters all work — but you'll see `purity: "unknown"` more often, and dynamic dispatch resolves to `kind: "calls?"` (the question mark is a real edge kind, not a typo). Adding types improves the graph monotonically; you never get a worse graph by typing more code.

#### Q4 — What languages?

Shipping today: TypeScript, JavaScript, Python, Go. Beta: Rust, Java, C#. Experimental: Ruby, PHP. Planned: Kotlin, Swift, Elixir. The capability matrix in §4 is the source of truth — if it disagrees with this answer, the matrix wins.

#### Q5 — How big a repo can it handle?

We test on the following sizes regularly: 10k LOC (under a second), 100k LOC (3–5 seconds cold, under 800ms warm), 1M LOC (40–60 seconds cold, under 2s warm). Memory use is roughly 1.2 KB per node; a 100k-LOC repo produces ~5k nodes and ~15k edges, which fits comfortably in a 1 GB CI runner. The viewer streams the graph and only renders the viewport, so even 1M-node graphs are navigable.

#### Q6 — Does it phone home?

No. `plinth index` makes zero network requests. `plinth serve` binds to `127.0.0.1` by default and never opens an outbound socket. The GitHub Action runs entirely on your runner; the only network call is the GitHub API call to post the PR comment, which is the standard `actions/github-script` flow you already use. There is no telemetry endpoint to opt out of, because there is no telemetry endpoint. To verify, the network code is in `packages/cli/src/net.ts` (it imports nothing from the network).

#### Q7 — What's the license?

MIT, top to bottom. The CLI, the IR schema, every bundled adapter, the React Flow viewer, the GitHub Action — all MIT. No Business Source License, no "fair-use" carve-out, no "free for individuals" tier. You can fork, vendor, embed in a closed-source product, sell a hosted version, whatever you need. The only thing we ask is that the LICENSE file travels with the code, which is what MIT already requires.

#### Q8 — How does it handle dynamic dispatch?

Honestly. When a call site can't be resolved statically — a method on an `any`-typed value, a `getattr` in Python, a function passed through a hash map, a `RPC.invoke(name)` where `name` comes from config — Plinth emits an edge with kind `calls?` and a `candidates` array of plausible targets ranked by adapter heuristics. The viewer renders these as dashed edges. You can filter them out with `--strict`, or query them specifically with `plinth query 'edges where kind = "calls?"'` to find the parts of your codebase where the graph is least confident. The goal is to be loud about what we don't know rather than fake precision. Adapters can register resolvers for cases that matter — the `next` adapter, for example, knows that `Route → Handler` is a real edge even though it's a string lookup at runtime.

#### Q9 — How do I query the graph?

Two ways. The `plinth query` CLI takes a small expression language (`paths from X to Y`, `nodes where adapter = "prisma"`, `edges where kind = "writes" and to.purity = "data"`) and prints results as a table or JSON. For anything more complex, `graph.json` is just JSON — pipe it through `jq`, load it into DuckDB with `read_json_auto`, or import it into your own tool. The viewer URL-encodes any query as a shareable link, which is what most people end up using during a refactor session.

#### Q10 — Does it integrate with my editor?

There's an LSP-shaped server in `packages/lsp` (experimental) that exposes "show graph for symbol at cursor" as a code action. Today it works in VS Code and Neovim. Any editor that can render an external URL on a code action also works — the action just opens the viewer at the right node. JetBrains support is planned but not on a fixed date.

#### Q11 — Why "Plinth"?

A plinth is the base a column or statue rests on — the substrate the structure above stands on. The graph IR is exactly that for your codebase: every PR comment, every refactor, every dependency question stands on the same compiled artifact. The name is a noun, not a verb — there is no `plinth your repo`. There is `plinth index`, `plinth diff`, `plinth serve` — the CLI uses the name the way `git` and `npm` do, as a tool, not as an action.

---

## 11. CTA footer

### Section eyebrow

`Get started`

### Section H2

**Index your repo in the next five minutes.**

### Sub-headline

The quickstart is one command. The Discord is small but the maintainers are there. The docs are written for the case where you read them in a hurry on a Monday.

### CTA buttons (3 across on desktop, stacked on mobile)

**Primary:**
- Label: `Star on GitHub`
- Trailing: `★ {GITHUB_STAR_COUNT}`
- Href: `https://github.com/plinth/plinth`
- Style: filled (`Volt` background, `Pitch` text)

**Secondary:**
- Label: `Read the docs`
- Trailing: `→`
- Href: `/docs`
- Style: outline

**Tertiary:**
- Label: `Join Discord`
- Trailing: `[discord_icon]`
- Href: `https://plinth.dev/discord` (server-side redirect to current invite)
- Style: outline

### Below CTAs (small print)

`MIT licensed  ·  v{LATEST_VERSION}  ·  released {LATEST_RELEASE_DATE}  ·  no account required`

---

## Footer

### Columns

**Product**
- Quickstart
- Adapters
- GitHub Action
- Compare
- Changelog

**Docs**
- IR schema
- CLI reference
- Writing an adapter
- Viewer keyboard shortcuts
- Self-hosting

**Community**
- GitHub
- Discord
- RFCs
- Contributing
- Security policy

**Legal**
- License (MIT)
- Trademark
- Privacy (we don't collect any)

### Bottom row

Left: `plinth  ·  v{LATEST_VERSION}`
Right: `Built in the open. MIT.`

---

## Implementation notes

### What changed from `brand/landing-copy.md`

The pre-decision draft was already strong. This file is the production version with five concrete tightenings:

1. **Name applied throughout.** `codegraph` → `Plinth` (capitalized in body, `plinth` in code). Tagline metaphors that referenced the old word are dropped. No Plumb-era language anywhere.
2. **Section count down from 10 to 11 with a different cut.** The old "Features" cards section (§4) is removed; its work is absorbed into the capability matrix (new §4) and the comparison prose (new §8). Six feature cards reading like a brochure was the section that dragged most. The matrix carries the same weight at half the visual cost.
3. **Capability matrix is now the load-bearing artifact.** Per `research/marketing-inspiration.md` Pattern 4 ("the matrix replaces a marketing claim with a verifiable map"). Status labels are honest: `shipping` / `beta` / `experimental` / `planned`, not checkmarks.
4. **One benchmark, named comparator** (Pattern 2 + 9). `38s cold / 740ms warm, 2.8x faster than scip-typescript on the React monorepo`. Pinned to a fixture; the script is in the repo. Replaces the older "indexes 1M LOC in 30s" floating claim.
5. **Three-pill positioning row** (Pattern 14). `MIT licensed · No LLM, no cloud · Runs in CI` directly under the subhead. Disqualifies the three biggest objections in one line.

### Section transitions

Every H2 starts with a sentence that picks up the last beat of the previous section.

- §1 (hero) ends on the proof line ("no LLM in the hot path").
- §2 picks up: "Code search shows you strings. You need to see structure."
- §2 ends on "regenerated from source on every commit."
- §3 picks up: "Source in. Graph out. Four stages."
- §3 ends on "two surfaces."
- §4 picks up the substrate: "Honest about what we extract. Honest about the gaps."
- §4 ends on the framework-adapter sub-table.
- §5 picks up: "One number, run on a fixture you can rerun."
- §5 ends on the reproducing snippet.
- §6 (install) is three commands and a hand-off line into §7.
- §7 (Action) opens with the "see the change in the graph" framing — the natural payoff after install.
- §7 ends on the screenshot description.
- §8 (compare) opens by naming the alternatives the reader was about to ask about.
- §9 (adapters) is the "does it work for my stack" answer.
- §10 (FAQ) sweeps long-tail objections.
- §11 (CTA footer) mirrors hero CTAs so the page closes on the same call to action it opened with.

### Sections trimmed (per the brief: "trim sections that drag")

- **Removed: features-card section** (six cards). Absorbed into matrix + comparison prose.
- **Removed: comparison-table section** (single-row 4-column). Replaced with prose comparison in §8 — mature OSS dev-tool marketing prefers implicit comparison.
- **Removed: diff-demo section as a standalone block.** Folded into §7 as the embedded PR-comment screenshot. The diff is the reason the Action exists; one section, not two.
- **Tightened: FAQ from 10 to 10** (Q1–Q10) but each answer cut by ~20%. The bonus questions in the old draft are now Q9 and Q10 proper.

### Top-row badges (per `research/marketing-inspiration.md` Pattern 7)

Top of README and (visually equivalent) top of the landing-page hero region:

`npm version` · `CI status` · `License (MIT)` · `Discord` · `GitHub Discussions`

Discord goes in the top row, before stars. Five badges, no Christmas tree.

### Visual identity references (carry-forward, unchanged)

- All color tokens from `brand/visual-identity.md` §8 design tokens. Pitch / Slab / Rule / Bone / Ash / Volt for dark; Vellum / Vellum-2 / Slate-Tide / Volt-Dark / Bearing for the docs light theme.
- Type: Geist Mono headings, Geist Sans body, JetBrains Mono code (ligatures off).
- Wordmark: `plinth` lowercase, Geist Mono 600, leading `p` in `Volt`.
- Logo: wireframe-cube primary mark with the Volt dot inside; hairlines forming a `P` in negative space (per `brand/decision.md` §5, swap of the §6 mark in `brand/visual-identity.md`).
- Motion: hero path lights up once on first paint (~300ms total). `prefers-reduced-motion` renders the lit-path final state immediately.
- Illegal-zone (per `brand/visual-identity.md` §7): no AI gradient, no glow on nodes, no neural-network imagery, no magnifying-glass, no glowing-nodes-on-dark observability look. Reaffirmed for this landing page: any contributor adding a purple-to-blue gradient or a particle background should be reverted on sight.

### Build-time placeholders

- `{GITHUB_STAR_COUNT}`: GitHub API at build time, cache 10 minutes, fallback `—`.
- `{LATEST_VERSION}` / `{LATEST_RELEASE_DATE}`: read from `packages/cli/package.json` and the matching git tag. Date format `YYYY-MM-DD`.
- All code blocks must have a copy button. Hero terminal card uses a fixed-height container (~360px). Three tabs along the top edge; default `install`. No fake typing.

### Section spacing

96px between sections on desktop, 64px on mobile. Max content width 1120px, 24px gutter on small screens. Headings: H1 56/60 desktop, 36/40 mobile; H2 32/36 desktop, 24/28 mobile; body 16/24 everywhere.

---

## Forbidden words checklist (CI lint)

`revolutionary`, `powerful`, `leverage`, `synergy`, `AI-powered`, `10x`, `next-generation`, `cutting-edge`, `seamless`, `frictionless`, `unlock`, `supercharge`, `game-changing`, `world-class`, `industry-leading`, `best-in-class`.

If any of the words above appears in this file outside this checklist line, fail the build.

---

## Approved phrasing reference

When in doubt, prefer the right-hand column.

| Don't say | Say instead |
|---|---|
| `powerful graph engine` | `typed graph IR` |
| `seamlessly integrates` | `runs as a GitHub Action` |
| `AI-powered code understanding` | `tree-sitter parse plus deterministic adapter rules` |
| `next-generation static analysis` | `static analysis, rendered` |
| `unlocks insights` | `surfaces edges` |
| `supercharges your reviews` | `posts a graph diff on every PR` |
| `best-in-class accuracy` | `same commit, same graph, byte-for-byte` |
| `enterprise-grade` | `MIT-licensed` |
| `lightning-fast` | `2.8x faster than scip-typescript on the React monorepo` |
| `industry-leading` | (delete the sentence) |

---

## A/B test candidates (run as separate experiments, not bundled)

- **Hero illustration vs. terminal card** in the right column. Hypothesis: terminal card converts better with HN/cold traffic; illustration converts better on direct visits. Measure: clicks on `$ install`, segmented by referrer.
- **H1: locked vs. alternative A** (`Your codebase, on a typed graph.` vs. `Index any codebase as a typed graph.`). Hypothesis: alternative A reads stronger to engineers who skim; locked H1 reads stronger to engineering managers and team-leads.
- **Three-pill row placement.** Above the CTAs (current) vs. below the proof line. Hypothesis: above-CTA disqualifies more bouncers; below-proof-line lets the verb-led subhead carry the first impression.

Default to the current variant if the experiment is inconclusive after 4 weeks.

---

*End of marketing/landing-final.md.*
