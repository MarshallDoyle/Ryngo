# codegraph — Competitive Landscape Analysis

A field survey of adjacent and overlapping tools, with a focus on what they do
under the hood, how they're doing today, what they get right, what they miss,
and where codegraph fits.

Scope: This file is honest. Where competitors are simply better than codegraph
at a given dimension, that is stated. Where competitors are dead, archived, or
pivoted away, the dates and sources are cited. Quotations from external sources
are short (under 15 words) and surrounded by quotation marks per fair-use
practice.

Sources are linked inline and consolidated at the end of each section. Last
verified: May 2026.

---

## 1. Sourcetrail

### What it is

A cross-platform interactive source explorer built originally as a commercial
product by Coati Software (founded 2014–2016 by Eberhard Gräther and Manuel
Reinhardt, Bremen, Germany). It generated a graph of declarations, references,
and inheritance relationships from a codebase and rendered them in a custom Qt
GUI alongside the underlying source code. Users could click any symbol and see
its callers, callees, types, and surrounding architecture. C++ was the flagship
language. C, Java, and Python were also supported.

The origin story is significant: Gräther was an intern at Google on Chrome and
spent roughly a month on a feature he expected to take 1–2 hours. That
frustration with code comprehension as a first-class problem motivated the
tool.

### How it works under the hood

- **C/C++:** libclang to walk translation units and produce an AST, with
  cross-references resolved through Clang's semantic analysis. A
  `compile_commands.json` (compilation database) was the input contract.
- **Java:** Eclipse JDT under the hood for parsing and binding resolution.
- **Python:** Jedi for static analysis.
- **Storage:** SQLite database of nodes (symbols), edges (references), source
  locations, and source files. The graph was the persisted source of truth, and
  the GUI queried it on demand.
- **UI:** Custom Qt application that paired the graph view (top half) with the
  source code view (bottom half) and tied them with bidirectional navigation —
  click a node, jump to source; click a symbol in source, focus the node.

### Current status

Defunct. Coati Software announced discontinuation in September 2021. The final
official release (`2021.4.19`) was published on November 30, 2021. The GitHub
repository (`CoatiSoftware/Sourcetrail`) was archived by the owner on December
14, 2021. There is no successor project under the same banner. A handful of
forks exist, none with meaningful momentum.

### Why it died

The team's own statements and the available reporting cite a combination of
factors:

- The cross-platform Qt + libclang + JDT stack was complex to maintain. Keeping
  current with libclang APIs across versions, juggling Java toolchain
  evolution, and keeping Python's analysis story coherent was a significant
  ongoing cost.
- Both founders took full-time jobs after open-sourcing in November 2019. A
  relocation hindered collaboration.
- Open-sourcing did not produce a self-sustaining contributor community at the
  scale needed to maintain the toolchain.
- No durable revenue model. Sourcetrail had a paid commercial license before
  open-sourcing; that revenue stream ended when the tool went GPLv3, and a
  replacement support/services business never materialized.

### What it got right

- **The product premise is correct.** Code comprehension is undervalued and
  under-tooled. Developers spend a disproportionate amount of time reading
  code, and dedicated tools for that activity sell on word-of-mouth.
- **Tightly coupling graph and source view.** Sourcetrail's split-pane UI is
  still the cleanest take on "graph that knows about code" of any tool listed
  in this document. It set the bar for navigation feel.
- **Symbol-first model.** The unit of discourse was a symbol with declared
  type, not a file with text. Searches, clicks, and navigation all snapped to
  symbols.
- **Honest scope.** It was a static analyzer. It did not pretend to know runtime
  behavior, did not fake call resolution it could not prove, and did not
  invent edges from heuristics.

### What it missed

- **TypeScript / JavaScript / modern web languages.** Sourcetrail's flagship
  was C++. By the time TypeScript ate the world, it was already coasting.
- **Web-shareable artifacts.** Output was a binary SQLite + a desktop app. You
  could not paste a URL into a PR.
- **CI integration.** No first-class concept of "the graph at commit X" or
  "what changed between two commits." Diff-aware analysis was not a feature.
- **Plugin / language extensibility.** Adding a new language meant linking a
  new analyzer into the C++ codebase, not authoring an indexer that emits a
  standard format.
- **Sustainable funding model.** This is the meta-failure that subsumes the
  others.

### Where codegraph differentiates

- **Universal, language-pluggable IR.** codegraph's IR is the contract;
  language adapters emit into it. Adding a language is bounded engineering, not
  an architectural rewrite. (Sourcetrail's per-language analyzers were
  effectively bespoke.)
- **PR-diff GitHub Action as a first-class artifact.** codegraph runs in CI
  and posts a diff of architectural changes. Sourcetrail had no equivalent.
- **React Flow viewer in the browser.** Linkable, shareable. Sourcetrail's
  Qt app required local install + indexing.
- **MIT, not GPLv3.** Commercial vendors can integrate codegraph without
  license-cascading concerns; many enterprises explicitly bar GPL.
- **Modern static stack (tree-sitter for parsing, typed IR).** No libclang
  version-treadmill on the C++ side.

### Lessons codegraph should explicitly absorb

1. **Sustainability matters more than features.** Pick a maintenance posture
   you can sustain on your worst week, not your best.
2. **Open-sourcing is not a business model.** It is a distribution channel.
   Decide separately how the project earns the time of someone who treats it as
   their job.
3. **Couple graph and source like Sourcetrail did.** Don't ship a graph that
   forces context-switching to a separate IDE to read the actual code.
4. **Ship the artifact where developers already are.** Pull requests, not a
   custom desktop app.
5. **Don't build your own GUI framework.** React + React Flow are good enough,
   and "good enough" is what survives when the founders take new jobs.

### One-line summary

