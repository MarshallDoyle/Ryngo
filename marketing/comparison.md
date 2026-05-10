# codegraph vs. the landscape

A reasonably honest comparison of codegraph (MIT, no-LLM, local-first static-analysis tool) against the tools developers actually reach for when they want to understand a codebase.

We've tried hard not to oversell. Codegraph loses on several columns — most obviously cross-repo navigation, IDE integration polish, and breadth of language coverage. Where competitors win, we say so.

Updated 2026-05.

---

## TL;DR

If you want **a graph IR of one repo, with cross-language and cross-service edges, diffed on every PR, that runs locally with no hosted backend** — that's the niche codegraph fills. If you want fuzzy semantic search, an AI pair programmer, or cross-repo "who calls this function across 4,000 services," you want Sourcegraph.

The honest framing: codegraph competes with Sourcetrail's ghost, with Mermaid diagrams that nobody updates, and with the call-hierarchy panel in your IDE. It does not compete with Sourcegraph or Cody. Different problem.

---

## The competitors

| Tool | What it actually is | Status |
|---|---|---|
| **Sourcetrail** | Native desktop source explorer with a graph + code pane | Discontinued by Coati Software in late 2021; repository archived. Community forks exist (NumbatUI by Quarkslab, turbinelu/Sourcetrail-Fork, etc.) but none have meaningful momentum. |
| **CodeSee** | Web-based code maps and tour authoring | Acquired by GitKraken in May 2024. Folded into the GitKraken DevEx platform; team reportedly down to ~3 people. The standalone product as it existed is effectively in maintenance. |
| **Sourcegraph (+ Cody)** | Cross-repo code search + AI assistant | Very alive. Free/Pro tiers were discontinued; the only plan now is Enterprise at roughly $59/user/month with self-hosted deployments typically starting around $50–75k/year. |
| **Bloop** | Rust-based desktop AI code search | The parent company announced shutdown in April 2026 ("couldn't find a business model"). The desktop app remains downloadable and the code is Apache 2.0, but it is not actively maintained. |
| **GitHub code search** | The search bar at the top of github.com | Alive, free, indexes private repos you can access. Lexical/regex/symbol search; not a graph. |
| **Mermaid in-repo diagrams** | Markdown fenced blocks rendered as diagrams | Alive and ubiquitous. Hand-authored. The diagrams drift the moment code changes. |
| **IDE call hierarchy** | "Show Call Hierarchy" in VS Code, "Find Usages" in JetBrains | Alive. Powered by the language server. Single-language, single-process, in-IDE. |
| **SonarQube** | Static analysis for bugs / smells / coverage | Alive. Community Build is free and open source (~15 languages). Paid tiers from ~$2.5k/yr (Developer) to ~$100k/yr (Data Center). |
| **CodeClimate (Quality)** | Hosted code quality / maintainability grading | Alive as a SaaS. Mostly metrics and issue trending, not graph nav. |

---

## The comparison table

Legend: ✓ = supports it well · partial = supports a slice with caveats (footnote) · ✗ = doesn't · n/a = the column isn't really applicable to that tool's shape.

| Capability | codegraph | Sourcetrail | CodeSee | Sourcegraph + Cody | Bloop | GitHub code search | Mermaid | IDE call hierarchy | SonarQube | CodeClimate |
|---|---|---|---|---|---|---|---|---|---|---|
| **Cross-language edges** (e.g. TS calls into a Python service-worker boundary) | ✓ | partial [^st-xlang] | partial [^cs-xlang] | partial [^sg-xlang] | partial [^bl-xlang] | ✗ | n/a [^merm-na] | ✗ [^ide-xlang] | partial [^sq-xlang] | ✗ |
| **Cross-service edges** (frontend `fetch('/api/users')` ↔ backend `app.get('/api/users')`) | ✓ | ✗ | partial [^cs-xservice] | partial [^sg-xservice] | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **PR-diff visualization** (this PR adds these nodes/edges) | ✓ | ✗ | partial [^cs-prdiff] | partial [^sg-prdiff] | ✗ | ✗ | ✗ | ✗ | partial [^sq-prdiff] | partial [^cc-prdiff] |
| **Typed edges** (call vs. import vs. HTTP vs. SQL vs. event) | ✓ | partial [^st-typed] | ✗ | partial [^sg-typed] | ✗ | ✗ | n/a | ✗ [^ide-typed] | ✗ | ✗ |
| **Pure-vs-effectful annotation** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | partial [^sq-pure] | ✗ |
| **Framework adapters** (Express, FastAPI, Prisma, tRPC, GraphQL, etc.) | ✓ | ✗ | ✗ | partial [^sg-framework] | ✗ | ✗ | ✗ | ✗ | partial [^sq-framework] | ✗ |
| **Local-first / no hosted backend** | ✓ | ✓ | ✗ | partial [^sg-local] | ✓ | ✗ | ✓ | ✓ | partial [^sq-local] | ✗ |
| **OSS license** | ✓ MIT | ✓ GPLv3 [^st-license] | ✗ | partial [^sg-license] | ✓ Apache 2.0 [^bl-license] | ✗ | ✓ MIT | partial [^ide-license] | partial [^sq-license] | ✗ |
| **Determinism (no LLM in the analysis path)** | ✓ | ✓ | partial [^cs-det] | ✗ [^sg-det] | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Free for private repos** | ✓ | ✓ | ✗ [^cs-free] | ✗ [^sg-free] | ✓ [^bl-free] | ✓ | ✓ | ✓ | partial [^sq-free] | ✗ [^cc-free] |

