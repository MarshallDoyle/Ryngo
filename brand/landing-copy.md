# codegraph.dev — Landing Page Copy

Source of truth for all marketing copy on the homepage. Strings here map 1:1 to React components in `marketing/site/`. Placeholders in `{curly_braces}` are populated at build time.

Voice: technical, concrete, warm. No marketing hyperbole. No "AI-powered", "powerful", "revolutionary", "leverage", "synergy", "10x". Specific numbers over vague claims. Linear-precision, Vercel-docs-clarity.

---

## 0. Meta

- **Page title (browser tab):** codegraph — see your codebase as a graph
- **Meta description (155 chars):** codegraph compiles your codebase to a typed graph IR, renders it in your browser, and posts a diffed view on every PR. MIT, no LLM, local-first.
- **Open Graph image alt:** A directed graph of TypeScript modules, with effectful nodes outlined in red and pure nodes in blue.
- **Twitter card:** summary_large_image
- **Canonical URL:** https://codegraph.dev/

---

## 1. Hero

### H1 (primary)

**See your codebase as a graph.**

(7 words. Plain claim. Verb-first. No qualifier.)

### H1 alternatives

**Alternative A — `Your codebase, as a typed graph.`**
Rationale: Leads with possessive ("Your") which tested well in Linear/Vercel-style copy because it implies the artifact already exists, the tool just surfaces it. "Typed" is the differentiator vs. AI tools that produce untyped embeddings; pulling it into the H1 makes the technical claim load-bearing. Slightly longer (6 words) but reads as a definition rather than a command.

**Alternative B — `Static analysis, rendered.`**
Rationale: Maximally compressed (3 words). Names the category ("static analysis") so technical visitors orient instantly, and "rendered" implies the visual output without saying "viewer" or "graph" — invites curiosity. Risk: too understated for visitors who don't already know what static analysis produces. Best for a launch HN post, weaker for cold organic traffic.

### Subhead (under 25 words)

codegraph compiles your repo to a typed graph IR, renders it in the browser, and posts a diffed view on every pull request.

(23 words. Three concrete verbs: compiles, renders, posts. Names three artifacts: IR, browser view, PR comment.)

### Subhead alternatives

- A: `A static analyzer that emits a typed graph IR. View it locally, diff it on every PR, no LLM in the loop.` (22 words)
- B: `Index your repo into a typed graph. Open it in the viewer. Get a diff on every pull request. MIT-licensed, local-first.` (22 words)

### CTAs

**Primary CTA (filled button):**
- Label: `Get started`
- Href: `/docs/quickstart`
- Hover state: `Get started -> /docs/quickstart`

