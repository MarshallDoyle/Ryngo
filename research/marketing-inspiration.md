# Marketing Inspiration for codegraph

Status: research notes — not finalized copy
Audience: codegraph maintainers (you)
Scope: distill positioning, README structure, and visual identity moves from Unsloth, LiteLLM, Sourcegraph SCIP, Mintlify, Inngest, and Sentry, then translate into 10–15 patterns codegraph should adopt and 5 to avoid.

codegraph is an MIT-licensed, no-LLM, code-as-typed-graph tool with a React Flow viewer and a GitHub Action. The product axis it shares with the studied tools: dev-tool, OSS-first, breadth-of-targets matters, identity hangs on a precise technical claim. The product axis it does not share: no model, no inference, no enterprise gateway, no "agent platform" surface area. That asymmetry shapes which patterns transfer and which do not.

All quotations are short and verbatim, kept under 15 words, with the source URL inline. Numbers and section orders are paraphrased structurally rather than quoted.

---

## Part 1 — Reference points, examined

### 1. Unsloth — `https://unsloth.ai` and `https://github.com/unslothai/unsloth`

**Hero, homepage.** Headline: "Train and Run Models Locally." Subheadline: "Easily run & train models locally." (Source: https://unsloth.ai)

The headline does only one thing: it names the verb (train, run) and the constraint (locally). It does not mention quantization, kernels, accuracy, the founders, or the mascot. The subhead reuses the same words almost verbatim — there is no rhetorical second move.

**Hero, README.** "Unsloth Studio lets you run and train models locally." (Source: https://github.com/unslothai/unsloth) Same shape. The README does not try to be cleverer than the homepage.

**Numbers above the fold.** The homepage stacks these claims in close range:

- "Train your own custom model in 24 hrs, not 30 days"
- "30x faster than FA2 + 30% accuracy"
- "90% less memory usage than FA2"
- "2.5x faster training + 20% less VRAM"

(Source: https://unsloth.ai)

Two things to notice. First, every claim is a *ratio*, not an absolute. Second, the comparator is named (FA2 = FlashAttention-2). They are not saying "fast" — they are saying "fast vs. this specific named alternative." That is much harder to dismiss.

**README structure (TOC, in order).** Features → Quickstart → Free Notebooks table → Install → Advanced Installation → Community → Citation → License → Thank You. (Source: https://github.com/unslothai/unsloth)

The order is significant. Features and Quickstart precede Install. The reader sees what it does and a runnable artifact before being asked to install anything. The "Free Notebooks" section is positioned as a *try-before-install* path: Colab links serve as the real CTA.

**Comparison table style.** The Free Notebooks table has columns: Model | Notebook | Performance | Memory use. (Source: https://github.com/unslothai/unsloth) This is the same table doing two jobs: it is the model-coverage matrix *and* the benchmark table. One row per model, two numbers per row. The benchmarks are not a separate page — they are inline at the level of the thing the user actually cares about ("does it work for the model I run?").

**Breadth handling.** The README shows ~12 representative models in the Free Notebooks table and then links out to a "Model Catalog" page on the docs site for the exhaustive list. (Source: https://github.com/unslothai/unsloth) The README never tries to be comprehensive. The README is a sales doc; the model catalog is a reference doc; they are separated on purpose.

**CTA stack.** Discord, Twitter, Reddit links are early. "Join our Discord," "Start for free," "Learn more" on the site. (Sources: https://github.com/unslothai/unsloth, https://unsloth.ai) The Discord CTA is treated as equal-weight to "Start for free." For a niche dev tool that signals "real humans, real help."

**Visual identity.** Dark background, green/teal accent, sloth mascot, generous whitespace. The mascot is doing real work — it gives the brand a face that would otherwise be impossible to remember (the project's actual differentiator is Triton kernels, which is not a marketable surface).

**Tone.** Technical-first with a playful overlay. "Custom Triton and mathematical kernels" sits next to a sloth illustration. The combination keeps the project from reading as either too academic or too cute.

**What Unsloth does not claim.** It does not claim to be the fastest at everything, the most general, or the standard. It claims: faster training, less memory, no accuracy loss, on the specific model families it supports. The scope-limiting is part of the credibility.

**Anti-pattern they avoid.** No "AI for AI" word salad. No "revolutionary." No vague "10x productivity."

### 2. LiteLLM — `https://litellm.ai`, `https://github.com/BerriAI/litellm`, `https://docs.litellm.ai`

**Hero, homepage.** The page leads with: "AI Gateway to provide model access, fallbacks and spend tracking across 100+ LLMs. All in the OpenAI format." (Source: https://litellm.ai)

That sentence is doing a lot: it names the artifact (gateway), the three primary jobs (access, fallbacks, spend), the breadth (100+), and the integration shape (OpenAI format). For codegraph the parallel is naming the artifact (graph), the primary jobs, the breadth (languages/AST kinds), and the integration shape (React Flow / GitHub Action).

**Hero, README.** Tagline: "Open Source AI Gateway for 100+ LLMs. Self-hosted. Enterprise-ready." (Source: https://github.com/BerriAI/litellm) Note the three constraints stacked: open source / self-hosted / enterprise-ready. Each one disqualifies an objection.

**Badge stack at the top of the README.** PyPI version, GitHub stars, Y Combinator W23, WhatsApp, Discord, Slack, CodSpeed. (Source: https://github.com/BerriAI/litellm) Seven badges. Two of them (Discord, Slack, WhatsApp) are explicit "talk to a human" channels. The Y Combinator badge is a cheap legitimacy signal. CodSpeed is a benchmark signal. The rest are standard.

**Provider matrix.** A real, large table. Columns: Provider | /chat/completions | /messages | /responses | /embeddings | /image/generations | /audio/transcriptions | /audio/speech | /moderations | /batches | /rerank. ~90 rows. Checkmarks per cell. (Source: https://github.com/BerriAI/litellm)

This is the load-bearing piece. The "100+ LLMs" claim would be deflatable on its own; the matrix makes it un-deflatable. A reader scrolls the table, finds their provider, finds their endpoint, sees a checkmark — done. The matrix is the artifact that converts a marketing claim into a verifiable one.

**README section order.** Hero → What is LiteLLM → Why LiteLLM → OSS Adopters (logos) → Features → Supported Providers matrix → Get Started → Developer Mode → Docker signatures → Enterprise → Contributing → Support → Contributors. (Source: https://github.com/BerriAI/litellm)

Notice "OSS Adopters" — the customer-logo strip — appears *before* features. Social proof leads features. This is the LinkedIn move applied to a README.

**OSS adopter logos.** Stripe, Google ADK, Greptile, OpenHands, Netflix, OpenAI Agents SDK. (Source: https://github.com/BerriAI/litellm) Half are companies, half are other open-source projects. The mix is deliberate: it says "production at Netflix" and "core dependency for OpenAI Agents SDK" in the same row. Adoption is shown at two altitudes.

**Single benchmark.** "8ms P95 latency at 1k RPS." (Source: https://github.com/BerriAI/litellm) One concrete latency number. They do not flood the reader with 12 charts; they pick one to prove the gateway is not adding meaningful overhead.

**Docs site doubles as marketing.** Top nav: Docs / Learn / Integrations / Enterprise / Changelog / Blog. (Source: https://docs.litellm.ai) "Integrations" is a top-level nav item alongside "Docs," not buried inside it. The integrations page is itself a marketing surface — every provider page is an SEO-targeted landing page.

**Tone.** Pragmatic-developer. Low warmth, low irreverence. The sentence "Without LiteLLM this would be hours of work each time a new model is announced" is a representative shape: it names the pain in concrete time units. (Source: https://litellm.ai)

**Open core split.** OSS tier emphasizes breadth and self-hosting. Enterprise tier emphasizes SSO, audit logs, SLAs. The split is clean — there is no feature-shaming where the OSS version is crippled.

**Anti-patterns LiteLLM avoids.** No "AI-native" language. No unbounded claims. The gateway is positioned as plumbing, not as intelligence.

### 3. Sourcegraph SCIP — `https://github.com/sourcegraph/scip`

This is the most directly adjacent reference for codegraph: it is a code-graph format with language indexers, MIT-licensed, sold as a standard.

**Hero.** "SCIP Code Intelligence Protocol" with tagline "language-agnostic protocol for indexing source code, which can be used to power code navigation functionality such as Go to definition, Find references, and Find implementations." (Source: https://github.com/sourcegraph/scip)

That tagline does two interesting things. First, it lists the *capabilities the format enables*, not the format itself: go-to-def, find-refs, find-implementations. Second, it sidesteps comparison entirely — there is no mention of LSIF.

**Section order.** Hero → Repository contents → Tools using SCIP → CLI installation → Contributing → License. (Source: https://github.com/sourcegraph/scip) The "Tools using SCIP" section appears *before* the install section. The argument is: this format already powers tools you might recognize; here is a list; now go install the CLI.

**Language indexers.** A simple bulleted list with language names linking to per-language indexer repos: Java, TypeScript, Rust, C++, Ruby, Python, C#, Dart, PHP. (Source: https://github.com/sourcegraph/scip) No status matrix. No coverage percentage. No checkmarks. This is the opposite move from LiteLLM, and it works less well — the reader cannot tell at a glance whether the Rust indexer is at parity with the TypeScript one.

**No comparison table vs LSIF.** They could have made one. They chose not to. The cost: a reader who arrives knowing about LSIF has to figure out the comparison from external blog posts. The benefit: the README does not look defensive.

**Tone.** Reserved, protocol-style. "We welcome questions, suggestions, and feedback" is the warmest sentence in the doc. (Source: https://github.com/sourcegraph/scip)

**Lesson for codegraph.** SCIP is the closest neighbor and the most under-marketed of the references. Codegraph can take SCIP's posture (language-agnostic, capability-led tagline, real adopter list) and add the things SCIP omits (a coverage matrix, a benchmark, a visual hero).

### 4. Mintlify — `https://mintlify.com`

Less directly applicable but useful for visual-identity and CTA-stack reference, since Mintlify is in the dev-tool docs space.

**Hero.** "The Intelligent Knowledge Platform" with subhead "Helping teams create and maintain world-class documentation built for both humans and AI." (Source: https://mintlify.com)

This is the opposite end of the precision spectrum from Unsloth. It is positioning, not naming. For codegraph this is *not* the move — codegraph's value is concrete, not categorical.

**Customer logos.** Anthropic, Coinbase, HubSpot, Zapier, AT&T as the top row; Perplexity, X, Kalshi, Cognition, Together AI, Laravel, Replit, Lovable, Vercel, Fidelity, Anaconda, Loops as the second tier. (Source: https://mintlify.com) Two-tier logo strip is now the standard SaaS move.

**Stat.** "2M+ Monthly active developers." (Source: https://mintlify.com) One headline number, large.

**Lesson for codegraph.** When you have logos, use a two-tier strip. When you do not, do not fake it.

### 5. Inngest — `https://www.inngest.com`, `https://github.com/inngest/inngest`

Useful because Inngest is OSS-first, dev-tool, and leans hard on a code-snippet hero.

**Hero, homepage.** "Make any code durable by default." (Source: https://www.inngest.com) Six words. Verb-first. No noun-stack of buzzwords.

**Subhead.** "Workflows, agents, endpoints, background jobs—however it's written, wherever it runs—Inngest makes it unbreakable." (Source: https://www.inngest.com) The subhead does the breadth work that the headline refuses to do.

**README leads with code.** A real `step.run` example appears immediately after the tagline, before any feature list. (Source: https://github.com/inngest/inngest) The argument: here is what it looks like to use this; if you like the shape, keep reading.

**CTAs.** "Start building for free" and "I'd rather look at the docs first." (Source: https://www.inngest.com) That second CTA is unusual and worth stealing — it acknowledges that some readers do not want to sign up before reading.

**Tone.** "Skip boilerplate code," "without grepping logs." (Source: https://www.inngest.com) Pain-language tied to specific developer experiences. Not "increase productivity" — "stop grepping logs."

### 6. Sentry — `https://github.com/getsentry/sentry`

Quick scan for visual hierarchy.

**Tagline.** "Code breaks, fix it faster." (Source: https://github.com/getsentry/sentry) Five words. Mirror structure: problem, then promise.

**Screenshot-first.** README leads with multiple annotated UI screenshots. (Source: https://github.com/getsentry/sentry) The website carries the marketing; the README acts as a wayfinder.

**Lesson.** When the product has UI, show it early. When the product is invisible (a protocol, a CLI), this move does not transfer.

---

## Part 2 — 15 patterns codegraph should adopt

Each pattern: name → what to do → why it works → who exemplifies → application to codegraph.

### Pattern 1: Verb-first, constraint-loaded one-liner

**What.** Lead with a sentence that names the verb (what the tool *does*) and one constraint (what makes it different). Avoid noun stacks like "AI-native graph intelligence platform."

**Why.** Verbs are testable; nouns are not. A reader can confirm or deny "trains models locally" within ten seconds. They cannot do that with "intelligent platform."

**Who.** Unsloth: "Train and Run Models Locally" (https://unsloth.ai). Inngest: "Make any code durable by default" (https://www.inngest.com).

**Codegraph application.** Try shapes like "Index any codebase as a typed graph" or "See your code as a graph, locally." The verb is "index" or "see"; the constraint is "typed" and "locally." Avoid: "code intelligence platform," "AI-powered graph," "next-generation static analysis."

### Pattern 2: Ratio-first benchmarks against a named comparator

**What.** Every quantitative claim should be a ratio, and the comparator should be named in the same sentence.

**Why.** "Fast" is dismissable. "30x faster than FA2" is not — the reader either knows FA2 (and either agrees or argues) or learns about FA2. Either outcome is a win.

**Who.** Unsloth: "30x faster than FA2 + 30% accuracy" (https://unsloth.ai).

**Codegraph application.** If the indexer is faster than `tree-sitter` raw or `scip-typescript`, say so by name with the ratio. If memory footprint is smaller than the SCIP index for the same repo, name SCIP. If the GitHub Action runs in less time than CodeQL on the same fixture, name CodeQL. Avoid unbounded "lightning fast." Pick one or two named comparators and live with the comparison.

### Pattern 3: One table that does double duty (coverage + benchmark)

**What.** Build a single table where rows are the things the user cares about (languages, in codegraph's case) and columns include both *support* and *performance*.

**Why.** A reader scanning for "does it support my language" and a reader scanning for "is it fast" are the same scroll. Combining the tables collapses two cognitive steps into one.

**Who.** Unsloth's Free Notebooks table: Model | Notebook | Performance | Memory use (https://github.com/unslothai/unsloth).

**Codegraph application.** Columns: Language | Parser | Symbols extracted | Index time per kLOC | Status. Rows: TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, C#, etc. Status column uses something more honest than checkmarks — "stable," "beta," "experimental," "planned." If a row is "planned," put it on the table anyway; the gap is itself the roadmap.

### Pattern 4: Provider/integration matrix as the load-bearing artifact

**What.** Build a wide matrix where rows are integrations and columns are capabilities, populated with checkmarks. Make it large enough that scrolling it *is* the proof.

**Why.** Breadth claims need infrastructure. "100+ LLMs" only works because the table has ~90 rows you can verify by eye.

**Who.** LiteLLM: 90+ rows × 10 endpoint columns (https://github.com/BerriAI/litellm).

**Codegraph application.** A capability matrix: Language × {Imports, Exports, Calls, Class hierarchy, Types, Generics, Macros, Conditional compilation}. This matrix replaces a marketing claim ("full graph extraction") with a verifiable map ("here is exactly what we extract per language, and here is where the holes are"). The honest holes are themselves credibility.

### Pattern 5: README section order — Features → Quickstart → Install (not Install → Features)

**What.** Put what-it-is and a runnable artifact above the install instructions.

**Why.** A reader who has not yet decided to install should not be looking at install commands. Notebook links and code snippets give them something to evaluate first.

**Who.** Unsloth: Features → Quickstart → Notebooks → Install (https://github.com/unslothai/unsloth). Inngest: code snippet immediately after tagline (https://github.com/inngest/inngest).

**Codegraph application.** Order:
1. Hero + tagline + badges
2. Animated GIF of the React Flow viewer on a real OSS repo
3. "Try it on your repo in 60 seconds" — a single one-liner (`npx codegraph` or similar) that opens a viewer
4. Capability matrix
5. GitHub Action snippet
6. Install
7. Architecture
8. Comparison to SCIP/CodeQL/tree-sitter
9. Contributing, License, Citation

### Pattern 6: Demo before install

**What.** Provide a zero-install path the reader can hit before they commit to a local install. Colab notebook, hosted playground, a `npx` one-liner that streams a viewer.

**Why.** The local install is the highest-friction step in the funnel. Anything that lets the reader see the output before that step compounds.

**Who.** Unsloth's Free Notebooks (Colab links serve as the real first CTA, https://github.com/unslothai/unsloth).

**Codegraph application.** Host a public viewer at e.g. `view.codegraph.dev/<github-repo>` that takes a URL and renders the React Flow graph. The README's hero CTA becomes "View any GitHub repo as a graph" → field for repo URL → done. This is the demo equivalent of a Colab notebook.

### Pattern 7: Talk-to-a-human badges treated as equal-weight

**What.** Discord/Slack/Twitter badges placed in the top badge row, alongside CI/PyPI/license badges.

**Why.** OSS dev tools live or die on community responsiveness. A Discord badge in the top row signals "you can get help fast." For a small project with no name recognition, this is more credible than a stars count.

**Who.** LiteLLM: Discord, Slack, WhatsApp all in the top badge stack (https://github.com/BerriAI/litellm).

**Codegraph application.** Top badge row: npm version | CI status | License (MIT) | Discord | GitHub Discussions | Twitter. Discord goes before stars. Do not pad the row with low-signal badges (downloads count by week, code-of-conduct, etc.) — those go in a contributing-section row if anywhere.

### Pattern 8: Adopter logo strip *before* features, mixing companies and OSS projects

**What.** Show who uses the tool above the features section, and mix corporate logos with OSS project logos.

**Why.** A row that has both Netflix and "OpenAI Agents SDK" says "production scale" and "ecosystem trust" simultaneously. Either alone is weaker.

**Who.** LiteLLM OSS Adopters: Stripe, Google ADK, Greptile, OpenHands, Netflix, OpenAI Agents SDK (https://github.com/BerriAI/litellm).

**Codegraph application.** Until codegraph has adopters, do *not* fake this. The pattern is to leave a labeled empty space — "Used in production by:" — and fill it as it grows. In the meantime, replace the slot with a "Tools using codegraph" / "Built on codegraph" list (the SCIP move: https://github.com/sourcegraph/scip), which is honest at any stage.

### Pattern 9: One headline benchmark, not twelve

**What.** Pick a single benchmark number that proves the most-deflatable claim, and put it on the homepage.

**Why.** Benchmark walls produce skepticism; one well-chosen number produces confidence. The number must be falsifiable (the reader can rerun it).

**Who.** LiteLLM: "8ms P95 latency at 1k RPS" (https://github.com/BerriAI/litellm).

**Codegraph application.** A number like "Indexes the React monorepo in 4.2s" or "Builds a 50k-node graph for the Linux kernel in 90s." Pick one canonical OSS repo; pin the benchmark to a fixture in the repo so anyone can rerun it. The number is more useful than a chart.

### Pattern 10: Capability-led tagline, not feature-led

**What.** The tagline names the capabilities the tool *enables downstream*, not the implementation.

**Why.** Readers care about what they can build, not your data structure.

**Who.** SCIP: "language-agnostic protocol for indexing source code, which can be used to power code navigation functionality such as Go to definition, Find references, and Find implementations." (https://github.com/sourcegraph/scip)

**Codegraph application.** A tagline shape: "A typed graph of your code — for navigation, refactor planning, dependency analysis, and code review." The capabilities (navigate, refactor, analyze, review) come *after* the noun (typed graph), and that ordering inverts the usual feature-first instinct.

### Pattern 11: A second CTA for skeptics

**What.** Next to the "Get started" button, put a CTA aimed at the reader who does not want to sign up yet.

**Why.** Some readers convert through docs, not signup. Forcing them through signup loses them.

**Who.** Inngest: "I'd rather look at the docs first." (https://www.inngest.com)

**Codegraph application.** Hero CTAs: [Try the viewer] [Read the docs] [Star on GitHub]. Three CTAs, three reader types (curious / cautious / endorser), and none of them require signup because codegraph is OSS-first with no signup gate.

### Pattern 12: Mascot or visual anchor for memorability when the differentiator is invisible

**What.** When the technical differentiator is hard to see (kernels, formats, parsing), give the project a visual anchor — a mascot, a distinctive color, a recognizable hero illustration.

**Why.** "Custom Triton kernels" is unmemorable. A sloth is memorable. Once the sloth is memorable, the kernels stick to it.

**Who.** Unsloth's sloth + green/teal palette (https://unsloth.ai).

**Codegraph application.** The React Flow graph itself is the visual anchor — codegraph's product *is* a picture. The hero should be a screenshot or a short animated GIF of a real OSS repo rendered as a graph, with nodes color-coded by symbol kind. That graph image becomes the recognition surface, the way the sloth does for Unsloth. Skip a mascot; the graph does the work.

### Pattern 13: Docs-as-marketing-surface with "Integrations" at top nav

**What.** The docs site treats integration pages as SEO/landing pages. "Integrations" appears at top-level nav, not buried under "Reference."

**Why.** A reader searching "codegraph TypeScript" should land on a per-language page that is both reference and pitch.

**Who.** LiteLLM docs: Docs / Learn / Integrations / Enterprise / Changelog / Blog (https://docs.litellm.ai).

**Codegraph application.** Docs nav: Get Started / Languages / GitHub Action / Viewer / API / Changelog. "Languages" at top level: each language gets its own page (`/docs/languages/typescript`) that includes capability list, a code sample, and a sample graph. These pages become organic-search entry points.

### Pattern 14: Three-bullet OSS/Self-hosted/Standard positioning under the hero

**What.** Immediately under the hero, three short pills or bullets that disqualify the three biggest objections at once.

**Why.** A reader who is going to bounce on "is this open source?" or "do I have to send my code somewhere?" should have those answers before they scroll.

**Who.** LiteLLM: "Open Source" / "Self-hosted" / "Enterprise-ready" stacked in the tagline (https://github.com/BerriAI/litellm).

**Codegraph application.** Under the hero: "MIT licensed" · "No LLM, no cloud" · "Runs in CI." These three bullets answer license, privacy, and integration concerns in one row.

### Pattern 15: Citation block, prominent license, and a "Tools using codegraph" section

**What.** Provide a BibTeX-style citation block, a clear license line near the top, and a section listing tools/projects built on top of codegraph (even if it starts at one entry).

**Why.** The citation block makes academic and research adoption easy. The license-near-top kills the "is it really MIT?" question. The "tools using" section is the honest version of an adopters strip when you do not yet have logos.

**Who.** Unsloth has a Citation section near the bottom (https://github.com/unslothai/unsloth). SCIP has a "Tools using SCIP" section before install (https://github.com/sourcegraph/scip).

**Codegraph application.** Add a Citation section with a stable BibTeX entry (Zenodo DOI is cheap to obtain). License pill in the badge row. A "Built on codegraph" section that starts as just the React Flow viewer and the GitHub Action and grows from there.

---

## Part 3 — 5 anti-patterns to avoid

### Anti-pattern 1: Categorical positioning ("The intelligent X platform")

**Where it shows up.** Mintlify's "The Intelligent Knowledge Platform" (https://mintlify.com) works for them because they have 2M+ MAU and a known product category. For a new OSS project, it reads as empty.

**Why avoid.** Categorical claims are unfalsifiable, and unfalsifiable claims read as marketing for sophisticated dev-tool buyers.

**Codegraph fix.** Stay verb-first. "Index any codebase as a typed graph" beats "The intelligent code understanding platform" by a wide margin.

### Anti-pattern 2: Unbounded comparatives ("blazingly fast," "10x productivity")

**Where it shows up.** Common across less serious dev-tool README templates. None of the studied references do this — Unsloth, LiteLLM, and Inngest all use either named comparators or specific numbers.

**Why avoid.** Sophisticated readers parse "blazingly fast" as "we did not run benchmarks."

**Codegraph fix.** Replace every such phrase with a number tied to a fixture. If you cannot generate a number, drop the claim.

### Anti-pattern 3: Comprehensive support claim with no matrix

**Where it shows up.** "Supports all major languages" — implied by SCIP's bulleted indexer list (https://github.com/sourcegraph/scip), where the reader cannot see status differences between Java and PHP.

**Why avoid.** Without a matrix, the breadth claim is just a claim. With a matrix, gaps become roadmap, which is more credible than fake completeness.

**Codegraph fix.** Always ship the capability matrix from Pattern 4 with honest status labels. A row marked "experimental" is more credible than no matrix.

### Anti-pattern 4: Faking adopters / two-tier logo strips before you have them

**Where it shows up.** Many early-stage OSS projects copy the SaaS logo strip with just the founders' previous employers or with public-domain logos.

**Why avoid.** Sophisticated readers can smell this. It poisons the rest of the page.

**Codegraph fix.** Until adopters exist, use SCIP's move (https://github.com/sourcegraph/scip): a "Tools using codegraph" section listing real downstream projects, however few. When adopters exist, switch to the LiteLLM-style logo strip.

### Anti-pattern 5: README that is purely a wayfinder to a marketing site

**Where it shows up.** Sentry's README (https://github.com/getsentry/sentry) is mostly screenshots and links to sentry.io. This works because Sentry has the brand and traffic. For a new OSS project, the README *is* the marketing site.

**Why avoid.** Most discovery for a new tool happens on GitHub via search, HN, or a blog link. If the README is a stub, the project loses the conversion that was already in front of it.

**Codegraph fix.** Treat the README as the primary marketing surface. The website (when it exists) can be a thinner version that links back. Until codegraph has 5k+ stars, the README does the heavy lifting.

---

## Part 4 — Concrete next-action checklist for codegraph

Numbered so they can be checked off, ordered roughly by leverage.

1. Write the verb-first one-liner. Try three shapes; pick the shortest one that survives "what does this actually do." (Pattern 1, 10)
2. Decide on one named comparator for benchmarks (likely SCIP or `tree-sitter` raw) and produce one ratio claim. (Pattern 2, 9)
3. Build the language × capability matrix with honest status labels. Ship the holes as the roadmap. (Pattern 3, 4, Anti-pattern 3)
4. Record a 6-second GIF of the React Flow viewer on a real OSS repo (React, vscode, or similar). Place it as the README hero image. (Pattern 12)
5. Stand up a hosted viewer at a stable URL so the README's first CTA is "view your repo." (Pattern 6)
6. Lay out the README in this order: hero → GIF → 60-second try → matrix → Action snippet → install → architecture → comparison → contributing → citation → license. (Pattern 5)
7. Pick three top-row badges that aren't filler: license, CI, Discord. Cut anything that doesn't carry signal. (Pattern 7)
8. Write the three-pill positioning: MIT licensed · No LLM, no cloud · Runs in CI. (Pattern 14)
9. Two CTAs in the hero: [View a repo] and [Read the docs]. No signup. (Pattern 11)
10. Stand up a "Built on codegraph" section, even if it has one entry. (Pattern 8, 15)
11. Add a Citation section with a Zenodo DOI. (Pattern 15)
12. On the docs site, put "Languages" at top-level nav. Generate one page per language with a sample graph. (Pattern 13)
13. Pick the canonical benchmark fixture (one OSS repo) and pin it. The single number on the homepage should be reproducible from that fixture. (Pattern 9)
14. Audit every adjective in the README. Replace any unbounded comparative with a number or delete it. (Anti-pattern 2)
15. Write the README explicitly as marketing copy, not as a wayfinder to a future website. (Anti-pattern 5)

---

## Part 5 — Source list

All sources studied, for re-reference:

- Unsloth homepage: https://unsloth.ai
- Unsloth GitHub README: https://github.com/unslothai/unsloth
- LiteLLM homepage: https://litellm.ai
- LiteLLM GitHub README: https://github.com/BerriAI/litellm
- LiteLLM docs site: https://docs.litellm.ai
- Sourcegraph SCIP: https://github.com/sourcegraph/scip
- Mintlify homepage: https://mintlify.com
- Inngest homepage: https://www.inngest.com
- Inngest GitHub README: https://github.com/inngest/inngest
- Sentry GitHub README: https://github.com/getsentry/sentry

---

## Part 6 — A few cross-cutting observations

**The strongest dev-tool README pages all converge on the same shape.** Verb-first hero, one or two specific numbers, a wide capability matrix, an early try-before-install path, talk-to-a-human channels in the top row, and a real adopter list. The differences between Unsloth and LiteLLM are surface (mascot vs no mascot, dark vs light) — the underlying composition is similar.

**The single strongest move is the matrix.** Unsloth has it (models × performance), LiteLLM has it (providers × endpoints). SCIP does not, and SCIP's README reads weaker for it. For codegraph specifically, the language × capability matrix is the highest-leverage artifact to build. It gives breadth and honesty in the same scroll.

**The single biggest tonal trap is mid-warmth corporate voice.** Unsloth is technical-with-mascot. LiteLLM is dry-pragmatic. Inngest is pain-language-direct. Sentry is technical-terse. None of them are "hey friend, let's make documentation magical." Avoid the mid-warmth register; pick a corner.

**For codegraph the most natural register is dry-technical with one visual flourish.** The flourish is the React Flow graph itself. The voice should sit between LiteLLM and SCIP. Do not try to be Unsloth-funny; the project does not need a mascot when the product is already a picture.

**One lesson from the absence of comparison tables in Unsloth, LiteLLM, and SCIP.** None of the three has a side-by-side feature comparison vs. a named competitor (Unsloth vs. PEFT, LiteLLM vs. OpenRouter, SCIP vs. LSIF). This is interesting. It suggests that mature OSS dev-tool marketing prefers *implicit* comparison (named ratios, capability matrix) over *explicit* comparison (vs.-table). Codegraph should follow that instinct: a capability matrix is more durable than a "codegraph vs. SCIP" table that will need maintenance.

---

## Part 7 — Deeper notes per reference

The earlier per-reference write-ups were tight summaries. This section adds the texture: where each reference makes its key choices, where the choices succeed, and where they leave value on the table. The goal is to make codegraph's adoption choices easier by understanding *why* a pattern works in its native context.

### 7.1 Unsloth — additional notes

**The composition trick.** Unsloth's "Free Notebooks" table is doing a job most projects spread across three places: it is a capability list (which models work), a benchmark (how fast / how much memory), and a try-before-install path (each row is a Colab link). This is a *table-as-funnel*: the reader scrolls, finds their model, clicks the row, and is in a working notebook within seconds. Three jobs collapsed into one artifact is the highest-leverage move in the entire reference set.

**The breadth-meets-honesty pattern.** The README claims "500+ models" but the table only shows ~12. The remaining 488 are linked behind a "Model Catalog" page on the docs site. This split is structural, not lazy — it admits that 500 rows would make the README unreadable, but does not give up the 500-model claim. The pattern: claim the breadth, demonstrate a representative subset, link to the comprehensive catalog. (Source: https://github.com/unslothai/unsloth)

**The ratio-against-FA2 ladder.** The four headline numbers — "30x faster than FA2 + 30% accuracy," "90% less memory usage than FA2," "2.5x faster training + 20% less VRAM," "32x number of GPUs faster than FA2" (https://unsloth.ai) — ladder up across tiers (free / pro / enterprise). Each tier gets its own ratio, and each ratio names FA2 as the comparator. This means a reader walking down the pricing column never sees a different metric system; the comparator is constant, only the magnitude changes.

**The mascot is doing differentiator-translation.** Unsloth's actual moat — Triton kernel rewrites, math-level optimizations — is invisible to almost everyone who reads the page. The sloth converts the invisible moat into a recognizable surface. The lesson is not "use a mascot"; it is "if your moat is invisible, find a visible anchor." For codegraph the React Flow graph image *is* that anchor; a mascot would be redundant.

**Where Unsloth leaves value on the table.** No comparison table vs. PEFT, vLLM-LoRA, axolotl, or other contenders. A reader who already knows those names has to assemble the comparison externally. Unsloth gets away with this because the named-ratio claims are so strong they substitute. Codegraph should not try this without the same caliber of named-ratio claims.

### 7.2 LiteLLM — additional notes

**The provider matrix is the product, in marketing form.** LiteLLM's value proposition collapses to: "you write OpenAI-format calls; we route them anywhere." That value proposition is only credible to the extent the routing actually works for everywhere. The matrix — 90+ rows × 10 columns of checkmarks — is the product diagram and the marketing diagram simultaneously. (Source: https://github.com/BerriAI/litellm)

**The opening tagline is a four-clause sentence.** "Open Source AI Gateway for 100+ LLMs. Self-hosted. Enterprise-ready. Call any LLM in OpenAI format." (https://github.com/BerriAI/litellm) Four clauses, each disqualifying one objection: license worry, scale worry, governance worry, integration cost worry. Note that the first clause is the only one with a number; the rest are qualitative.

**OSS Adopters before Features.** This is the most striking section-order choice in the studied set. Most READMEs put adopters at the bottom or in a sidebar. LiteLLM puts them between the tagline and the feature list. The implicit argument: "before we tell you what it does, here is who already trusts it does it." For a project with logos like Stripe and Netflix (https://github.com/BerriAI/litellm), this works; for a project without those logos, it cannot work and shouldn't be faked.

**The single benchmark is load-bearing.** "8ms P95 latency at 1k RPS" (https://github.com/BerriAI/litellm) does the entire work of refuting "but a gateway must add latency." If LiteLLM had instead listed eight benchmarks across eight scenarios, the reader's takeaway would have been "look at all this benchmark theater." One number, with a link to reproduce, is more credible than eight numbers without.

**Y Combinator W23 badge.** Worth noting because most OSS-purist dev tools don't show YC badges in READMEs. LiteLLM's choice to include it is a concession to enterprise readers — it's a legitimacy badge for the buyer who needs to justify the procurement, not the engineer who needs to evaluate the code. (Source: https://github.com/BerriAI/litellm) For codegraph, an MIT OSS project without VC, the equivalent is something like a citation DOI or a published paper reference — same legitimacy job, different audience.

**Docs as marketing surface.** Top nav: Docs / Learn / Integrations / Enterprise / Changelog / Blog (https://docs.litellm.ai). Five of the six items are content, and four of them (Learn, Integrations, Enterprise, Blog) are openly marketing-flavored. The Integrations page in particular is structured so that each provider gets a discoverable URL — that is SEO architecture as much as it is documentation architecture.

### 7.3 SCIP — additional notes

**The closest neighbor and the under-marketed cautionary tale.** SCIP is structurally the most similar reference to codegraph: protocol-level, language-agnostic, MIT, no LLM, used to power code navigation. (https://github.com/sourcegraph/scip) Its README is also the weakest of the studied set in terms of conversion. That gap is informative.

**What SCIP does well.** The capability-led tagline — naming go-to-def, find-refs, find-implementations — is a textbook example of describing what the format *enables* downstream. (https://github.com/sourcegraph/scip) That framing should be borrowed directly. The "Tools using SCIP" section before install is the right ordering. The hero/install/contributing skeleton is clean.

**What SCIP under-delivers.** No matrix. The bulleted indexer list (Java, TypeScript, Rust, C++, Ruby, Python, C#, Dart, PHP — https://github.com/sourcegraph/scip) gives no signal about which indexers are at parity and which are partial. A reader cannot tell whether choosing SCIP for a Rust codebase is a safe bet without leaving the page. A status matrix would solve this entirely.

**No benchmark.** SCIP makes no quantitative claim. There is no "indexes the Linux kernel in N minutes" or "produces a P99 query latency of X for go-to-def." Without a number, the reader has to take performance on faith or rerun benchmarks themselves. A single load-bearing number — borrowed from the LiteLLM playbook — would change the credibility profile.

**No social proof at the top.** The "Tools using SCIP" list is real social proof but it is not styled as proof. A logo strip — Sourcegraph, Cody, any tool that consumes SCIP indexes — placed near the top would compound the credibility.

**Lesson for codegraph.** Take SCIP's bones (capability-led tagline, "tools using" before install, MIT-license clarity) and add what SCIP omits (capability matrix with status, one named-ratio benchmark, top-row Discord badge, hero GIF of the viewer). Codegraph can be the SCIP-shaped page that does the conversion work SCIP doesn't.

### 7.4 Mintlify — additional notes

**Useful as a *negative* reference for codegraph's stage.** Mintlify's "The Intelligent Knowledge Platform" hero (https://mintlify.com) is a categorical claim that works only because the project has the traffic to back it up: 2M+ MAU, an Anthropic / Coinbase / HubSpot logo strip, a second tier of customer stories. (https://mintlify.com)

**The two-tier logo strip pattern.** Top row: 5 large logos. Second tier: ~12 customer stories. (https://mintlify.com) This is a SaaS-marketing standard worth understanding even if codegraph cannot use it yet. The structure: row 1 is recognition (you know these names), row 2 is depth (real product stories from a more diverse set). Codegraph should plan the structure now and fill it as adopters appear.

**The "Built for both humans and AI" subhead.** (https://mintlify.com) This is interesting because it positions docs as serving two audiences — readers and LLMs — without overclaiming AI features. Codegraph could borrow the dual-audience framing for graphs: "A typed code graph for developers and for tooling." The two-audience framing is a way to expand the addressable use cases without any product change.

**Where Mintlify leaves value on the table for our purposes.** The hero is forgettable on its own — there are dozens of "Intelligent Platform" pages on the internet. It works because of what surrounds it. If codegraph adopted the same hero shape without the surrounding traffic, it would be a hollow page.

### 7.5 Inngest — additional notes

**Hero shape: action verb + universal scope.** "Make any code durable by default." (https://www.inngest.com) Six words. Verb is "make." Scope is "any code." Outcome is "durable." Default position is "by default" — meaning no extra effort. This is one of the cleaner dev-tool taglines in the set, and worth dissecting:

- *Make* (verb, not a noun like "platform")
- *any code* (universal scope, but bounded by "code" — not "any system")
- *durable* (single capability)
- *by default* (zero-config positioning)

Codegraph could borrow the structural shape: "*Verb* *any codebase* *as a graph*."

**Subhead does the breadth work.** "Workflows, agents, endpoints, background jobs—however it's written, wherever it runs—Inngest makes it unbreakable." (https://www.inngest.com) The headline refuses to enumerate; the subhead enumerates. This division of labor lets the headline stay short without giving up coverage claims. Codegraph could mirror: short headline, comma-list subhead naming the graph use cases (navigation, refactor planning, dependency analysis, code review, AI-tool input).

**Pain-language CTA pair.** "Skip boilerplate code" and "without grepping logs." (https://www.inngest.com) These are not features; they are *removed* tasks. The reader is being promised a reduction in their existing workload. This is a more credible value claim than "increases productivity by 10x." For codegraph the equivalents: "Stop reading import graphs by hand," "Stop building one-off `grep | sort | uniq` pipelines for refactors."

**The "I'd rather look at the docs first" CTA.** (https://www.inngest.com) Worth highlighting again because it is the single most generous CTA pattern in the studied set. It explicitly accommodates the reader who isn't ready to convert. For an OSS project with no signup, codegraph's analog is "[View an example graph]" — a CTA that costs nothing and explains everything.

**README leads with code.** (https://github.com/inngest/inngest) The first non-tagline element after the hero is a real, copy-pasteable code example. The reader sees the API shape — `step.run`, error handling, concurrency — before any feature list. For codegraph the equivalent is showing the GitHub Action YAML or a `npx codegraph index .` command up top.

### 7.6 Sentry — additional notes

**Marketing offload.** Sentry's README does not try to convert anyone. (https://github.com/getsentry/sentry) It assumes the reader arrived already convinced and just wants the technical pointers. This works because Sentry has the brand and traffic to support it. For codegraph, this assumption fails — the reader on the GitHub README is the reader you have, and they are not pre-convinced.

**Screenshot density as identity.** Sentry's README is screenshot-heavy because Sentry is a UI product. Annotated screenshots of issue details, traces, replays, etc., do the talking. (https://github.com/getsentry/sentry) Codegraph is also a UI product (the React Flow viewer), so the screenshot-density move transfers — but as one anchor GIF, not as a wall of stills.

**Tagline pair.** "Code breaks, fix it faster." and "Users and logs provide clues. Sentry provides answers." (https://github.com/getsentry/sentry) Both follow a problem→promise structure. The second one names competitors (logs) and slots Sentry as the next layer up. This is a pattern codegraph could borrow: name what readers already use (`grep`, `tree-sitter` directly, hand-drawn diagrams) and position the tool as the next layer.

---

## Part 8 — A second-pass distillation: the three universal moves

Reading across all six references, three structural moves recur and seem to be the load-bearing ones for OSS dev-tool marketing. Every other pattern in Part 2 is either an instance of these three or a refinement of them.

**Universal move A — Concrete first sentence.** Every successful hero in the set starts with a verb and ends with a constraint, with no buzzword nouns in between. Unsloth: "Train and Run Models Locally." Inngest: "Make any code durable by default." LiteLLM: "AI Gateway to provide model access...across 100+ LLMs." Even SCIP, whose hero is the most academic, leads with the verb "indexing source code." (Sources cited above.)

The failure mode is the noun-stack hero: "The Intelligent X Platform for Y." That shape only works at scale (Mintlify). For a new OSS project, the verb-first shape is the only one that survives a five-second skim.

**Universal move B — One artifact that converts a claim into a check.** Unsloth's notebook table converts "we support 500+ models" into a click-to-verify experience. LiteLLM's provider matrix converts "100+ LLMs" into a scrollable proof. Inngest's lead-with-code converts "any code durable" into a copy-pasteable example. (Sources cited above.)

The artifact varies by project shape, but the function is constant: the marketing claim and the verifiable artifact must be on the same page, ideally within the same scroll.

**Universal move C — Real humans, accessibly.** LiteLLM's Discord/Slack/WhatsApp badges in the top row. Unsloth's Discord, Twitter, Reddit links above install. Inngest's "I'd rather look at the docs first" CTA. (Sources cited above.) The variant doesn't matter; the signal does. Sophisticated dev-tool readers know that OSS adoption depends on whether they can get unstuck. A visible, top-placed channel for getting unstuck does heavy work.

For codegraph, the three universal moves translate to:

- A: A verb-first hero, e.g. "Index any codebase as a typed graph."
- B: A capability matrix that lets a reader click into per-language coverage and see exactly what is extracted.
- C: A Discord badge in the top row, plus a "View an example graph" CTA that costs nothing.

If codegraph executes only those three things well, the README will outperform 90% of comparable OSS projects.

---

## Part 9 — Final word on tone

The studied references occupy roughly four tonal positions:

- **Technical-with-mascot** (Unsloth) — works because the mascot offsets dense kernel-talk.
- **Dry-pragmatic** (LiteLLM) — works because the matrix and adopter logos do all the warmth work.
- **Pain-language-direct** (Inngest) — works because the pains named are real for the audience.
- **Academic-reserved** (SCIP, Sentry) — works only when the project already has trust.

The trap in the middle is *mid-warmth corporate*: "We're so excited to share with you our journey toward intelligent code understanding." That register signals neither credibility nor competence. Avoid it.

For codegraph the most natural position is between dry-pragmatic and pain-language-direct. The product is plumbing (graph extraction, GitHub Action) with one visual flourish (the React Flow viewer). The voice should match: concrete, specific, friendly to the reader who already knows what an AST is, without being unwelcoming to the reader who doesn't.

A heuristic for the tone audit: if a sentence in the README could appear unchanged in a corporate SaaS landing page, rewrite it.

---

## Part 10 — Cross-reference comparison table

A quick at-a-glance reference for which projects make which moves, for when you are auditing codegraph's README against the patterns:

| Pattern / Move                            | Unsloth | LiteLLM | SCIP | Mintlify | Inngest | Sentry |
|-------------------------------------------|:-------:|:-------:|:----:|:--------:|:-------:|:------:|
| Verb-first hero                           |   yes   |   yes   | partial |   no   |   yes   | yes    |
| Named comparator in benchmark             |   yes   |   yes   |  no  |   no     |   no    |  no    |
| Single load-bearing benchmark number      |   yes   |   yes   |  no  |   yes (MAU) | no  |  no    |
| Capability/integration matrix             |   yes   |   yes   |  no  |   no     |   no    |  no    |
| Try-before-install path                   |   yes   |   yes   |  no  |   yes    |   yes   |  no    |
| Discord/Slack badge in top row            |   yes   |   yes   |  no  |   no     |   yes   |  no    |
| Adopters/logos before features            |   no    |   yes   |  no  |   yes    |   yes   |  no    |
| Citation block                            |   yes   |   no    |  no  |   no     |   no    |  no    |
| Skeptic-friendly CTA                      |   no    |   no    |  no  |   no     |   yes   |  no    |
| Mascot/visual anchor                      |   yes   |   no    |  no  |   no     |   no    |  no    |
| Code-first README                         |   no    |   yes   |  no  |   no     |   yes   |  no    |
| Screenshot-first README                   |   yes   |   no    |  no  |   no     |   no    |  yes   |
| Docs-as-marketing (Integrations top nav)  |   yes   |   yes   |  no  |   yes    |   yes   |  yes   |
| Comprehensive vs.-table competitor matrix |   no    |   no    |  no  |   no     |   no    |  no    |
| Mid-warmth corporate voice (anti-pattern) |   no    |   no    |  no  |  some    |   no    |  no    |

**Reading the table.** No project hits every row, and the projects that hit the most rows (Unsloth, LiteLLM, Inngest) are also the ones with the strongest momentum among the studied set. SCIP hits the fewest and is the closest neighbor to codegraph — which is a usable signal that codegraph has room to outperform its closest reference simply by adopting more of the pattern set.

The most universal moves (hit by 4+ projects): docs-as-marketing, try-before-install, verb-first hero, top-row community badges. These are the cheap-to-adopt, high-leverage moves; codegraph should hit all four.

The rarest move (hit only by Inngest): the skeptic-friendly CTA. Cheap to add and almost no one is doing it. That is exactly the kind of move that compounds when copied early.

---

## Part 11 — Visual identity translation for codegraph

Two of the six references have distinctive visual identities (Unsloth's dark + green-teal + sloth, Mintlify's gradient-modern). The others lean on standard developer-tool aesthetics: monospace accents, neutral palettes, screenshot-heavy. For codegraph the question is what the visual identity should *do*, not what it should *look like*.

**The job the visual identity must do.** Two jobs, in order of importance:

1. Make the React Flow viewer instantly recognizable as the project's product. The graph image should appear on the README, the docs site, the Twitter card, and any blog post. Repeated exposure to the same hero graph image converts the graph into the project's logo function.
2. Disqualify the "is this AI?" misread. Codegraph's positioning is no-LLM. A visual identity that signals analysis, parsing, structure (rather than glow effects, neural network animations, gradient orbs) tells the reader "this is a deterministic tool, not an LLM wrapper" without spending a sentence on it.

**Concrete suggestions.**

- *Hero image.* A real React Flow render of a recognizable OSS repo (React, vscode, or astro). Nodes color-coded by symbol kind. Static PNG for the README hero; an animated GIF (under 6 seconds, looping) for the website hero. Avoid synthetic / fabricated graphs — use real ones from real fixtures.
- *Palette.* Two-tone with one accent, no gradients. Dark mode by default in screenshots (matches developer tool norms). Accent should be saturated but not neon. Avoid the AI-tool palette (purple-to-blue gradient, glow effects, particle backgrounds) — that visual register signals "LLM wrapper" before any text loads.
- *Typography.* Sans for body, mono for code and node labels. Avoid display fonts. The product is a typed graph — typography should reinforce structure, not personality.
- *Logo.* The graph itself can serve as the logo if a single canonical render is chosen and reused. Alternatively, a glyph that is recognizably a small graph (3–5 nodes, edges visible) at favicon size. Avoid abstract marks that don't read as graphs.
- *No mascot.* Unsloth needs a sloth because Triton kernels have no face. Codegraph's product *is* a face. Adding a mascot dilutes the recognition of the graph image.

**What to avoid in visual identity.**

- Glow-on-dark "AI tool" aesthetic. Specifically: purple/blue gradient backgrounds, particle effects, animated nebulae, "intelligent" sparkle icons. These read as LLM-product even when the copy denies it.
- Neutral corporate gray with stock photography. The fastest way to look forgettable.
- Multi-color gradient logos. Codegraph's identity should be reusable at favicon size in a single color.

---

## Part 12 — Draft README skeleton for codegraph

A structural outline only — not finished copy. Intended to be a starting point for the writing pass, not a template to follow blindly. Each section names what should be in it and why, drawing from the patterns in Part 2.

```
[ Logo: codegraph wordmark + small graph glyph ]

# codegraph

> [verb-first one-liner: e.g. "Index any codebase as a typed graph."]

[badge row: npm version | CI | License (MIT) | Discord | GitHub Discussions]

[hero image / animated GIF: real React Flow render of a recognizable OSS repo,
 nodes color-coded by symbol kind]

[three-pill positioning row]
MIT licensed  ·  No LLM, no cloud  ·  Runs in CI

[two CTAs, no signup]
[ View an example graph ]   [ Read the docs ]

---

## What it does

[3–5 short bullets, each starting with a verb. Capability-led, not feature-led.
 - Navigate any codebase as a typed graph
 - Plan refactors by inspecting reverse dependencies
 - Wire the graph into code review via the GitHub Action
 - Feed the graph into your own tooling via JSON / SCIP-compatible export]

## Try it in 60 seconds

[Single one-liner — npx, no signup, no cloud account.
 Followed by a screenshot of the resulting viewer URL.]

## Languages and capabilities

[Capability matrix.
 Rows: TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, C#, ...
 Columns: Imports | Exports | Calls | Class hierarchy | Types | Generics | Status
 Status labels: stable / beta / experimental / planned. Honest gaps welcome.]

## Performance

[ONE benchmark, named comparator.
 e.g. "Indexes the React monorepo in 4.2s — 3.1x faster than scip-typescript on the same fixture."
 Link to the fixture in /bench so anyone can rerun.]

## GitHub Action

[YAML snippet, copy-paste ready. 8–12 lines max.]

## Install

[Local install. Comes after Try It because we already showed value.]

## Architecture

[Short. Two paragraphs + a small diagram. Names: tree-sitter parsers, the graph
 schema, the React Flow renderer.]

## Compared to SCIP / CodeQL / tree-sitter

[Honest, short. Three paragraphs, not a vs.-table.
 What SCIP gives you that we don't: full enterprise indexer ecosystem.
 What we give you that SCIP doesn't: a viewer, a GitHub Action, a JSON-first schema.
 What CodeQL gives you that we don't: query language, full security analyses.
 What we give you that CodeQL doesn't: MIT, no proprietary engine, instant viewer.
 What tree-sitter gives you that we don't: language coverage breadth.
 What we give you on top of tree-sitter: a typed graph, not just an AST.]

## Built on codegraph

[List of tools/projects that consume codegraph output. Starts with: the React
 Flow viewer, the GitHub Action. Grows from there.]

## Citation

[BibTeX block. Zenodo DOI.]

## Contributing

[Short. Link to CONTRIBUTING.md.]

## License

MIT.
```

**Notes on the skeleton.**

- Hero image is mandatory, not optional. The product is a picture — the README must show it.
- The capability matrix is the single most important section. It should be the first thing rendered after the hero on a slow connection.
- The "Compared to" section is intentionally prose, not a table. Per Part 6's cross-cutting observation, mature OSS dev-tool marketing prefers implicit comparison; a vs.-table will need maintenance and will read as defensive.
- "Built on codegraph" is the honest version of an adopters strip. Even with one entry, it is more credible than no section at all.
- No "Why codegraph?" section. The hero, matrix, and benchmark already answer that question; restating it in prose adds words without value.
- No emoji headers. Optional accent: a single small graph glyph next to the project name. Avoid section-level emoji clutter (📥 ⚡ 💚 etc.) common in some references — they compress badly on small screens and date the doc.

---

## Part 13 — Risks and where the patterns could fail for codegraph

Worth naming explicitly so the patterns aren't applied uncritically.

**Risk: the matrix becomes a maintenance burden.** The capability matrix is the highest-leverage artifact, but it is also a doc that has to stay accurate. If a row says "stable" and a user finds a regression, the matrix loses its credibility instantly. Mitigation: tie matrix cells to test fixtures. Each "stable" cell corresponds to a test in the repo that runs in CI. The matrix is generated, not hand-edited.

**Risk: the benchmark is gameable.** A single named-ratio benchmark ("3.1x faster than scip-typescript") is high-leverage but contestable. Mitigation: pin the fixture (the exact OSS repo, the exact commit), publish the run script, document hardware. Anyone can rerun and dispute. The credibility comes from the ability to dispute, not from the number being unimpeachable.

**Risk: the hero GIF looks staged.** A polished, fast-cut GIF can read as marketing video and erode the "this is a real tool" signal. Mitigation: use a real OSS repo, show real graph density (don't filter to a clean 8-node subset), keep the loop under 6 seconds, no transitions or animations beyond what the React Flow viewer naturally does.

**Risk: the no-LLM positioning becomes brittle as the field changes.** "No LLM, no cloud" is a clear differentiator now. It may become a less salient one in 18 months if the AI-tool fatigue subsides. Mitigation: position the no-LLM claim as a *capability* (deterministic, reproducible, runs in CI without API keys) rather than a *stance* (anti-AI). The capability holds regardless of fashion.

**Risk: the Discord becomes empty.** A Discord badge in the top row implies a responsive community. If a user clicks and finds an empty server, the badge actively damages credibility. Mitigation: don't ship the badge until the channel has a few maintainer responses visible. GitHub Discussions is a lower-bar alternative for the very early stage.

**Risk: the comparison-to-SCIP section reads as territorial.** Codegraph and SCIP overlap. A "Compared to SCIP" section that overclaims will be noticed. Mitigation: stay generous. Lead with what SCIP gives you that codegraph doesn't. Position codegraph as the option for a different shape of use case (viewer-first, GitHub-Action-native, MIT, JSON-schema-first), not as a SCIP replacement.