---

## Where competitors clearly win

We picked these tools because they overlap with codegraph in some dimension. They also each beat us on something. Naming it builds trust.

### Sourcegraph wins on
- **Cross-repo navigation.** If your org has 4,000 services across 200 repos, Sourcegraph's universal index is the answer. Codegraph is one-repo-at-a-time and we have no plausible roadmap to compete with that.
- **Symbol search at scale.** Sub-second go-to-definition across a monorepo of millions of files. Codegraph's IR is fine for one repo but not designed as a search index.
- **Polished web UI and AI chat.** Cody has years of product investment. We don't.
- **Language breadth.** Sourcegraph indexes everything they can get a parser for. Codegraph ships adapters for a much shorter list.

### GitHub code search wins on
- **Zero setup.** It's already there. Free. Indexes private repos. Regex search. For "I just need to find the string" it's almost always the right answer.

### IDE call hierarchy wins on
- **In-flow ergonomics.** The graph shows up where you're already typing. No second window, no PR comment, no separate viewer. For "what calls this function in the language I'm currently in," nothing beats it.

### Mermaid wins on
- **Storytelling.** Hand-drawn architecture diagrams in `README.md` carry intent that no auto-generated graph can. They lie eventually, but while they're true they're more readable than a derived graph.

### SonarQube wins on
- **Bug/quality detection.** SonarQube has 15+ years of rule curation. Codegraph isn't trying to be a linter. If you want "tell me where my null-deref bugs are," Sonar wins.
- **CI integration breadth.** Every CI vendor has a Sonar plugin.

### Sourcetrail (in its prime) won on
- **Beautiful interactive graph + source pane UX.** That UI was the bar. Codegraph's web viewer is acceptable; Sourcetrail's native app, when it was alive, was better.

### CodeSee (in its prime) won on
- **Onboarding tours.** Click-through code maps narrated for new hires. We don't have that.

---

## Where codegraph is differentiated

Stating these without overclaiming.

1. **Cross-service edges.** When a React component calls `fetch('/api/users')` and an Express handler does `app.get('/api/users', …)`, codegraph draws an edge between them. None of the comparison tools do this out of the box. This matters because microservice boundaries are where most "I had no idea this depended on that" surprises live.

2. **Typed edges.** Codegraph distinguishes a function call from an import from an HTTP call from a SQL query from an event publish/subscribe. Most graph tools collapse all of these into "edge." When you can filter by type, the graph stops being a hairball.

3. **Pure-vs-effectful tagging.** Each node carries an effect annotation (pure / IO / network / mutation / async). This is conservative — we err toward "effectful" — but it's enough to answer "what's the dependency footprint of this pure function?" reliably.

4. **PR-diffed by design.** The GitHub Action diffs the IR on each PR and posts a comment showing added/removed/changed nodes and edges. Mermaid won't do this for you. SonarQube and CodeClimate post quality deltas, not structural deltas.

5. **No LLM in the path.** Same input, same output, every time. For audit, compliance, and just plain trust, this matters. The AI tools (Cody, Bloop) are non-deterministic by design.

6. **Local-first with an MIT license.** No telemetry, no sign-in, no SaaS dependency. Run it on an air-gapped machine if you want.

---