The right idea, the wrong distribution and license model, ten years too early —
the product codegraph is most directly extending.

**Sources:**
- [GitHub: CoatiSoftware/Sourcetrail (archived)](https://github.com/CoatiSoftware/Sourcetrail)
- [Issue #1214: Sourcetrail End Of Life](https://github.com/CoatiSoftware/Sourcetrail/issues/1214)
- [Wikipedia: Sourcetrail](https://en.wikipedia.org/wiki/Sourcetrail)
- [Final release 2021.4.19](https://github.com/CoatiSoftware/Sourcetrail/releases/tag/2021.4.19)
- [CppCast Episode 163 with Eberhard Gräther](https://cppcast.com/eberhard-grather/)

---

## 2. CodeSee

### What it is

A SaaS code visualization product, founded ~2020, that generated interactive
maps of repositories — file trees, dependency graphs, "tours" through code
paths — and tried to integrate code understanding into the PR review flow.
Originally aimed at the "I just joined a new codebase" onboarding pain.

### How it worked under the hood

CodeSee was closed-source SaaS, so the internals are not fully public. From
their public material and product surface:

- A GitHub App ingested the repository.
- A combination of static analysis and language-specific parsers built file-
  and module-level graphs.
- "Code Maps" were the headline output: a 2D rendering of the codebase
  organized by directory + dependency relationships, with the ability to
  highlight what changed in a PR.
- "Review Maps" tried to auto-generate a visual diff of which parts of the
  code an incoming PR touched, intended for reviewers.

### Current status

Acquired by GitKraken on May 14, 2024. Notably, CodeSee announced an intent to
shut down operations on February 22, 2024, before the acquisition was finalized
roughly three months later. The CodeSee product, as a standalone, no longer
exists. Some feature DNA appears in GitKraken's "DevEx Platform" and the
related Launchpad / Code Suggest features, but the original Code Maps
experience was effectively wound down rather than carried forward.

The current state of `codesee.io` (as of writing) still resolves, but is not
actively developed as an independent product.

### What it did well

- **Polished onboarding visualization.** The Code Maps were genuinely pretty,
  zoomable, and shareable.
- **PR review hook.** Putting visualization in the place where reviewers are
  already working was the right call. codegraph follows this same insight.
- **Public-facing demos.** Their landing page Code Maps for popular OSS repos
  drove a lot of word-of-mouth.

### What it missed

- **Surface-level analysis.** The graphs were largely file-and-folder
  topology, not call graphs or type relationships. Beautiful, but not
  load-bearing for architectural decisions.
- **Closed source / closed format.** No way to extend, host, or own the
  output.
- **Paid SaaS in a market where developers expect free OSS analyzers.**
  Pricing pressure was real.
- **No durable moat.** When AI code understanding emerged, the visualization-
  alone proposition did not have a clear "AI can't do this" answer, and the
  business ran out of room to differentiate.

### Where codegraph differentiates

- **MIT OSS, no rent.** No SaaS dependency, no surprise shutdown notice.
- **Typed graph IR, not just file topology.** codegraph's nodes and edges
  carry semantic types from the language layer (functions, classes, modules,
  imports, calls), not just "fileA references fileB."
- **Self-hostable artifact.** The viewer is a static React Flow app over a
  JSON IR. You can host it on GitHub Pages, S3, anywhere.
- **Action-first, not dashboard-first.** codegraph's primary surface is a PR
  comment, not a SaaS dashboard the team has to remember to open.

### One-line summary

Right hypothesis (visualize code at PR time), wrong execution (closed SaaS,
file-level only) — and the eventual GitKraken acquisition validates that the
standalone visualization business is hard.

**Sources:**
- [GitKraken press release on CodeSee acquisition](https://www.gitkraken.com/press/gitkraken-acquires-codesee-launches-devex-platform)
- [Crunchbase: GitKraken acquires CodeSee](https://www.crunchbase.com/acquisition/gitkraken-acquires-codesee--b5a40293)
- [PR Newswire announcement](https://www.prnewswire.com/news-releases/gitkraken-acquires-codesee-launches-new-devex-platform-including-support-for-google-geminis-ai-model-302144298.html)
- [SD Times coverage](https://sdtimes.com/software-development/gitkraken-acquires-codesee-launches-new-devex-platform/)

---

## 3. Sourcegraph

### What it is

Originally: a code search engine over many repositories at once, with
precise (compiler-grade) go-to-definition and find-references via LSIF/SCIP
indexes. Recently: an AI coding assistant business (Cody) layered on top of the
search foundation.

### How it works under the hood

- **Code search engine (Zoekt-derived):** an inverted index of source code
  with regex and trigram support.
- **SCIP (Source Code Intelligence Protocol):** an open, language-agnostic
  protocol for indexing source code. SCIP files describe symbols, references,
  and ranges in a Protobuf schema. Compatible indexers exist for Java, Scala,
  Kotlin (`scip-java`), TypeScript/JavaScript (`scip-typescript`), Rust
  (rust-analyzer), C/C++ (`scip-clang`), Ruby, Python, C# / VB
  (`scip-dotnet`), Dart, and PHP.
- **Cody:** an AI coding assistant that uses the indexed code as retrieval
  context for an LLM.

### Current status

Sourcegraph the company is operational and well-funded but has materially
shifted shape. As of 2025, the free and pro Cody plans were terminated:
Sourcegraph stopped accepting new applicants for Cody Free / Pro on June 25,
2025, and existing free / pro accounts were terminated by July 23, 2025. Cody
is now an enterprise product, with pricing starting around $59/user/month per
public reporting. Individual developer use was redirected toward a separate
product called Amp.

SCIP is still alive, with a recent v0.7.1 release (April 14, 2026) and 253
total commits to main; Sourcegraph announced (March 25, 2026) it is moving SCIP
from a Sourcegraph-owned project to an open governance model with a Core
Steering Committee that includes engineers from Meta and Uber alongside
Sourcegraph. Translation: SCIP is being made institutionally durable
independent of Sourcegraph's commercial bets.

### What they do well

- **Code search at scale.** Sourcegraph remains the gold standard for
  fast, precise search across 10,000+ repositories. codegraph does not
  attempt this.
- **SCIP itself.** As a protocol, SCIP is well-designed, language-pluggable,
  and now multi-vendor governed. It is the closest thing the industry has to a
  shared symbol-graph format.
- **Enterprise-grade ingestion pipelines.** Sourcegraph indexers run against
  enormous polyrepos.

### What they miss

- **Visualization is not their priority.** Sourcegraph is a search box,
  not a graph viewer. The architecture-comprehension use case is not what
  the product is built for.
- **PR-diff architecture changes are not surfaced.** Cody can summarize a
  diff with prose, but there is no "what edges did this PR add to the call
  graph" view.
- **Cody's enterprise pivot leaves a gap.** The individual developer who
  wants to understand a single OSS repo is no longer a Sourcegraph customer.
- **Self-hostability of the search product carries cost.** The OSS edition
  exists but the operational footprint is large.

### Competitive vs. complementary

Mostly **complementary**. codegraph should consume SCIP. SCIP is the de facto
input format for "I have a typed symbol graph for this language" — codegraph's
IR can ingest SCIP and stay focused on the layer above (visualization,
diff-aware semantics, GitHub Action, in-browser viewer). Reinventing
language-specific indexers is unnecessary where SCIP indexers already exist;
codegraph should treat them as a supported input.

Where codegraph and Sourcegraph overlap: both have a "navigate this codebase"
use case. But Sourcegraph is text-search-first with structural lookups
attached; codegraph is graph-first with text browse attached. Different
center of gravity.

### One-line summary

Adjacent giant — codegraph should ingest SCIP and stay focused on the layer
Sourcegraph deprioritized: opinionated, in-browser, PR-diff-aware
visualization.

**Sources:**
- [The future of SCIP (Sourcegraph blog)](https://sourcegraph.com/blog/the-future-of-scip)
- [SCIP repository](https://github.com/sourcegraph/scip)
- [Sourcegraph Cody review 2026](https://weavai.app/blog/en/2026/04/30/sourcegraph-cody-review-2026-enterprise-ai-at-59-mo/)
- [SCIP introduction blog post](https://sourcegraph.com/blog/announcing-scip)

---

## 4. Bloop

### What it is

`bloop` was a Rust-based local code search tool that combined Tree-sitter
parsing, a Tantivy text index, Qdrant vector embeddings, and a Tauri desktop
UI. Positioned as "ChatGPT for your code" — natural-language search over a
local repo, with go-to-definition and go-to-reference navigation for ~10
languages.

### How it worked under the hood

- **Tree-sitter** parsers per language, used to extract symbols and produce
  precise jump-to-definition / jump-to-reference data for Python, TypeScript,
  Rust, Go, Java, C, C++, C#, Ruby, JavaScript, and a handful more.
- **Tantivy** for the inverted text index (Lucene-style).
- **Qdrant** for vector search over embeddings, enabling natural-language
  semantic search.
- **On-device embedding generation**, advertised as privacy-preserving.
- **Tauri** wrapping a web UI for cross-platform desktop distribution.

### Current status

The `BloopAI/bloop` GitHub repository was archived by the owner on January 2,
2025 and is now read-only. Last release was v0.6.5 (April 23, 2024). The repo
has roughly 9.5k stars and 603 forks at the time of archival.

The company itself pivoted away from horizontal AI code search and now focuses
on AI-driven legacy modernization (COBOL → Java, "mAInframer-1"). They appear
to have shipped some unrelated developer tools since (`vibe-kanban` is the
current flagship, ~26k stars as of April 2026), but the original `bloop`
product is dead.

### What it did well

- **Local-first.** The whole pitch was that your code does not leave the
  machine. This is a real differentiation in an enterprise context.
- **Tree-sitter as the parsing substrate.** Pragmatic choice; codegraph
  agrees and uses the same.
- **Polyglot from day one.** Did not build for one language and then bolt on
  others.
- **Clean Rust + Tauri stack.** Reasonably efficient. The desktop binary was
  small and fast.

### What it missed

- **No graph view.** Bloop was a search box with reference navigation, not a
  graph. You could find code, but you could not see the shape of the system.
- **No CI / PR integration.** It was a desktop app, end of story.
- **The AI code search market commoditized rapidly.** Once Cursor, Copilot,
  Claude Code, and Cody all included codebase-aware retrieval as a default
  feature, a standalone Bloop had no remaining wedge.
- **No durable artifact.** Index lived on the user's machine. Could not be
  shared or persisted in the repo.

### Where codegraph differentiates

- **Graph IR, not just an index.** codegraph's primary output is a typed
  graph artifact that can be persisted, diffed, and shared.
- **Diagram, not chat.** codegraph is not trying to be an AI assistant. It
  is the structural skeleton that AI assistants and humans both benefit from
  reading.
- **Lives in the repo / PR, not on a single laptop.** Bloop's local-first
  posture, paradoxically, made the result un-shareable.

### One-line summary

Bloop validated that Tree-sitter + multi-language indexing is a viable
substrate, then taught us that "AI code search as a standalone product" is
not — pivot or die.

**Sources:**
- [GitHub: BloopAI/bloop (archived)](https://github.com/BloopAI/bloop)
- [BloopAI organization](https://github.com/BloopAI)
- [Bloop AI legacy modernization profile](https://sales.superagi.com/company/bloop)

---

## 5. GitHub Code Search (Blackbird)

### What it is

GitHub's first-party search across all of GitHub's hosted code, replacing the
old Elasticsearch-based code search with a Rust-built engine internally named
Blackbird. Available in the GitHub.com UI and via API.

### How it works under the hood

- Built in Rust, from scratch, by GitHub's search team.
- N-gram-based inverted index with variable-length substrings, designed to
  support exact substring and regex queries efficiently. Per the GitHub blog:
  "we want to search for punctuation."
- Sharded across many nodes, tagged with permissions and language metadata
  via Linguist.
- Targets sub-second response times for the 95th percentile of global
  queries against ~200M repos, ~640 QPS.

### What it does well

- **Speed at scale.** It is genuinely fast over the largest code corpus on
  Earth.
- **Regex.** First-class.
- **Symbol search.** Lightweight symbol search via Linguist + indexing
  hints, good enough for "find this function name."
- **Free.** Available for any repository the user has access to.

### What it can't do

- **Architecture-level understanding.** It does not build a call graph. It
  does not know that `foo()` calls `bar()`. It can find the literal text
  `foo` and `bar` in proximity but cannot answer "what would break if I
  changed the signature of `foo`."
- **Cross-language semantics.** A TypeScript frontend that calls a Python
  service via HTTP is two unrelated text corpora to Blackbird. There is no
  "this `fetch` URL maps to that `@app.route`" reasoning.
- **Diff-aware structural delta.** "What did this PR change about the
  architecture?" is outside the model. Blackbird answers "where does this
  string appear," not "what relationships did this commit alter."
- **Renderable graph.** Output is a list of file:line hits. There is no
  visualization.
- **Type-resolution beyond what Linguist + tree-sitter symbols give for
  free.** No data flow, no inheritance graph, no module dependency view.

### Where codegraph differentiates

- **codegraph is the layer above search.** Once you know where to look
  (Blackbird's job), codegraph tells you why those things are connected.
- **Architecture diff in PRs.** No analog in Blackbird.
- **Self-host on a single repo.** Blackbird requires being on GitHub at
  GitHub's scale; codegraph runs on one repository as a standalone artifact.

### One-line summary

The world's best text-and-regex code search — orthogonal to architecture
visualization, and explicitly not trying to be that.

**Sources:**
- [The technology behind GitHub's new code search (GitHub Blog)](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/)
- [The Register coverage of Blackbird](https://www.theregister.com/2023/05/09/blackbird_github_search/)
- [Project Blackbird (MarkTechPost)](https://www.marktechpost.com/2023/05/12/project-blackbird-githubs-new-search-engine/)

---

## 6. JetBrains Diagrams / VS Code "Show Call Hierarchy"

### What they are

Two distinct categories of IDE-bound visualization:

- **JetBrains UML class diagrams + Module dependency diagrams + Dependency
  Structure Matrix (DSM).** Available in IntelliJ IDEA Ultimate (and other
  JetBrains IDEs). Generates UML-style class diagrams, module-level dependency
  graphs, and DSM (a triangular matrix showing inter-module dependencies and
  cycles).
- **VS Code "Show Call Hierarchy" / "Show Type Hierarchy".** A standardized
  capability in the Language Server Protocol (LSP), implemented per-language
  by the language server.

### How they work under the hood

- **JetBrains:** the IDE owns its own type-resolved code model (PSI — Program
  Structure Interface). The diagrams are projections of this in-memory model.
  Real, semantic, type-resolved data; the same engine that powers refactoring
  and inspections.
- **LSP call hierarchy:** the editor sends a `textDocument/prepareCallHierarchy`
  request to the active language server, which responds with the hierarchy
  the server has computed from its own indexer. Quality varies wildly by
  language server.

### What they do well

- **Trustworthy data.** JetBrains' diagrams are built on the same compiler-
  grade analysis the IDE uses for refactoring. Not heuristic.
- **Tight in-IDE feedback loop.** Click a method, see callers, jump to
  callers. Latency is low.
- **Multiple presentation modes.** UML class diagram, package dependency
  diagram, DSM matrix view. Each illuminates a different question.

### Limitations

- **IDE-bound. Period.** You cannot share a JetBrains diagram with someone
  who does not have the same IDE installed and the same project loaded. There
  is no URL.
- **Single-language scope.** LSP call hierarchy is per-language-server.
  TypeScript's call hierarchy stops at the network boundary; Python's
  language server picks up on the other side, with no shared graph.
- **Per-class scope.** JetBrains UML diagrams are notoriously narrow:
  generating a diagram is a per-class operation; you must explicitly add
  more classes. Whole-system architectural views are not what they're for.
  Public reports note: "UML diagram shows dependencies of 1 class only"
  unless you manually expand.
- **No PR-diff workflow.** No concept of "what did this commit change about
  the diagram."
- **No persistence.** Diagrams are ephemeral views, not artifacts. There is
  no "save this graph and embed it in the docs."
- **DSM is powerful but unloved.** The Dependency Structure Matrix is
  arguably the best feature for spotting cycles and improper coupling, and
  it is buried three menu levels deep behind a feature most developers have
  never seen.

### Where codegraph differentiates

- **Editor-agnostic.** A static React app + a JSON artifact. Works for VS
  Code users, JetBrains users, vim users, and anyone reading the GitHub UI.
- **Whole-system view by default.** The graph is scoped at the repository,
  not the class.
- **Cross-language edges as a first-class concept.** When the
  TypeScript-to-Python HTTP boundary can be inferred (matching route
  patterns, contract types), codegraph can render that edge — neither LSP
  nor JetBrains will.
- **Persisted artifact.** The graph is committed-or-built-in-CI, not
  rebuilt every time you open the IDE.

### One-line summary

Excellent in-IDE precision, fundamentally trapped behind the editor pane —
codegraph picks up where they end (sharing, persistence, cross-language).

**Sources:**
- [IntelliJ IDEA: UML class diagrams](https://www.jetbrains.com/help/idea/class-diagram.html)
- [IntelliJ IDEA: Module dependency diagrams](https://www.jetbrains.com/help/idea/project-module-dependencies-diagram.html)
- [IntelliJ IDEA: Dependency Structure Matrix](https://www.jetbrains.com/help/idea/dsm-analysis.html)
- [LSP specification 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- [LSP call hierarchy proposal](https://github.com/microsoft/language-server-protocol/issues/468)

---

## 7. Glean (Meta / Facebook)

### What it is

Meta's open-source system for collecting, deriving, and querying facts about
source code. Internally, Glean powers code search, navigation, and analysis
across Meta's monorepo (especially Hack — the language Glean was originally
shaped around). Open-sourced in August 2021, with an additional push in
December 2024 publicizing the open-source story.

### How it works under the hood

- **Schema-driven fact database.** Glean defines code knowledge as typed
  *facts* in a schema (Angle), and stores billions of these facts in a
  custom store optimized for read-heavy analysis workloads.
- **Indexers** convert source code into facts. Glean ships indexers
  written in (or wrapping) the language's existing toolchain. Hack is
  fully integrated into the Hack typechecker.
- **Query language: Angle.** A Datalog-flavored query language for asking
  arbitrary structural questions ("find all functions that call X transitively
  from public APIs").
- **Composable derivation.** New fact types can be derived from base facts via
  Angle rules, so analyses build on the same substrate.

### Current status (OSS)

The `facebookincubator/Glean` repository is open and actively developed. The
README explicitly notes the project is "in pre-release," with rough edges,
limited language coverage, and a build system that needs work. Languages with
direct support inside the OSS Glean release: C++, C, Hack, Haskell,
JavaScript/Flow. Additional language coverage exists *via* SCIP or LSIF format
ingestion (Rust, Go, TypeScript, Java, Python, .NET).

License: BSD. Primary languages: Hack (~42%) + Haskell (~34%) — telling, since
the system was designed by and for the Meta toolchain.

### What it does well

- **Theoretical clean architecture.** Facts as a typed substrate is the
  right design. codegraph's IR is in spiritual alignment.
- **Scale.** Glean handles Meta-scale codebases. The data model bends
  toward billions of facts, not thousands.
- **Datalog-style queries are powerful.** "Find all transitive callers of
  any function annotated `@deprecated`" is a one-liner.
- **First-class derivation.** Adding new analyses is composing rules, not
  writing new indexers.

### What it misses

- **Operational complexity is real.** Glean is not a Saturday-afternoon
  install. The deployment story is "build the server, run the indexers,
  manage storage."
- **No first-party visualization.** Glean is a query engine, not a viewer.
- **OSS Glean is Hack-and-Haskell-shaped.** The most polished indexers are
  the languages Meta uses internally. Outside-Meta languages are second-class
  or via SCIP.
- **Pre-release.** The maintainers themselves flag the rough edges.
- **Mostly invisible to non-Meta engineers.** Despite open-sourcing in 2021
  and a public push in late 2024, community adoption is small.

### Where codegraph differentiates

- **Single-binary or single-Action install posture.** No fact server to
  operate.
- **Visualization is the headline.** Glean has the substrate; codegraph has
  the surface.
- **OSS-developer-shaped, not Meta-shaped.** TypeScript / Python / Go
  first-class; Hack not on the roadmap.
- **No Datalog learning curve.** The IR is queryable in JS / TS for the
  power user; the default surface is graphical.

### Possible synergy

codegraph could in principle ingest Glean's exported facts the same way it
ingests SCIP. It would not be a flagship integration in 2026 — Glean's user
base outside Meta is too small — but the IR design should not preclude it.

### One-line summary

The deepest substrate of any tool in this list, with the highest activation
energy and the smallest community — codegraph aims for one-tenth the depth and
one-hundredth the operational cost.

**Sources:**
- [GitHub: facebookincubator/Glean](https://github.com/facebookincubator/Glean)
- [Indexing code at scale with Glean (Engineering at Meta)](https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/)
- [Glean documentation site](https://glean.software/)
- [Hacker News discussion (December 2024)](https://news.ycombinator.com/item?id=42568516)

---

## 8. DeepGit / GitKraken / GitHistory

### What they are

A category, not one product: **branch and history visualizers.** They render
the git DAG — branches, merges, rebases, who-changed-what-when — visually.
Examples: GitKraken Desktop (commercial, very polished), DeepGit (focused on
blame and history exploration), VS Code's "GitHistory" / "GitLens"
extensions, Sublime Merge, Tower, GitUp.

### How they work under the hood

- Read the local `.git` directory.
- Render the commit DAG with branch lanes, merge points, rebase footprints.
- Layer on top: blame, file history, per-line authorship, search across
  commits.

### What they do well

- **Commit-graph clarity.** The state of the art (GitKraken Desktop) is
  genuinely good at making "this branch was rebased onto that one and then
  merged" legible.
- **Authorship / ownership context.** Who touched a file last, who has the
  most commits in a directory, how a function evolved.
- **Conflict resolution.** Visual merge tooling.

### Why they are not codegraph competitors

These tools answer **history** questions, not **architecture** questions.
"Who changed this file in the last 6 months" is orthogonal to "what calls
this function and what would break if I changed it." Both are useful; they
are not the same axis.

### Where codegraph differentiates

- **Snapshot at a commit, not a sequence of commits.** codegraph cares
  about the structural state of code at a point in time, not the history of
  textual edits.
- **Symbol-aware, not file-aware.** Git-history tools think in files;
  codegraph thinks in functions, classes, modules, calls.
- **PR-diff is a structural diff.** "This PR adds 3 edges to the call
  graph" vs. git's "this PR adds 47 lines."

### One-line summary

Adjacent and complementary — answers about *time* and *authorship*, where
codegraph answers about *structure* and *dependencies*.

**Sources:**
- [GitKraken commit graph features](https://www.gitkraken.com/features/commit-graph)
- [Tools to visualize the history of a git repository](https://livablesoftware.com/tools-to-visualize-the-history-of-a-git-repository/)
- [DeepGit alternatives](https://slashdot.org/software/p/DeepGit/alternatives)

---

## 9. Structurizr / IcePanel

### What they are

Architecture-as-code (Structurizr) and architecture-as-collaborative-canvas
(IcePanel) tools, both built around the **C4 model** (Context, Container,
Component, Code). Architecture diagrams are first-class artifacts here, but
they are **manually authored**, not derived from source.

### How they work under the hood

- **Structurizr DSL.** A text DSL where you declare systems, containers,
  components, and relationships. From one model you can render multiple views
  (system context, container, component). The DSL is open source. The
  reference implementation is by Simon Brown (the C4 model's author).
  Storage and rendering are available either via Structurizr Lite (free,
  self-hosted) or Structurizr Cloud (paid).
- **IcePanel.** Web-based, drag-and-drop modelling that retains the C4
  model semantics underneath. Recent additions (2025) include export to
  Markdown, HTML, Structurizr DSL, and `llms.txt` (LLM-friendly export).
  Has a "drafting" feature for proposing architectural changes.

### What they do well

- **Conceptual rigor.** The C4 model is a well-thought-out vocabulary for
  architectural levels. Manually authored diagrams that follow it stay
  legible across the org.
- **Designed-architecture vs. as-built-architecture.** They capture
  intent. Useful for greenfield design, RFCs, and onboarding docs.
- **Stable, established communities.** Both have real customers; neither
  is going anywhere soon.

### What they miss

- **They drift.** This is the categorical weakness. The diagram is a
  human's mental model of the system, written by hand, that the code is
  not obligated to match. Six months later, the diagram lies. There is no
  enforcement loop.
- **No automatic derivation from code.** They are documentation tools, not
  analysis tools.
- **Separate workflow from the codebase.** The architect updates the model;
  the developer doesn't necessarily.

### Different category, but adjacent

These are *intent* tools. codegraph is a *reality* tool. The honest framing
is that codegraph and Structurizr/IcePanel could coexist: Structurizr says
"this is what we want," codegraph says "this is what is true," and the gap
between them is an engineering signal.

### Where codegraph differentiates

- **Derived, not authored.** codegraph's graph is generated from source.
  No drift, by construction.
- **Free.** No SaaS spine.
- **Symbol-level granularity, not just box-and-line C4.** codegraph can
  drill into function-call edges; Structurizr stops at the component box.

### Possible synergy

codegraph could export to Structurizr DSL or `llms.txt` (IcePanel's recent
addition) for teams that want to feed the as-built architecture into their
intent-modeling tool. This is a sensible export target, not a competitive
front.

### One-line summary

Different category (intent vs. reality), worth keeping on the radar as
export targets — they will outlast many tools in this list.

**Sources:**
- [Structurizr DSL documentation](https://docs.structurizr.com/dsl)
- [IcePanel home](https://icepanel.io/)
- [IcePanel vs Structurizr comparison](https://icepanel.io/blog/2025-11-14-icepanel-vs-structurizr)
- [IcePanel: pros and cons of diagram-as-code](https://icepanel.io/blog/2025-02-05-the-pros-and-cons-of-diagram-as-code-for-software-architecture)
- [IcePanel: smarter exports (2025-05-19)](https://icepanel.io/blog/2025-05-19-new-smarter-exports)

---

## 10. Mermaid / D2 / Graphviz (in-repo)

### What they are

Text-based diagramming languages, embeddable in Markdown / docs, with
deterministic rendering. Mermaid (JavaScript-rendered, supported natively in
GitHub-flavored Markdown), D2 (Terrastruct, prettier defaults, polished
layout), Graphviz (the OG, dot language, deterministic and configurable).

### How they work under the hood

- A small DSL describes nodes and edges.
- A renderer (Mermaid in-browser, D2 via the `d2` CLI, Graphviz via `dot`)
  produces SVG or PNG.
- The DSL is hand-written. Always.

### What they do well

- **Live in the repo.** Diagrams travel with the code. Diff-able. Code-
  reviewable. PR-able. This is huge.
- **Free and OSS.** All three.
- **Deterministic rendering.** Same input → same output. CI-friendly.
- **Markdown integration.** Mermaid in particular renders inline on GitHub
  out of the box.

### What they miss — the same thing every time

**The stale-doc problem.** Every Mermaid / D2 / Graphviz diagram in a
repo is a hand-written assertion about the codebase that the codebase is
not aware of. Refactor a module, the diagram still claims the old shape.
Add a new service, the diagram doesn't know about it. Six months in,
nobody trusts the diagrams, and they get deleted.

This is the **single biggest gap in the market** that codegraph is
exploiting. Hand-authored diagrams drift. Generated diagrams don't.

Other limits:

- **Manually authored.** Engineering effort scales with the diagram, not
  with the code.
- **No semantic awareness.** The diagram doesn't know that "auth" in box
  A and "auth" in box B are the same module — it just renders text.
- **Non-trivial rendering for large graphs.** Graphviz handles scale best;
  Mermaid struggles past a few hundred nodes; D2 is in between.

### Where codegraph differentiates

- **Generated from source. No drift. By construction.**
- **Symbol-grade nodes.** Node identity is anchored in the typed IR, not
  in a string a human typed.
- **Diff is structural.** A code change that adds an edge to the graph
  shows up automatically; a Mermaid diagram requires the author to
  remember to update it.

### Possible export target

codegraph could (and probably should) render its IR to Mermaid for embed-
in-README workflows. The point is not to replace Mermaid — it's to make
the Mermaid you embed *true*.

### One-line summary

The right place (in-repo, code-reviewable, deterministic) — the wrong
authoring story (manual, drift-prone). codegraph keeps the place and
fixes the authoring.

**Sources:**
- [Mermaid docs](https://mermaid.js.org/)
- [D2 / Terrastruct](https://d2lang.com/)
- [Graphviz / DOT](https://graphviz.org/)
- [Technical Diagrams in Docs-as-Code 2026](https://www.docsie.io/blog/articles/technical-diagrams-docs-as-code-2026/)
- [Architecture diagrams as code: Mermaid vs C4](https://medium.com/@koshea-il/architecture-diagrams-as-code-mermaid-vs-architecture-as-code-d7f200842712)

---

## 11. Backstage TechDocs / Catalog Graph (Spotify)

### What it is

Spotify's open-source developer portal framework. Two components are relevant
here:

- **TechDocs:** "docs-as-code" plugin — Markdown lives next to the service,
  builds a static doc site, served via the Backstage portal. ~5,000+ docs
  sites in the Spotify-internal deployment, ~10,000 average daily hits per
  the publicly-shared figures.
- **Software Catalog + Catalog Graph plugin:** the Catalog is a registry of
  every service, library, website, data pipeline, and team in the org,
  linked by typed relations (`ownedBy`, `partOf`, `dependsOn`,
  `consumesApi`, etc.). The Catalog Graph plugin renders these
  relationships as an interactive graph.

### How it works under the hood

- **Catalog ingestion** is config-driven: each component in the org has a
  YAML descriptor (`catalog-info.yaml`) declaring what it is, who owns it,
  what it depends on, what API it provides. Backstage scrapes these from
  GitHub (or other locations) and builds the catalog.
- **Catalog Graph** is a React component (`EntityRelationsGraph`) that
  walks the entity graph and renders it.
- 2025 additions: AI knowledge assistant (AiKA), Data Experience plugin —
  enterprise-direction features.

### What it does well

- **Org-level architecture-of-services view.** Backstage knows about every
  service the org owns. The graph is at the right level for SREs and
  platform teams.
- **Ownership and on-call.** Tied directly to the org chart.
- **Polished UI.** Backstage is professionally designed.
- **Wide enterprise adoption.** It's the de facto internal developer
  portal at hundreds of large companies.

### What it misses

- **The catalog is hand-maintained.** Every component has a `catalog-info.yaml`
  that someone wrote and someone has to update. Entities are declared, not
  derived. Same drift problem as Structurizr.
- **No code-level granularity.** A service is a node. What's *inside* the
  service — its functions, its modules, its call graph — is invisible.
- **Heavy install.** Backstage is a deployment, not a CLI. You don't
  spin up Backstage for an OSS repo on GitHub. It's for the platform
  team of a 500-person engineering org.
- **Service-mesh-shaped, not codebase-shaped.** Optimized for "we have 200
  microservices" not "we have one big monorepo."

### Where codegraph differentiates

- **Code-derived, not human-declared.** No `catalog-info.yaml` to forget.
- **Function-level granularity, not service-level.** codegraph operates
  inside the box that Backstage labels as a single component.
- **Single-repo install.** A GitHub Action; not a Java + Postgres +
  Node platform deployment.
- **Free and OSS without enterprise spine.** Backstage technically is
  too, but the operational cost reads as enterprise-only.

### Possible synergy

codegraph could publish a Backstage TechDocs plugin that embeds the
in-browser viewer in a service's TechDocs page. Cross-pollination, not
competition.

### One-line summary

Org-level architecture-of-services portal — codegraph operates one zoom
level deeper, inside a single service's code, with no hand-maintained
catalog.

**Sources:**
- [Backstage TechDocs documentation](https://backstage.io/docs/features/techdocs/)
- [Backstage Catalog Graph plugin (GitHub)](https://github.com/backstage/backstage/blob/master/plugins/catalog-graph/README.md)
- [Roadie: Backstage Catalog Graph](https://roadie.io/backstage/plugins/catalog-graph/)
- [AiKA and Data Experience plugins (Spotify, 2025)](https://backstage.spotify.com/discover/blog/aika-data-plugins-coming-to-portal)
- [Top 10 Backstage plugins for 2025 (OpsLevel)](https://www.opslevel.com/resources/top-10-backstage-plugins-for-2025)

---

## 12. Static Analyzers (SonarQube / Semgrep / CodeQL)

### What they are

Three large players in static code analysis, with overlapping but
distinguishable focus:

- **SonarQube.** Continuous code-quality + SAST platform. Bugs, code smells,
  security hotspots, coverage tracking, dashboards.
- **Semgrep.** Pattern-based static analyzer. Rules are written in syntax
  that resembles the source language. Optimized for speed and rule
  authoring ergonomics — public benchmarks reference 20K–100K LOC/sec/rule
  for Semgrep vs. ~0.4K LOC/sec for SonarQube on production rulesets.
- **CodeQL.** GitHub's variant analysis engine. Compiles source into a
  relational database (AST + data flow + control flow); analyses are queries
  in QL, a Datalog-derived language.

### How they work under the hood

- **SonarQube:** per-language analyzers (largely in-house, partly using
  community tooling) that emit issues against rules + thresholds.
- **Semgrep:** tree-sitter-based parsers normalized to a generic AST; rules
  match against this AST. Wide language coverage (35+, with many
  experimental).
- **CodeQL:** language extractors compile source into a CodeQL database;
  data-flow and control-flow facts are first-class; queries can express
  taint analysis, dead code, etc. ~12 deeply-supported languages.

### Where these overlap with codegraph

- **Dead code detection.** All three can find unused symbols. codegraph
  also surfaces this naturally because the IR has reachability information.
- **Cyclic dependencies.** SonarQube reports them; codegraph visualizes
  them.
- **Complexity metrics.** Cyclomatic complexity, fan-in/fan-out — all three
  compute these; codegraph naturally produces fan-in/fan-out from the
  graph.

### Where they differ

- **Lint vs. visualize.** Static analyzers produce *findings*: a list of
  issues to fix, scored by severity. codegraph produces a *graph*: a shape
  to understand. Different deliverable, different UX.
- **Security as the wedge.** CodeQL especially is wedged on
  vulnerability detection (SQL injection, XSS, taint flows). codegraph
  does not aspire to be a SAST.
- **Rule authoring.** Semgrep's rule story is best-in-class; codegraph
  has no comparable rule authoring surface (and, deliberately, doesn't
  need one — the graph is the surface).
- **Operational complexity.** SonarQube needs a server. CodeQL runs in
  GitHub Actions but with significant analysis time. Semgrep runs as a
  CLI / SaaS; lightest of the three. codegraph is closest to Semgrep in
  posture: a CLI + an Action.

### What they miss that codegraph fills

- **Visualization is not their game.** SonarQube has dashboards; CodeQL
  has the GitHub UI; Semgrep has a findings list. None has a graph
  viewer.
- **Architecture-as-output.** They tell you about violations of rules.
  They do not draw the picture of the system.
- **Onboarding-the-human use case.** A new engineer joining the team
  benefits more from "here's the shape of the codebase" than from "here
  are 247 lint findings."

### Where codegraph differentiates

- **Different output type entirely.** Graph, not findings list. Both
  matter, neither replaces the other.
- **No SaaS dependency.** CodeQL is GitHub-bound; SonarQube wants a
  server. codegraph is a static artifact.
- **Diff in PRs is structural, not enumeration.** codegraph's PR comment
  is "your PR added these edges and removed these," not "your PR
  introduced 4 new findings."

### One-line summary

Adjacent, sometimes overlapping on dead code and cycle detection, but
fundamentally a different deliverable (findings list vs. graph) — these
are coexisters, not replacers, and SonarQube/CodeQL especially will outlive
many tools in this list.

**Sources:**
- [Semgrep vs SonarQube comparison (Semgrep)](https://semgrep.dev/docs/faq/comparisons/sonarqube)
- [Static code analysis tools comparison (Rafter, 2026)](https://rafter.so/blog/static-code-analysis-tools-comparison)
- [Semgrep vs CodeQL technical comparison (2026)](https://konvu.com/compare/semgrep-vs-codeql)
- [SonarQube vs CodeQL comparison](https://medium.com/@suthakarparamathma/sonarqube-vs-codeql-code-quality-tool-comparison-32395f2a77b3)

---

## Competitive Positioning Summary

codegraph sits in a quadrant defined by three axes: **derived (not
authored)**, **graph-shaped (not findings-shaped)**, and **PR-native (not
dashboard-native)**. Sourcetrail nailed the first two and missed the
third (and died of unrelated sustainability problems). CodeSee nailed the
third but only at file-topology depth (and got acquired). Sourcegraph and
SCIP are deep on the indexing substrate but visualization and diff-aware
PR semantics are not the priority since the Cody enterprise pivot. Glean
is the deepest substrate of all and has near-zero distribution. JetBrains
and LSP have the precision but are editor-bound. Static analyzers are
findings-shaped, not graph-shaped. Backstage is service-shaped, not
code-shaped. Mermaid/D2/Graphviz live in the right place but drift.

The three concrete gaps in the market codegraph is exploiting:

1. **The drift gap.** Every hand-authored architecture artifact in this
   landscape — Mermaid diagrams, Structurizr models, IcePanel canvases,
   Backstage `catalog-info.yaml` files — drifts. Generated artifacts don't.
   codegraph is a generated artifact that lives where the hand-authored
   ones live (in the repo, in the PR), with the same review ergonomics
   and none of the lying.

2. **The PR-diff structural gap.** No tool in this list ships a "what
   architectural edges did this PR add or remove" first-class output.
   GitHub's diff is text-shaped. CodeQL's diff is findings-shaped.
   Sourcegraph's Cody summarizes diffs in prose. None of them surface
   the structural delta as a graph diff. This is the codegraph PR
   GitHub Action's wedge.

3. **The OSS-with-no-SaaS-spine gap.** Sourcetrail (defunct), CodeSee
   (acquired and folded), Bloop (archived), Glean (Meta-shaped), Backstage
   (enterprise install), Sourcegraph (enterprise pivot), SonarQube
   (server), CodeQL (GitHub-only) — every previous attempt at this
   problem has been encumbered by either a company that pivoted away,
   a SaaS bill, an enterprise install footprint, or a GPL license.
   codegraph is MIT, runs as a CLI and a GitHub Action, has no server,
   and stands alone if the maintainer takes a six-month sabbatical. The
   Sourcetrail post-mortem made this constraint non-negotiable.

The honest framing: codegraph is not the deepest analyzer (Glean is),
not the broadest indexer (SCIP is), not the prettiest diagram tool
(IcePanel is), not the fastest search (Blackbird is), and not the most
rigorous architecture model (Structurizr is). It is the only artifact in
this landscape that is **derived from code**, **rendered as a graph**,
**shipped in pull requests**, **MIT-licensed**, and **operable without
a SaaS account**. That intersection is empty in May 2026, and that is the
specific shape of the wedge.