**Secondary CTA (outline button with GitHub mark):**
- Label: `View on GitHub`
- Trailing: `[star_icon] {GITHUB_STAR_COUNT}`
- Href: `https://github.com/codegraph/codegraph`
- Loading state: while fetching star count, render `View on GitHub  [star_icon] —` (em-dash, not zero, so we don't lie if the API is rate-limited).

### Hero code preview (right column, terminal-card aesthetic)

**Tab 1 — `install` (default open):**

```sh
$ pnpm add -D codegraph && pnpm codegraph index
indexing 1,247 files across 4 adapters... done in 3.1s
wrote .codegraph/ir.json (842 KB, 4,981 nodes, 12,304 edges)
```

**Tab 2 — `ir.json` (sample IR, abbreviated):**

```json
{
  "version": "0.1",
  "schemaHash": "sha256:4f2a91...c19b",
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

**Tab 3 — `query` (one-liner):**

```sh
$ codegraph query 'paths from "next:route:/api/users[POST]" to "prisma:User"'
1 path, 2 hops:
  next:route:/api/users[POST]
    -> ts:src/server/handlers/createUser.ts#createUser  (calls)
    -> prisma:User                                       (writes)
```

**Caption beneath the card (small, muted):**
The same IR feeds the viewer, the PR action, the query CLI, and any tool you build on top.

---

## 2. The problem

### Section eyebrow

`Why a graph`

### Section H2

**Code search shows you strings. You need to see structure.**

### Body — paragraph 1

Grep finds the word `createUser` in 47 places. Your IDE's call hierarchy walks one language at a time and gives up at the network boundary. Neither tells you that `createUser` writes to a Prisma model that's read by a Next.js route that's deployed by a Terraform module — the sequence of hops that actually matters when you're shipping a change. Every senior engineer ends up reconstructing this graph in their head, on a whiteboard, or in a Notion doc that goes stale the day it's written.

### Body — paragraph 2

The usual escapes don't escape. AI search gives you confident summaries with no edges to click on, and re-derives the same graph badly on every query. Hand-drawn architecture diagrams age out within a sprint. Static-analysis tools like ctags and language servers stop at the file or language boundary, so a TypeScript handler calling a Python worker over HTTP looks like two unrelated programs. codegraph is the missing artifact: a typed, queryable graph of your whole repo, regenerated from source on every commit.

### Pull-quote (rendered to the right of paragraph 2, muted)

> Most architecture decisions are graph decisions. Most architecture documentation is prose. That's the whole problem.

### Body — paragraph 3 (optional, render if column has space)

The graph isn't a separate artifact you have to maintain. It's compiled from the code on every push, the same way the type checker runs. When the graph and the code disagree, the code wins — so the graph is never out of date by definition.

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
- **Technical claim:** Walks your repo, parses every supported file with tree-sitter, and emits a per-file fact stream.
- **User benefit:** Runs on the unchanged half of your codebase from cache. Re-indexing a single PR takes 200–800ms.
- **Visual cue (described):** A folder tree on the left collapses into a stream of typed tokens flowing right. Files in cache have a checkmark; changed files pulse.

### Step 2 — Adapters

- **Label:** `02 Adapters`
- **Technical claim:** Framework-aware modules turn raw facts into semantic edges. Express adapters know what `app.post('/users', handler)` means; Prisma adapters know what `prisma.user.create` writes.
- **User benefit:** Your graph reflects your stack, not just your AST. An HTTP call is an `http_call` edge, not a string match.
- **Visual cue (described):** Six small chip rows — `ts`, `py`, `prisma`, `terraform`, `next`, `fastapi` — each transforming a raw token into a typed edge with an arrow.

### Step 3 — IR

- **Label:** `03 IR`
- **Technical claim:** Adapters merge into a single typed graph IR (JSON, schema-versioned). Every node has a stable ID; every edge has a kind, evidence, and source location.
- **User benefit:** One artifact you can `diff`, query with `jq`, ship to CI, or load into any tool you already use.
- **Visual cue (described):** A JSON document collapses into a node-and-edge schematic; one edge is highlighted with `kind: "writes"` and a file:line annotation.

### Step 4 — Viewer / Action

- **Label:** `04 Viewer / Action`
- **Technical claim:** The same IR powers the React Flow viewer (`codegraph serve`) and the GitHub Action that posts a diff comment on every PR.
- **User benefit:** Read it locally during a refactor. Read it in the PR during review. Same graph, two surfaces.
- **Visual cue (described):** Split panel — left half shows the local viewer with a selected node and inspector; right half shows a GitHub PR comment with `+12 nodes / -3 nodes / 4 edges changed`.

---

## 4. Features

### Section eyebrow

`Features`

### Section H2

**Built for repositories that outgrew a single language.**

### Section sub-headline

Every feature listed here is in the open-source release. There is no paid tier and no hosted dashboard.

### Card 1 — PR-diffed graphs

- **Title:** `PR-diffed graphs`
- **Description (2 lines):**
  Every pull request gets a comment with the nodes and edges your change adds, removes, or rewires. Click through to a side-by-side viewer rendered from the diff IR.
- **Visual cue (described):** A miniature PR comment showing `+8 nodes  -2 nodes  12 edges changed` with a `View graph diff` link styled like a GitHub callout.
- **Code/file reference:** `.github/workflows/codegraph.yml`

### Card 2 — Typed edges

- **Title:** `Typed edges`
- **Description (2 lines):**
  Edges aren't just lines. `calls`, `imports`, `reads`, `writes`, `http_call`, `enqueues`, `deploys` — each kind is filterable and carries the file:line evidence that produced it.
- **Visual cue (described):** Three stacked legend chips — `calls`, `writes (red)`, `http_call (dashed)` — with an example edge underneath.
- **Code/file reference:**
  ```ts
  type EdgeKind = 'calls' | 'imports' | 'reads' | 'writes'
                | 'http_call' | 'enqueues' | 'deploys' | 'extends'
  ```

### Card 3 — Framework-aware

- **Title:** `Framework-aware`
- **Description (2 lines):**
  Adapters ship for Express, Fastify, Next.js, FastAPI, Django, Prisma, Drizzle, Terraform, and more. Routes, models, queues, and infra show up as first-class nodes.
- **Visual cue (described):** Eight small framework wordmarks in a 4x2 grid — Express, FastAPI, Next.js, Django, Prisma, Drizzle, Terraform, Fastify — with a `+ adapters API` chip in the corner.
- **Code/file reference:** `adapters/*` (each adapter is ~300–800 LOC, MIT)

### Card 4 — Pure vs effectful coloring

- **Title:** `Pure vs. effectful coloring`
- **Description (2 lines):**
  Functions that touch I/O, the network, the database, or `Date.now()` are colored red. Pure functions are blue. The boundary between them is the most useful line in your codebase.
- **Visual cue (described):** Three-node sketch: blue `formatInvoice` -> blue `applyTax` -> red `chargeStripe`. The red node has a small `effectful` tag.
- **Code/file reference:**
  ```ts
  node.purity // "pure" | "effectful" | "data" | "unknown"
  ```

### Card 5 — Local-first, no hosted backend

- **Title:** `Local-first, no hosted backend`
- **Description (2 lines):**
  Indexing, viewer, and PR action all run in your environment. Nothing about your code leaves your machine or your CI runner unless you ship it there yourself.
- **Visual cue (described):** A small diagram: laptop -> `.codegraph/ir.json` -> GitHub Action runner. No cloud icon. A muted note: `0 outbound requests`.
- **Code/file reference:** `codegraph serve --port 4200` (binds 127.0.0.1 by default)

### Card 6 — 100% deterministic, no LLM

- **Title:** `Deterministic, no LLM`
- **Description (2 lines):**
  The same commit produces the same graph, byte-for-byte. No embeddings, no probabilistic ranking, no model versions to pin. Every edge has a file:line citation you can open.
- **Visual cue (described):** A `sha256` of `ir.json` rendered in mono, followed by `== sha256(ir.json) on rerun`.
- **Code/file reference:**
  ```sh
  $ codegraph index --check
  ir.json unchanged (sha256: 4f2a...c19b)
  ```

---

## 5. Comparison teaser

### Section eyebrow

`How it compares`

### Section H2

**The other tools weren't built for this.**

### Sub-headline

A short version. The full comparison page covers Sourcegraph, Codeium, Cursor's index, and the usual graph-DB approaches.

### Comparison table (single row, 4 columns)

| | **codegraph** | AI code search | Traditional graphs (graph DB + custom ETL) |
|---|---|---|---|
| **Output** | Typed JSON IR + viewer + PR comment | Natural-language summary | Cypher / Gremlin queries |
| **Determinism** | Same commit -> same graph (sha256-stable) | Re-derived per query, varies by model version | Deterministic, but ETL pipeline is bespoke |
| **Cross-language / cross-service** | Yes, via framework adapters | Sometimes, by similarity | Only what you wrote ETL for |
| **Setup time** | `pnpm add -D codegraph` + 1 workflow file | API key + indexing job | Days to weeks |

**Footnote under table (small, muted):**
None of this is a knock on AI search — it's good at different problems. codegraph is for the questions where you need to be sure.

**CTA below table:**
`See the full comparison ->` (links to `/compare`)

---

## 6. Install snippet

### Section eyebrow

`Install`

### Section H2

**Three commands.**

### Sub-headline

Works in any pnpm, npm, or yarn workspace. Node 20+. No global install, no daemon, no account.

### Code block (3 lines, each with a copy button)

```sh
pnpm add -D codegraph
```
- **Copy button label (a11y):** `Copy install command`

```sh
codegraph index
```
- **Copy button label (a11y):** `Copy index command`
- **Caption:** Walks the repo, runs adapters, writes `.codegraph/ir.json`.

```sh
codegraph serve
```
- **Copy button label (a11y):** `Copy serve command`
- **Caption:** Opens the viewer at `http://127.0.0.1:4200`.

### Below the snippet

**Inline note:** Add to CI in 8 lines: `.github/workflows/codegraph.yml`. [`Show example ->`](/docs/github-action)

---

## 7. Adapter list section

### Section eyebrow

`Adapters`

### Section H2

**Works with what you're already using.**

### Sub-headline

Adapters turn framework-specific patterns into typed graph nodes and edges. Each one is a small module under `adapters/`. Write your own in an afternoon — the API is one function: `adapt(facts: Fact[]): GraphFragment`.

### Logo grid (described, not generated)

A 6-column responsive grid. Each cell is a square card with the framework's wordmark/logo (monochrome on hover, muted by default), the language it's tied to in small text, and the adapter version.

**Row 1 — Languages (5 cells + see all):**
- `TypeScript` (bundled)
- `JavaScript` (bundled)
- `Python` (bundled)
- `Go` (bundled)
- `Rust` (bundled)
- `+ 4 more` (Java, C#, Ruby, PHP — all in `adapters/lang/`)

**Row 2 — Web frameworks (6 cells):**
- `Next.js` — TypeScript
- `Express` — JavaScript / TypeScript
- `Fastify` — TypeScript
- `FastAPI` — Python
- `Django` — Python
- `Rails` — Ruby

**Row 3 — Data (6 cells):**
- `Prisma` — TypeScript
- `Drizzle` — TypeScript
- `SQLAlchemy` — Python
- `TypeORM` — TypeScript
- `Sequelize` — JavaScript
- `Knex` — JavaScript / TypeScript

**Row 4 — Infra & glue (6 cells):**
- `Terraform` — HCL
- `Pulumi` — TypeScript / Python / Go
- `GraphQL (Apollo / urql)` — multi
- `tRPC` — TypeScript
- `OpenAPI` — multi
- `Zod` — TypeScript

**Below grid:**
**Caption:** Don't see your stack? The adapter API is in [`/docs/adapters`](/docs/adapters). PRs welcome — most adapters land in under 200 lines.

---

## 8. Diff demo

### Section eyebrow

`On every PR`

### Section H2

**Reviewers see the change in the graph, not just the diff.**

### Sub-headline

The Action runs on `pull_request`, indexes the head and base commits, and posts a single comment with what changed in the IR. The viewer link opens a side-by-side render of the same diff.

### Embedded screenshot (described — do NOT generate)

**Image content:** A GitHub pull request page in light mode. The PR title is `feat(billing): switch invoice generator to streaming`. Pinned at the top of the conversation timeline is a comment authored by `codegraph-bot`. The comment header reads `codegraph  ·  graph diff for #482`.

**Comment body (rendered as it would appear in GitHub):**

> **+12 nodes  ·  -3 nodes  ·  18 edges changed**
>
> - **Added:** `streamInvoice` (effectful), `chunkPDF` (pure), `flushBuffer` (effectful), `+9 more`
> - **Removed:** `buildInvoiceBlob`, `gzipInvoice`, `uploadBlob`
> - **Edge changes:** `InvoiceJob -> S3Bucket` (writes) replaced by `InvoiceJob -> CloudfrontEdge` (writes, streaming)
>
> [`Open graph diff ->`](https://codegraph.dev/diff/482)

**Annotation overlay (described):** A bright orange arrow points from the right margin to the comment, with a hand-lettered label `this comment posts on every PR`. Below the arrow, smaller secondary text: `~3s on a 100k-line monorepo, runs on the standard ubuntu-latest runner`.

### CTA below screenshot

`Set up the action ->` (links to `/docs/github-action`)

---

## 9. FAQ

### Section eyebrow

`FAQ`

### Section H2

**The questions we get most.**

### FAQ items (collapsible, first one open by default)

#### Q1 — Is it really no-LLM?

Yes. There are no embeddings, no model calls, no remote inference, and no API keys to configure. Every edge in the IR comes from a tree-sitter parse plus a deterministic adapter rule. Run `codegraph index` twice on the same commit and the resulting `ir.json` will be byte-identical (we run a sha256 check on every release in CI). The reason isn't ideology — it's that an LLM that hallucinates 1% of edges produces a graph nobody can rely on for refactors.

#### Q2 — Does it work on monorepos?

Yes, and that's the case it was built for. codegraph reads `pnpm-workspace.yaml`, `nx.json`, `turbo.json`, and `lerna.json`, and indexes packages in parallel with a shared cache. We test on monorepos up to ~1.2M lines / ~120 packages; cold index is ~45s on a recent laptop, warm re-index for a typical PR is under 1s. If you point it at a monorepo that wasn't configured with one of those tools, it falls back to walking from the repo root.

#### Q3 — Does it work without types?

Mostly. For typed languages (TypeScript with `tsconfig.json`, Python with type hints, Go, Rust) edges are precise and the `purity` field is reliable. For untyped JavaScript or Python the graph is still useful — call edges, import edges, framework-aware edges from adapters all work — but you'll see `purity: "unknown"` more often, and dynamic dispatch resolves to `kind: "calls?"` (note the question mark, which is a real edge kind, not a typo). Adding types improves the graph monotonically; you never get a worse graph by typing more code.

#### Q4 — What languages?

Bundled today: TypeScript, JavaScript, Python, Go, Rust, Java, C#, Ruby, PHP. Each language ships with its own tree-sitter grammar and a per-language adapter that handles imports, calls, and class hierarchies. Framework adapters compose on top — so a Python file is parsed once and consumed by both the `python` language adapter and the `fastapi` framework adapter when it applies. The language adapter API is documented; we expect community-maintained adapters for Kotlin, Swift, and Elixir before 1.0.

#### Q5 — How big a repo can it handle?

We test on the following sizes regularly: 10k LOC (under a second), 100k LOC (3–5 seconds cold, under 800ms warm), 1M LOC (40–60 seconds cold, under 2s warm). Memory use is roughly 1.2 KB per node in the IR; a 100k-LOC repo produces ~5k nodes and ~15k edges, which fits comfortably in a 1 GB CI runner. The viewer streams the graph and only renders what's in the viewport, so 1M-node graphs are still navigable, just a bit chunkier on the first paint.

#### Q6 — Does it phone home?

No. `codegraph index` makes zero network requests. `codegraph serve` binds to `127.0.0.1` by default and never opens an outbound socket. The GitHub Action runs entirely on your runner; the only network call is the GitHub API call to post the PR comment, which is the standard `actions/github-script` flow you already use. There is no telemetry endpoint to opt out of, because there is no telemetry endpoint. If you want to verify, the network code is in `packages/cli/src/net.ts` (it imports nothing).

#### Q7 — What's the license?

MIT, top to bottom. The CLI, the IR schema, every bundled adapter, the React Flow viewer, the GitHub Action — all MIT. We don't have a Business Source License, a "fair-use" carve-out, or a "free for individuals" tier. You can fork it, vendor it, embed it in a closed-source product, sell a hosted version, whatever you need. The only thing we ask is that the LICENSE file travels with the code, which is what MIT already requires.

#### Q8 — How does it handle dynamic dispatch?

Honestly. When a call site can't be resolved statically — a method on an `any`-typed value, a `getattr` in Python, a function passed through a hash map, a `RPC.invoke(name)` where `name` comes from config — codegraph emits an edge with kind `calls?` and a `candidates` array of plausible targets ranked by adapter heuristics. The viewer renders these as dashed edges. You can filter them out with `--strict`, or query them specifically with `codegraph query 'edges where kind = "calls?"'` to find the parts of your codebase where the graph is least confident. The goal is to be loud about what we don't know rather than to fake precision. For the cases that matter — a router dispatching by string, a plugin loader, a feature flag — adapters can register resolvers; the `next` adapter, for example, knows that `Route -> Handler` is a real edge even though it's a string lookup at runtime.

#### Q9 — Bonus: how do I query the graph?

Two ways. The `codegraph query` CLI takes a small expression language (`paths from X to Y`, `nodes where adapter = "prisma"`, `edges where kind = "writes" and to.purity = "data"`) and prints results as a table or JSON. For anything more complex, `ir.json` is just JSON — pipe it through `jq`, load it into DuckDB with `read_json_auto`, or import it into your own tool. The viewer's URL-encodes any query as a shareable link (`?q=paths+from...`), which is what most people end up using during a refactor session.

#### Q10 — Bonus: does it integrate with my editor?

There's an LSP-shaped server in `packages/lsp` (experimental) that exposes "show graph for symbol at cursor" as a code action. Today it works in VS Code and Neovim. Any editor that can render an external URL on a code action also works — the action just opens the viewer at the right node. JetBrains support is planned but not on a fixed date.

---

## 10. CTA footer

### Section eyebrow

`Get started`

### Section H2

**Index your repo in the next five minutes.**

### Sub-headline

The quickstart is one command. The Discord is small but the maintainers are there. The docs are written for the case where you read them in a hurry on a Monday.

### CTA buttons (3 across on desktop, stacked on mobile)

**Primary:**
- Label: `Star on GitHub`
- Trailing: `[star_icon] {GITHUB_STAR_COUNT}`
- Href: `https://github.com/codegraph/codegraph`
- Style: filled

**Secondary:**
- Label: `Read the docs`
- Trailing: `->`
- Href: `/docs`
- Style: outline

**Tertiary:**
- Label: `Join Discord`
- Trailing: `[discord_icon]`
- Href: `https://codegraph.dev/discord` (redirects to current invite, never expires)
- Style: outline

### Below CTAs (small print)

`MIT licensed  ·  v{LATEST_VERSION}  ·  released {LATEST_RELEASE_DATE}  ·  no account required`

---

## Footer (small, below CTA section)

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

Left: `codegraph  ·  v{LATEST_VERSION}`
Right: `Built in the open. MIT.`

---

## Copy notes (for the implementing engineer)

- `{GITHUB_STAR_COUNT}`: pull from GitHub API at build time, cache for 10 minutes, fall back to `—` (em-dash) on rate limit. Never render `0`.
- `{LATEST_VERSION}` and `{LATEST_RELEASE_DATE}`: read from `packages/cli/package.json` and the matching git tag at build time. Date format: `YYYY-MM-DD` (ISO).
- All code blocks must have a copy button. The IR JSON sample in the hero is intentionally trimmed (3 nodes, 2 edges) so it fits without scrolling on a 13" laptop. If the card is taller than 480px on the deployed page, drop the third node first.
- The PR-comment screenshot in section 8 is described, not generated. Whoever designs it should screenshot a real codegraph-bot comment from the dogfooding repo, then add the orange callout in Figma. Use the actual codegraph-bot avatar (the one in `brand/avatars/codegraph-bot.png`), not a placeholder.
- The comparison table in section 5 is intentionally narrow (4 columns, 4 rows). The full version lives at `/compare` and includes Sourcegraph, OpenGrok, semgrep, Cursor's index, and graph-DB-based approaches.
- "Pure vs. effectful" should keep the period after "vs" in headings but drop it inline (`pure vs effectful coloring`) for readability. Match Linear's house style.
- Avoid the words listed in the brief everywhere on the page, including alt text and aria-labels.
- One short quoted line per page is fine; no long quotes.
- The Discord link redirects through `codegraph.dev/discord` so we can rotate the invite without a code deploy.
- Hero terminal card: render with a fixed-height container (~360px) and three tabs along the top edge (`install`, `ir.json`, `query`). Default tab is `install`. Switching tabs is animation-free; the content swap is instant. No "fake typing" animation — the brief says no marketing hyperbole and that includes typewriter effects on inert text.
- Section spacing: 96px between sections on desktop, 64px on mobile. Each section has a maximum content width of 1120px and a 24px gutter on small screens.
- Heading typography: H1 in the brand display face at 56/60px on desktop, 36/40px on mobile. H2 at 32/36px desktop, 24/28px mobile. Body text at 16/24px everywhere.
- Code blocks use the brand mono face. Inline code uses the same family at 0.92em with a subtle border (1px, neutral-300, 4px radius). Don't use a filled background for inline code; it makes the page look noisier than it needs to.
- The "tiny code/visual cue" on each feature card in section 4 is a single line that fits in a 320px-wide card without wrapping. If it would wrap, shorten it before shrinking the font.
- Color usage: `pure` is `--color-pure` (a calm desaturated blue, around #4A6FA5). `effectful` is `--color-effectful` (a warm red-orange, around #C0463A, not pure red). Both have AA contrast on the page background. The legend in feature card 4 uses these exact tokens; do not hardcode hex values in components.
- Internal links use the standard brand link style (no underline, color shift on hover, 200ms transition). External links (GitHub, Discord) get a small trailing arrow `↗` for affordance.

---

## Forbidden words checklist (run as a CI lint over this file)

`revolutionary`, `powerful`, `leverage`, `synergy`, `AI-powered`, `10x`, `next-generation`, `cutting-edge`, `seamless`, `frictionless`, `unlock`, `supercharge`, `game-changing`, `world-class`, `industry-leading`, `best-in-class`.

If any of these appear in this file outside of this checklist line, fail the build.

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
| `lightning-fast` | `under 1s warm re-index on a 100k-LOC repo` |
| `industry-leading` | (delete the sentence) |

---

## Section ordering rationale

The order is deliberate and shouldn't be reshuffled without checking with brand:

1. **Hero** establishes what the product is in under 6 seconds.
2. **Problem** justifies why the product needs to exist before naming any features.
3. **How it works** answers the technical reader's first question (`is this magic or real?`) before any feature claims.
4. **Features** can land because the reader now trusts the substrate.
5. **Comparison** is placed after features, not before, so the comparison is read as analysis rather than positioning.
6. **Install** sits in the middle so visitors who are already sold can copy and leave.
7. **Adapters** answers `does it work for my stack?` — most visitors check this before reading further.
8. **Diff demo** is the killer feature; it lands stronger after the install snippet because the reader has already imagined themselves running it.
9. **FAQ** picks up the long-tail objections so the CTA isn't blocked by an unanswered question.
10. **CTA footer** mirrors the hero CTAs so the page closes on the same call to action it opened with.

---

## A/B test candidates

Three places where the copy is most likely to move conversion. Run as separate experiments, not bundled.

- **H1:** the primary `See your codebase as a graph.` against alternative A (`Your codebase, as a typed graph.`). Hypothesis: alternative A converts better with engineers, primary converts better with engineering managers. Measure: clicks on `Get started` from organic traffic, segmented by referrer.
- **Subhead verb count:** the three-verb version (`compiles, renders, posts`) against a one-verb version (`compiles your repo to a typed graph IR.`). Hypothesis: three verbs read as fuller value but may overload the hero.
- **Diff demo placement:** section 8 vs. section 3 (immediately after `How it works`). Hypothesis: moving it earlier raises CTA clicks but lowers scroll depth on the FAQ, which is fine for top-of-funnel and bad for support-cost reduction.

Default to the primary variant if the experiment is inconclusive after 4 weeks.