## Where codegraph is honestly weak

To balance the section above.

1. **One-repo-at-a-time.** Polyrepo orgs need cross-repo edges and we don't do that yet (and it's a real engineering project to do well).
2. **Adapter coverage is finite.** We ship adapters for the popular frameworks. If your stack is Phoenix + Elm + Rails + a homegrown RPC system, you'll be writing adapters yourself.
3. **Language coverage is narrower than Sourcegraph's** because we need a real parser per language, not just a text index.
4. **No fuzzy/semantic search.** "Find the function that does the thing that looks like X" — that's an LLM job. We don't do it.
5. **No CI integration depth beyond GitHub Actions** at launch. GitLab/Bitbucket/Buildkite are roadmap, not present.
6. **The web viewer is functional, not delightful.** Sourcetrail set a high bar. We're below it.

---

## Footnotes

[^st-xlang]: Sourcetrail had bindings for C/C++/Java/Python and could *show* nodes from different languages in the same project, but it didn't draw cross-language *edges* (e.g. a Python ctypes call into a C library wouldn't get a call edge). The forks haven't changed this.

[^cs-xlang]: CodeSee's "code maps" treated a repo as a graph of files and could span languages at the file level, but call/import edges were per-language. Cross-language semantic edges weren't a feature.

[^sg-xlang]: Sourcegraph's precise code intel (SCIP) is per-language. You can search across languages textually, but a "function in TS calls function in Go" edge is not natively drawn unless both sides are indexed and the call site is recognizable to one of the indexers.

[^bl-xlang]: Bloop indexes multiple languages and can answer cross-language questions through the LLM, but it doesn't materialize cross-language edges as a graph artifact you can query.

[^merm-na]: Mermaid is a hand-authored diagram language. Whatever edges you want, you draw. So in one sense Mermaid "supports" everything; in another sense it supports nothing automatically. We've marked these cells n/a.

[^ide-xlang]: VS Code's call hierarchy is driven by the active language server. It's single-language by construction. A polyglot repo gets one hierarchy at a time.

[^sq-xlang]: SonarQube can analyze multiple languages in one project and report issues across them, but its data model is rules-on-files, not a queryable cross-language call graph.

[^cs-xservice]: CodeSee had a "service map" feature that could show service boundaries in microservice repos, but the frontend↔backend route correlation was generally manual or based on naming conventions, not derived from parsing both sides.

[^sg-xservice]: Sourcegraph can find both `fetch('/api/users')` and `app.get('/api/users', …)` via search, and Cody can reason about the relationship in chat, but a typed cross-service edge isn't part of the index.

[^cs-prdiff]: CodeSee did support PR review maps that highlighted changed files in a code map. It was file-granularity, not edge-granularity, and the UX has been folded into GitKraken since acquisition.

[^sg-prdiff]: Sourcegraph Batch Changes and the PR integrations show search-based deltas, but a structural "this PR added these graph edges" view isn't a first-class artifact.

[^sq-prdiff]: SonarQube's PR decoration shows changes in issue counts, coverage, and quality gate status on a PR. It's a quality delta, not a structural-graph delta.

[^cc-prdiff]: CodeClimate similarly shows maintainability/coverage deltas on PRs.

[^st-typed]: Sourcetrail distinguished a few edge kinds (call, inheritance, override, usage). Codegraph's set is broader (HTTP, SQL, event, queue, RPC) because adapters surface those types.

[^sg-typed]: Sourcegraph's SCIP data model has symbol kinds and reference kinds, so in principle edges are typed, but the user-facing experience is mostly "references" and "definitions."

[^ide-typed]: Call hierarchy panels show callers/callees only. They don't distinguish "calls" from "raises" or "awaits."

[^sq-pure]: A handful of SonarQube rules touch on side-effect-free expectations (e.g., "this method should be pure") but it's not a first-class node annotation you can filter the project by.

[^sg-framework]: Sourcegraph's code intel is general; framework-specific routing between frontend and backend is something you'd pattern-match for. Some adapters exist for popular frameworks but it's not the focus.

[^sq-framework]: Sonar has framework-specific rule packs (Spring, Django, etc.) but those rules find bugs/smells; they don't expose framework structure as graph edges.

[^sg-local]: Sourcegraph can be self-hosted, which is "local" at the org level, but it requires running a server (search indexer, frontend, embeddings store, etc.). It is not local in the codegraph sense of "a CLI on a laptop."

