# codegraph — Launch Content

Coordinated narrative across HN, X, Reddit, and Product Hunt. Common threads:
- PR-diffed graphs (the differentiator competitors haven't shipped)
- Typed edges, pure-vs-effectful coloring (concrete features)
- No LLM, no hosted backend, MIT (the trust-and-cost story)
- Static analysis compiled to graph IR, rendered in React Flow

---

## 1. Hacker News (Show HN)

### Primary title

`Show HN: codegraph – Static analysis to typed graph IR, diffed per PR`

(72 chars including the `Show HN:` prefix.)

### Primary first comment (320 words)

Hi HN. I've been writing services across three languages for the last few years and kept hitting the same wall during code review: I could read the diff, but I couldn't see what the diff *did* to the architecture. A new edge between two modules that shouldn't talk to each other looks identical to a typo fix in a unified diff. I wanted a tool that reviewed the graph, not the text.

codegraph is what I built. It parses a repo with tree-sitter, runs a small set of language-specific resolvers, and emits a typed graph IR. Nodes are functions, types, modules. Edges are typed: `calls`, `reads`, `writes`, `imports`, `implements`, `throws`. Pure functions render in one color, effectful ones in another (filesystem, network, mutable state, time). The viewer is React Flow with semantic zoom — module-level at the top, function-level at the bottom.

The thing I haven't seen elsewhere is the GitHub Action. It builds the graph for the base branch and the head branch, diffs them at the IR level, and posts a graph delta on the PR. Added edges, removed edges, type changes, new effectful paths through previously pure code. You review the architectural diff, not just the text diff.

What it doesn't do: it doesn't run your code, it doesn't call an LLM, it doesn't phone home, and it doesn't try to be a full IDE. There's no hosted backend. The Action runs on your runners. The viewer is a static site you can host anywhere or open from disk.

Stack: TypeScript, tree-sitter, React Flow, a small Rust core for the graph diff. MIT.

Repo: github.com/[org]/codegraph
Docs: [docs link]
Demo on a real repo: [demo link]

I'd love feedback on the IR schema (in `/spec`), the resolver design for cross-language repos, and the diff algorithm — those are the parts I'm least sure about. Bug reports especially welcome on the Python and Go adapters, which are newer than the TS one.

### Anticipated critiques and responses

- **"This is just a call graph viewer / Sourcegraph / Sourcetrail / etc."**
  Acknowledge the lineage, point at the PR-diffed graph and typed-edge features as the actual delta. Don't claim to invent code visualization. Link to a side-by-side on a real PR if asked.

- **"Why not use an LLM for code understanding?"**
  Determinism, free, fast, no rate limits, no data leaving the runner. Same input always produces same graph. CI-friendly. Not anti-LLM, just a different tool.

- **"How does this scale to a 2M LOC monorepo?"**
  Honest answer with numbers from the largest repo I've tested. Mention the incremental graph build (only re-parse changed files). If I haven't tested it at that scale, say so and ask if anyone wants to throw a repo at it.

- **"Tree-sitter can't resolve types accurately enough for this."**
  Correct for some languages. For TS we lean on the TS compiler API for type info; for Python and Go we use lighter resolvers and document the precision tradeoffs in `/docs/precision.md`. Don't oversell.

- **"What about [language X]?"**
  List the supported languages, the adapter API, and a link to the contributor guide. Be specific about what "supported" means (parsing vs. type-aware vs. effect-aware).

- **"Where's the moat / business model?"**
  It's MIT and there isn't one. Built it because I wanted it. If it grows I might do a hosted version for teams who don't want to wire up the Action, but the OSS tool is the product.

### Alternative title/comment combos

**Variant A — tool angle**
- Title: `Show HN: codegraph – A code graph viewer that diffs at the IR level`
- Rationale: Leads with the artifact, less abstract. Good if I expect HN to be skeptical of "PR-diffed" as jargon.
- Opening line: "codegraph parses your repo into a typed graph and tells you what your PR changed about the architecture, not just the lines."

**Variant B — contrarian angle**
- Title: `Show HN: codegraph – Deterministic code search without an LLM`
- Rationale: Plants a flag against the AI code search wave. Risk: invites "why no LLM" debate that distracts from the actual feature set. Use only if HN's mood that week is anti-hype.
- Opening line: "Every code intelligence tool launched this year has been an LLM wrapper. I wanted the opposite: a static analyzer that gives the same answer every time, runs on your laptop, and costs nothing."

**Variant C — feature-led**
- Title: `Show HN: codegraph – Typed edges, pure/effectful coloring, PR-diffed`
- Rationale: Loads the title with concrete features for skimmers. Less narrative, more spec. Good if the demo screenshot is doing the heavy lifting.
- Opening line: "Three features that I couldn't find together in one tool: edges typed by relation (calls/reads/writes/throws), nodes colored by purity, and a per-PR graph diff posted as a CI artifact."

---

## 2. Twitter/X thread (12 tweets)

**1/ (hook + visual)**
shipped codegraph — open-source static analysis that compiles your repo to a typed graph and diffs it per PR. no LLM, no backend, MIT.

[video: 20s capture of a PR comment opening into the React Flow graph diff, red edges removed, green edges added]

**2/ what it does (1)**
parses your repo with tree-sitter, builds a graph IR. nodes = functions, types, modules. edges are *typed*: calls, reads, writes, imports, implements, throws. you see relationships, not just blobs.

[screenshot: graph view with edge labels visible on hover, sidebar showing edge type counts]

**3/ what it does (2)**
pure functions render blue. effectful ones (fs, net, mutable state, time) render orange. the color of your codebase is the shape of your side effects.

[screenshot: same module rendered with purity coloring, mostly orange auth module vs. mostly blue pure-utils module]

**4/ semantic zoom**
zoom out → modules and the edges between them. zoom in → individual functions inside each module. one canvas, three levels of detail. no separate "architecture" and "code" views.

[screenshot: two-panel before/after of zoom levels]

**5/ the differentiator: PR diffs**
the GitHub Action runs the graph build on base + head and posts the *graph delta* as a PR comment. new edges, removed edges, type changes, new effectful paths through code that used to be pure.

[screenshot: PR comment with the delta panel inline]

**6/ search by relation**
"every function that writes to the db and is reachable from an HTTP handler." structural query, not regex. finds the actual paths.

[screenshot: query panel + highlighted subgraph]

**7/ no install for viewing**
the viewer is a static React app. drop the artifact in S3 / Pages / anywhere. no server, no auth backend, no telemetry. opens from disk too.

[screenshot: viewer running from `file://`]

**8/ language coverage**
TypeScript and JavaScript are type-aware (TS compiler API). Python and Go are parse + light resolution. Rust adapter in progress. adapter API is documented for adding more.

[screenshot: docs page listing language tiers]

**9/ the unfair advantage**
no LLM means: same input, same graph, every time. no API key. no rate limit. no token bill. runs in 12 seconds on a 200k LOC repo on my laptop. cacheable, diffable, deterministic.

**10/ install**
```
pnpm add -D @codegraph/cli @codegraph/action
npx codegraph build .
npx codegraph view
```
two commands. the Action is one workflow file.

**11/ the ask**
repo: github.com/[org]/codegraph
docs: [docs]
if any of this is interesting, a star helps it reach the next person. issues + PRs very welcome, especially on the Python and Go adapters.

**12/ thanks**
standing on the shoulders of tree-sitter, React Flow, and the Sourcetrail / Sourcegraph / call-graph tradition. h/t @ts_sitter @reactflowdev and the language adapter authors who did the hard work first.

---

## 3. Reddit r/programming (560 words)

### Title
`I built codegraph: static analysis compiled to a typed graph, diffed per PR (MIT, no LLM)`

### Body

For the last few months I've been working on a tool I wished existed during code review, and I shipped the first public version this week. Posting here because the design decisions are the interesting part and I'd genuinely like to argue about some of them.

The problem I started with: a unified diff is a terrible representation of what a PR changes about a system. A new import line and a typo fix look identical to the diff viewer, but one of them just coupled two subsystems that were independent yesterday. I wanted to review the architectural change, not the text change.

codegraph is the tool I ended up with. It parses a repository with tree-sitter, runs language-specific resolvers, and produces a typed graph IR. Nodes are the things you'd expect — functions, types, modules. Edges are where it gets opinionated: every edge has a type (`calls`, `reads`, `writes`, `imports`, `implements`, `throws`), and every node is annotated with a purity classification based on a small effect system (filesystem, network, mutable state, time, randomness). The viewer is built on React Flow with semantic zoom: module-level at one zoom, function-level at another, same canvas.

The piece I'm most interested in feedback on is the PR-diff GitHub Action. It builds the graph for base and head, diffs at the IR level, and posts a graph delta as a PR comment. You see added edges, removed edges, edge type changes, and — the one I find most useful — new effectful paths through code that used to be pure. The diff is structural, not textual.

A few design decisions that I want to be explicit about, because they're tradeoffs and not obvious wins:

**No LLM, anywhere.** Not in the parser, not in the search, not in the diff. Every output is a deterministic function of the input. This means the graph is cacheable, the CI artifact is reproducible across runs, and there's no API key or token budget to manage. It also means I can't do the fuzzy "what does this code mean" things an LLM-based tool can. That's an explicit choice; I think there's room for both kinds of tools and I wanted the deterministic one for myself.

**Tree-sitter as the parsing front end.** Fast, incremental, multi-language, and good enough for structural analysis. For TypeScript I lean on the TS compiler API for actual type resolution; for Python and Go I use lighter resolvers. The precision tradeoffs are documented per language so you know what you're getting.

**No hosted backend, no telemetry, MIT.** The viewer is static. The Action runs on your runners. There is no server I operate. If GitHub disappeared tomorrow you could run this locally against a folder.

**Rust core for the diff.** The TS code does parsing and orchestration; the IR diff itself is in a small Rust crate compiled to WASM. Hot path, worth the build complexity.

What I'd love this thread to argue about:

- Is the typed-edge schema the right cut? `/spec/edges.md` has the full list. Anything missing, anything that should be merged?
- For multi-language repos, should the resolver be one shared pass with adapters plugged in, or one independent pass per language with a merge step? I went with the second; happy to be told it was wrong.
- Is "PR-diffed graph" a feature people would actually use, or do you read the unified diff and trust your model of the codebase?

Repo, docs, and a demo running on a real OSS project are linked in the comments to keep this post under the self-promo threshold.

---

## 4. Product Hunt

### Tagline (60 char)
`See what your PR did to your architecture, not just the code.`
(60 chars exactly.)

### Short description (260 char)
`codegraph compiles your repo to a typed graph IR — nodes for functions and modules, typed edges for every relation, purity coloring for side effects. The GitHub Action diffs the graph per PR so you review the architectural change, not the textual one. MIT.`
(259 chars.)

### Full description (~400 words)

codegraph is an open-source static analysis tool that turns your codebase into a typed graph and shows you what a pull request changed about its structure.

Most code review tools show you which lines moved. That's necessary but it's not sufficient. A new import line and a refactored variable name look identical in a unified diff, but one of them is an architectural change and the other isn't. codegraph builds the graph and diffs at that level instead.

**What's in the graph**

Nodes are the things you'd expect — functions, types, modules. Edges are the part that's opinionated. Every edge carries a type: `calls`, `reads`, `writes`, `imports`, `implements`, `throws`. Every node is tagged with an effect classification — pure functions render one color, effectful ones (filesystem, network, mutable state, time, randomness) render another. The viewer is built on React Flow with semantic zoom, so the same canvas shows module-level architecture at one zoom and function-level detail at another.

**What ships in the box**

- A CLI that builds the graph for any repo locally
- A static viewer (React Flow) you can host anywhere or open from disk
- A GitHub Action that builds the graph for base + head on every PR and posts the diff as a comment
- Adapters for TypeScript, JavaScript, Python, and Go (Rust in progress)
- A documented adapter API for adding more languages

**What it doesn't do**

It doesn't run your code. It doesn't call an LLM. It doesn't talk to a backend — there is no backend. There's no telemetry, no auth, no token budget. The artifact you publish from CI is a static folder you can serve from anywhere or commit to a branch.

**Why no LLM**

Determinism. The graph is a pure function of the source, so the diff is reproducible across runs and reviewers. Free, fast, offline. Same input, same answer, every time. That's a tradeoff against the fuzzy "what does this code mean" capabilities an LLM-based tool would have, and it's a deliberate one.

**Stack**

TypeScript and tree-sitter for parsing and orchestration, a small Rust crate compiled to WASM for the IR diff, React Flow for the viewer. MIT licensed, no CLA, contributions welcome.

Repo and docs in the links. Particularly looking for feedback on the typed-edge schema and the cross-language resolver design.

### Gallery shots (4 descriptions)

1. **Hero shot — module-level architecture view.** Wide canvas showing 12–18 module nodes connected by typed edges, color split between pure (cool) and effectful (warm) modules. A small inset shows the same graph zoomed in to a function-level view of one module, communicating semantic zoom in a single image. Caption: "One canvas. Modules at the top. Functions inside them."

2. **PR diff comment.** A real GitHub PR page with the codegraph bot comment expanded inline. Added edges in green, removed edges in red, two edges with type-change annotations, and a callout for "1 new effectful path through previously pure code." Caption: "The Action posts the graph delta on every PR."

3. **Edge typing detail.** Close-up on a small subgraph (8 nodes, 12 edges) with edge labels visible — `calls`, `writes`, `throws`, `implements`. Sidebar panel shows the edge type histogram for the current view. Caption: "Edges aren't just lines. Every edge has a type."

4. **Structural search.** Query bar at the top reading something like `writes(:db) reachable_from handler.*`, and the matching subgraph highlighted in the canvas while the rest fades back. Caption: "Find every path from an HTTP handler to a database write. Structural, not regex."