[^st-license]: Sourcetrail was GPLv3. Forks inherit that license. MIT (codegraph) is more permissive — relevant if you want to vendor codegraph into a closed-source product.

[^bl-license]: Bloop's repo is Apache 2.0. Practically, the project is unmaintained as of April 2026, so the license is a historical curiosity.

[^ide-license]: VS Code is MIT, but the call-hierarchy feature depends on language servers whose licenses vary widely (many MIT/Apache, some proprietary).

[^sq-license]: SonarQube Community Build is open source (LGPL/GPL depending on the part). The Developer/Enterprise/Data Center editions are proprietary and add the features most teams actually want (branch analysis, more languages, security rules).

[^cs-det]: CodeSee's static-analysis layer was deterministic, but the AI-assisted "explain this code" features the GitKraken acquisition emphasized are LLM-powered and therefore not.

[^sg-det]: Cody is an LLM. Sourcegraph's deterministic search/code intel is still there, but the marquee features in 2026 are the AI ones.

[^cs-free]: CodeSee had a free tier for OSS while standalone; pricing under GitKraken's DevEx bundling has shifted and the free OSS path is no longer the headline.

[^sg-free]: Sourcegraph discontinued Free and Pro tiers. The only plan as of 2026 is Enterprise. Self-hosted deployments commonly start at $50–75k/yr.

[^bl-free]: Bloop's desktop app remains free to download. With the company shut down, that's not going to change — but there's also nobody fixing bugs.

[^sq-free]: SonarQube Community Build is free for any size of codebase but with limited language coverage (~15 languages) and no branch analysis. Enterprise features start at ~$2.5k/yr.

[^cc-free]: CodeClimate Quality has a free tier for OSS only; private repos are paid.

---

## How to read this table if you're choosing

A short decision tree, since people inevitably want one.

- **You have one repo, want PR diffs of structure, run on a laptop, no SaaS:** codegraph.
- **You have hundreds of repos and a real budget:** Sourcegraph.
- **You want an AI pair programmer that knows your code:** Cody (or Cursor/Claude Code/Copilot — outside this table's scope).
- **You want bug/smell detection and a quality gate:** SonarQube.
- **You want to onboard new hires with a guided tour:** the closest live answer in 2026 is GitKraken's DevEx (the CodeSee successor); honest answer is "write a `README` with Mermaid."
- **You want to find a string in your code right now:** GitHub code search.
- **You want to know what calls the function your cursor is on:** the call-hierarchy panel in your IDE.

We genuinely think codegraph is the right answer for the first row and a poor answer for the others. If your situation matches another row, use that tool.

---

## What this comparison doesn't cover

A few things we deliberately didn't compare on, to avoid stacking the deck:

- **Speed on huge monorepos.** We haven't benchmarked codegraph against Sourcegraph on a 10M-LOC repo. Anecdotally codegraph is fine up to a few hundred thousand LOC; beyond that, ymmv.
- **Editor integration.** Sourcegraph has browser extensions and IDE plugins. We have a CLI and a static web viewer. For the "while I'm coding" experience, we lose.
- **Ecosystem of rules and plugins.** SonarQube has thousands of rules contributed over a decade. Our adapter ecosystem starts at zero.
- **Support contracts and SLAs.** All commercial vendors offer these. Codegraph is an OSS project; you get what you get.

If any of those things matter to your team, weight them accordingly.

---

## Sources

Primary sources used to confirm current state of competitors (May 2026):

- CodeSee acquired by GitKraken — see DevOpsdigest and Crunchbase coverage of the May 2024 acquisition.
- Sourcegraph pricing — sourcegraph.com/pricing; Free/Pro tiers retired, Enterprise at ~$59/user/mo, self-hosted ~$50–75k/yr typical entry.
- Bloop shutdown announcement (April 2026) — the parent company cited a missing business model; the Apache 2.0 desktop app remains downloadable but unmaintained.
- Sourcetrail discontinuation — Coati Software blog post (Sep 2021); repo archived Dec 2021. Active forks: NumbatUI (Quarkslab), turbinelu/Sourcetrail-Fork.
- SonarQube editions — sonarsource.com/plans-and-pricing; Community Build free with ~15 languages; Developer ~$2.5k/yr, Enterprise ~$16k/yr, Data Center ~$100k/yr.
- GitHub code search — docs.github.com; private repos are searchable for users with access; included with the free plan.
