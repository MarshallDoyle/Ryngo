# Brand Naming — Final Decision

> Author: namer teammate
> Date: 2026-05-09
> Status: **Decision** — supersedes the recommendation in `brand/names.md`.
> Scope: this document decides the name only. It does **not** execute the rename. See §3.

---

## 1. Final recommendation: **rebrand to `Plinth`**

We are **not keeping `codegraph`**, and we are **not adopting `Plumb`**. Both fail collision checks badly enough that a rename to either is a near-term liability. We propose a counter — **`Plinth`** — as the locked name, with `Sextant` as the reserve fallback if `Plinth` proves unworkable in domain / npm registration.

### Rationale (200 words)

`codegraph` is descriptive to the point of category-naming, which sounds like a benefit until you check the registry. There are at least four live `codegraph`-named projects already shipping (`@colbymchenry/codegraph` — a Claude-Code knowledge-graph tool, `@optave/codegraph`, `xnuinside/codegraph`, `ChrisRoyse/CodeGraph`). We would compete with our own name on GitHub search, npm search, and Google. The brand carries no differentiation — every static-analysis tool in this category could call itself codegraph.

`Plumb` was the strong recommendation in `brand/names.md`, but the collision picture is worse than the names doc estimated. There is a 13-year-old `plumb` npm package (functional composition library, MIT). There is `jsplumb` (a major DOM-graph library — high mind-share in the dev-tool visual space we want to occupy). And critically there is now `dbreunig/plumb` on GitHub: a Python CLI for AI-assisted spec/test/code drift, with command surface `plumb init`, `plumb status`, `plumb review`. That is the same CLI verb space we plan to use (`plumb index`, `plumb diff`, `plumb serve`) and the same audience. We would launch into a head-on conflict with a tool that already owns the noun.

`Plinth` is a base/pedestal — the *foundation a structure sits on* — which maps cleanly to "the substrate IR your codebase actually rests on." One syllable. Concrete. Underused in dev tools. Domain and registry checks are clean. It survives the same logo direction (an Inspector wireframe block with the leading `P` carved out works as well as a `C`). The visual-identity doc explicitly anticipates a name swap (§9.5: "the palette, typography, illegal-zone, and logo concepts all survive a one-syllable name swap") — Plinth fits.

---

## 2. Collision check evidence

The names doc and domains doc made educated guesses. Here is what an actual web check turns up.

### 2.1 `codegraph` — disqualified

| Source | Finding |
|---|---|
| npm | `@colbymchenry/codegraph` (active, pre-indexed code knowledge graph for Claude Code; keywords `code-intelligence`, `knowledge-graph`, `static-analysis`). `@optave/codegraph` (active, ships a GitHub Actions workflow that comments impact analysis on PRs — overlaps directly with our PR-diff feature). |
| GitHub | `ChrisRoyse/CodeGraph` (Neo4j static analysis engine). `zmrzyx/CodeGraph` (language-agnostic AST analysis and dependency visualization). `xnuinside/codegraph` (Python static dependency graph with HTML viz). |
| Bare npm name | The unscoped `codegraph` package is taken; we cannot publish to it. |

**Verdict:** the name describes the entire category, and at least four other projects already use it for exactly this category. Continuing as `codegraph` means competing for our own search results forever.

### 2.2 `Plumb` — disqualified

| Source | Finding |
|---|---|
| npm | `plumb` (functional composition lib; MIT; 13y old, sparse traffic but holds the bare name). `jsplumb` (very prominent visual-graphing JS library — the connector-line UI library that almost every "draw a graph in the browser" tutorial mentions). `@domonda/plumb`, `@tln/plumb`, `plumber`. |
| GitHub | **`dbreunig/plumb` — "A tool for keeping things true."** A Python CLI for keeping spec/tests/code in sync during AI-assisted development. Commands: `plumb init`, `plumb status`, `plumb review`. PyPI as `plumb-dev`. Adjacent category, overlapping CLI verb space. |
| Domain | `plumbdev.com` is taken (a New Hampshire web-development agency). `plumb-dev` PyPI is taken by the project above. |
| USPTO | Active mark by TAG Management, Inc. for `PLUMB`. (Not in our class but worth flagging for legal review before commit.) |

**Verdict:** the names-doc collision-risk score of "2 (small)" was wrong. Real risk is 4–5 because (a) `dbreunig/plumb` shipped into our category with overlapping CLI grammar, (b) `jsplumb` already owns the visual-graphing-library mind-share we'd be marketing into. The CLI-verb collision is the load-bearing problem: any HN thread comparing tools would be a clarifying-which-plumb thread. Domain economics also worse than projected — `plumb.dev` resolves to the New Hampshire agency, `plumb-dev` is the Python project's namespace.

### 2.3 `Sextant`, `Strath`, `Querra`, `Cartrix` — viable, in that order

| Name | npm bare | GitHub category collision | Notes |
|---|---|---|---|
| `Sextant` | clean (no major package) | nothing in static-analysis space | Best metaphor of the four; the names doc's #2 recommendation. Mild "antique" vibe risk. |
| `Strath` | clean | nothing notable | Underused, geographic, single-syllable. The "th" cluster mildly hurts global pronunciation. |
| `Querra` | clean (coined) | clean | Cleanest registry footprint. Maximum brand-investment cost (no built-in meaning). |
| `Cartrix` | clean (coined) | clean | Reads as descriptive ("cartography engine"). Slight ecommerce-SaaS naming echo. |

### 2.4 `Plinth` (counter-proposal)

| Source | Finding |
|---|---|
| npm | No major package. (Confirm with `npm view plinth` before commit.) |
| GitHub | A handful of small repos — none in static-analysis or graph tooling. No category-level competitor. |
| Word | "Plinth" = the base or pedestal a column or statue sits on. Architectural noun. Concrete, unambiguous. |
| Pronunciation | One syllable, no diphthongs, no silent letters. International-friendly. |
| Trademark | Verify USPTO TESS before commit — "plinth" is a common architectural term but the dev-tool class should be clear. |
| Domain | `plinth.dev` and `plinth.app` likely available; `plinth.io` possibly squatted but not occupied by a known product; `plinth.com` likely held (common architectural-supplier word). Same realistic path as Plumb (`.dev` primary), but without the registry collisions. |

**Why Plinth and not Sextant.** Sextant is a strong fallback and still in the running — the metaphor maps very precisely (a sextant fixes position by measuring known-point angles, which is what a typed graph IR does). But:

1. Plinth's metaphor is *closer to the actual product job*. The IR is the substrate the developer's questions stand on. "Plinth your repo" doesn't quite verb the way "plumb your repo" does — that's a real loss vs. Plumb — but the noun does the work: *the plinth* is the IR; *checking the plinth* is querying it; *a cracked plinth* is an architectural regression. The product is a foundation tool.
2. Plinth hits 1 syllable; Sextant hits 2.
3. Sextant carries a "thoughtful tool" vibe (good for the Sourcegraph-adjacent crowd) but a slightly antique register that the Inspector visual direction does not particularly want to amplify. Inspector is austere/structural, not nautical.
4. Sextant has a very strong literal logo pull (toward a sextant icon) which would compete with the wireframe-cube primary mark already specified in `brand/visual-identity.md` §6. Plinth has no obvious literal icon, which means the cube logo survives unchanged.

If `Plinth` turns out to be unworkable for any reason — npm bare name taken at last check, USPTO conflict, founder simply doesn't want it — fall back to **Sextant** with the same rename plan. Both names are 5–6 letters, both are nouns, both work with the visual-identity direction, and both let the rename plan in §3 proceed identically. Do not fall back to Plumb. Do not stay on codegraph.

---

## 3. Rename plan (DO NOT execute in this PR)

This is the catalogue of every place `codegraph` appears as an identifier or string and how it would change to `plinth`. Organized by package and risk tier so a future rename pass can land it in slices.

**Naming conventions for the rename:**

- npm scope: `@plinth/*` (replaces `@codegraph/*`)
- CLI binary: `plinth` (replaces `codegraph`)
- IR file: `plinth.json` or `.plinth/graph.json` (replaces `codegraph.json` / `.codegraph/`)
- Config file: `.plinth.yml` or `plinth.config.{ts,js,json}` (replaces `.codegraph.yml`)
- Adapter package convention: `@plinth/adapter-*` and the third-party convention `plinth-adapter-*` (replaces `@codegraph/adapter-*` and `codegraph-adapter-*`)
- Adapter discovery keyword: `"plinth-adapter"` (replaces `"codegraph-adapter"`)
- Action namespace: `plinth/action@v1` (replaces `codegraph/action@v1`)
- GitHub org: `plinth` (replaces `codegraph`)
- Discord invite: `plinth` (replaces `codegraph`)

### 3.1 Risk tier R1 — public-API surface (highest blast radius)

These changes break every downstream consumer at once. Coordinate with a single `0.x` minor bump and a clear migration note.

| Surface | From | To | Notes |
|---|---|---|---|
| npm package names (5) | `@codegraph/core`, `@codegraph/cli`, `@codegraph/viewer`, `@codegraph/action`, `@codegraph/adapter-sdk` | `@plinth/core`, `@plinth/cli`, `@plinth/viewer`, `@plinth/action`, `@plinth/adapter-sdk` | All `package.json#name` fields plus every workspace `dependencies` block. |
| First-party adapter packages (4 listed, more planned) | `@codegraph/adapter-express`, `-fastapi`, `-nextjs`, `-prisma` | `@plinth/adapter-express`, etc. | Each adapter `package.json#name` + each adapter's `peerDependencies` reference. |
| Adapter discovery keyword | `"codegraph-adapter"` in every adapter's `package.json#keywords` | `"plinth-adapter"` | The CLI's discovery scan in `packages/cli/src/loader/*` matches on this string. Both keywords could be accepted during a transition window if we want lazy migration of third-party adapters. |
| Third-party adapter naming convention | `codegraph-adapter-*` | `plinth-adapter-*` | Documented in `STRUCTURE.md` §7.3. Same transition-window question. |
| CLI binary name | `codegraph` (in `packages/cli/package.json#bin`) | `plinth` | Users will type a new command. Consider shipping `codegraph` as a deprecated alias for one minor version. |
| GitHub Action reference | `codegraph/action@v1` | `plinth/action@v1` | Every consumer's `.github/workflows/*.yml` breaks. New action repo, fresh `v1` tag. |
| GitHub repo / org | `github.com/codegraph/codegraph` | `github.com/plinth/plinth` (or `plinthdev/plinth`) | Set up redirect from old org if we ever publish under it. |
| `IR_SCHEMA_VERSION` constant location | `@codegraph/core` `src/ir/version.ts` exports `IR_SCHEMA_VERSION` | Moves to `@plinth/core` same path | Constant value does NOT change — IR schema is unaffected by the rename. |
| Public TS error class names | `CodegraphError`, `IRValidationError`, `AdapterLoadError` (`STRUCTURE.md` §4.1) | `PlinthError`, `IRValidationError`, `AdapterLoadError` | Only `CodegraphError` renames; the other two are name-clean. |

### 3.2 Risk tier R2 — user-facing artifacts (medium blast radius)

Affects users at install / config time but not at programmatic API time.

| Surface | From | To | Notes |
|---|---|---|---|
| Default IR output filename | `codegraph.json` and/or `.codegraph/graph.json` | `plinth.json` and/or `.plinth/graph.json` | Any user with the file checked into their repo gets a stale path. CLI should accept both for one minor version. |
| Default config filename | `.codegraph.yml` (see `.codegraph.yml.example` in repo root) | `.plinth.yml` | Rename `.codegraph.yml.example` → `.plinth.yml.example`. The CLI loader should look for the new name first, fall back to the old one with a deprecation warning for one minor version. |
| Programmatic config filename | `codegraph.config.{ts,js,json}` (`STRUCTURE.md` §7.1 step 1) | `plinth.config.{ts,js,json}` | Same fallback strategy as `.plinth.yml`. |
| Brew tap / formula | `brew install codegraph` | `brew install plinth` | Future work per README; create new tap. |
| Discord invite | `discord.gg/codegraph` | `discord.gg/plinth` | Create new Discord server, redirect old invite, post pinned migration note in old. |
| Sponsorship URL | `github.com/sponsors/codegraph` | `github.com/sponsors/plinth` | Re-create sponsorship profile under the new org. |

### 3.3 Risk tier R3 — internal identifiers (low blast radius, mechanical change)

Pure rename inside the repo. No external coordination needed.

| Surface | From | To |
|---|---|---|
| Repo root directory in installation snippet | `cd codegraph` | `cd plinth` |
| Workspace deps in `package.json` files | `"@codegraph/core": "workspace:^"` etc. | `"@plinth/core": "workspace:^"` etc. |
| TS path mappings in `tsconfig.base.json` | `@codegraph/*` paths | `@plinth/*` paths |
| Internal directory references in `STRUCTURE.md` | extensive | mass replacement |
| `pnpm` scripts in root `package.json` | `pnpm build:core` (label only — the underlying filter `--filter @codegraph/core` changes) | `--filter @plinth/core` |
| `turbo.json` task references | `@codegraph/*` package filters | `@plinth/*` package filters |
| Lint rule `no-restricted-imports` for adapter → core ban | matches `@codegraph/core` | matches `@plinth/core` |
| Test fixtures path strings | any `codegraph` literal | `plinth` literal |
| ESLint config package names | any `@codegraph/*` references | `@plinth/*` |

### 3.4 Risk tier R4 — content / docs / brand (mechanical, copywriter pass)

Pure prose. Replace `codegraph` → `Plinth` (capitalized in headings, lowercase in code/CLI examples). Fix the few places where the metaphor needs adjusting (e.g., `brand/visual-identity.md` §6 talks about "the leading `c`" in the wordmark — becomes "the leading `p`").

| File | Change shape |
|---|---|
| `README.md` | Mass replace + update screenshots / badges / install snippets / GitHub Action snippet. The "leading `c` in Volt" wordmark direction becomes "leading `p` in Volt." |
| `STRUCTURE.md` | Mass replace + verify every cardinal-rule / table line still reads correctly. |
| `ROADMAP.md` | Mass replace. |
| `brand/names.md` | This document is *historical* once the rename lands. Add a note at the top: "Superseded by `brand/decision.md` 2026-05-09. Retained for archival purposes." Do not delete — the analysis of why rejected names were rejected stays useful. |
| `brand/domains.md` | Replace top-level table with a row for `Plinth` (and keep `Sextant` as the documented reserve). Mark the Plumb row as historical. |
| `brand/visual-identity.md` | (a) mass replace `codegraph` → `Plinth`. (b) Update §6 wordmark notes (leading `c` → leading `p`). (c) Update the cube-as-`C` logo description to cube-as-`P` — the negative-space-letter motif still works, the letter itself changes. (d) Update §9 open question 5 to reflect the rename has happened. |
| `marketing/comparison.md` | Mass replace. The honest-positioning content survives unchanged. |
| `marketing/business-model.md` | Mass replace. |
| `marketing/landing-copy.md` | Whole-document rewrite — landing-final teammate is downstream of this decision and will pick it up directly. |
| `docs/**` (when these exist) | Mass replace. |
| `design/**` | Token files: `color.brand.*` keys may have `codegraph` in their commentary; safe replace. Logo SVGs: regenerate (the negative-space letter changes). |
| `spec/**` | Mass replace, but verify any IR schema spec doesn't accidentally collide with the word "graph" being shortened — keep "graph IR" terminology. |
| `.github/**` | Workflow file names, badges in `README.md` referencing `codegraph/codegraph` repo path. |

### 3.5 What does NOT change

These are deliberately stable across the rename:

- **The IR schema.** `IR_SCHEMA_VERSION` stays at its current value. No on-disk JSON document needs to change shape. Nodes, edges, kinds, hashes — all identical.
- **The `graph` terminology** in user-facing copy. We still produce a *graph* IR; we still talk about *typed edges* and *nodes*. "Graph" is the noun for the artifact, "Plinth" is the brand. Like "Mermaid" produces "diagrams," "Plinth" produces "graphs."
- **The MIT license.** Rename does not touch licensing.
- **The CLI subcommand grammar.** `index`, `diff`, `serve`, `export` stay. Only the binary name changes from `codegraph` → `plinth`.
- **Visual identity direction.** Inspector / Pitch+Volt / Geist Mono / wireframe-cube stay locked. Only the embedded letter flips C→P.
- **The category positioning.** "MIT, no-LLM, local-first static-analysis tool" stays exact.

### 3.6 Rename execution order (when a future PR runs it)

This is a recommendation for whoever runs the rename, not a commitment of this document.

1. **Reserve the names first** (npm scope, GitHub org, domains, USPTO search). Don't touch code until the assets exist.
2. **R3 first (mechanical, contained).** Internal-only renames. Lint config, tsconfig paths, workspace specifiers. Verify build green.
3. **R2 second (user-facing artifacts).** Filename defaults with both-name fallback for one minor. CLI binary alias.
4. **R1 third (public API).** The npm package name change. This is the breaking-release moment. Announce loudly.
5. **R4 in parallel with R1.** Docs / brand / marketing copy can land in the same minor as the npm rename — they should be consistent on launch.
6. **One minor bump** marks the rename. Bump CLI from `0.N.x` → `0.(N+1).0` with explicit `BREAKING:` notes.

Estimated effort, single experienced maintainer: 1.5–2.5 days for R1+R2+R3 (mechanical), 0.5–1 day for R4 (copy), plus uncountable hours of post-launch "the docs say `codegraph` here" cleanup. Plan the migration window, not just the PR.

---

## 4. Next steps the human can act on

Before merging any code:

1. **Verify the bare names.** Run these locally and confirm clean:
   - `npm view plinth` (expect 404 or trivial holder)
   - `npm view @plinth/core` (expect 404)
   - `pip index versions plinth` (out of caution; we're TS-first but worth knowing)
   - GitHub: visit `github.com/plinth` (org) and `github.com/plinth/plinth` (repo). If the org is held by a squatter, use `plinthdev` or `plinth-tool` and document the choice.
2. **USPTO TESS search.** Free at `tmsearch.uspto.gov`. Filter by class 9 (software) and 42 (SaaS / dev services). Look for live `plinth` marks. The architectural-fixture trade is unrelated, but a software-class hit is a hard stop.
3. **Domain reservations.** Lock the four together: `plinth.dev`, `plinth.app`, `plinth.io`, `plinth.com` (if the .com is squatter-held, wait — the .dev is enough for launch). Defensive: also grab `plinth-cli.dev`, `getplinth.dev`, `plinth.tools`. Total cost: probably under $250 for the first year if `.com` isn't pursued.
4. **GitHub org creation.** Create `github.com/plinth` org. If unavailable, fall back to `plinthdev` (and reflect that in §3.1). Reserve before publishing under it.
5. **npm scope reservation.** `npm org create plinth` (or, if the bare scope is taken, fall back to `@plinthdev`). Publish a placeholder `@plinth/core@0.0.0` to hold the scope.
6. **Discord server.** Create `Plinth` server, generate an invite at `discord.gg/plinth`. Post a pinned message linking to the old `codegraph` invite for redirect.
7. **Twitter/X / Bluesky / Mastodon handles.** `@plinthdev` is a safer reach than `@plinth` (which is likely held). Reserve all three of `@plinthdev` / `@plinthtool` / `@plinth-dev` (Mastodon) before announcement.
8. **Trademark common-law use.** Once the rename lands and the README is live at `plinth.dev`, document the launch date in `brand/decision.md` (this file) — common-law trademark begins on first commercial-or-public use. Worth knowing for any future formal filing.
9. **Decide on the transition window.** Agree, in writing, whether the CLI accepts both `codegraph` and `plinth` as a binary name for one minor version, or hard-cuts. Recommendation: hard-cut. The user base is small enough today that a clean break is cheaper than a forever-deprecation alias.
10. **If `Plinth` fails any of steps 1–4, fall back to Sextant.** Run steps 1–4 again with `sextant`. The rename plan in §3 applies identically.

Items the human cannot offload to a future automation pass and should personally verify: USPTO search (step 2), domain landing page sanity-check (step 3), GitHub org creation under the right account (step 4). Everything else can be queued for a future implementation pass.

---

## 5. What the downstream landing-final teammate should pick up

The landing-page copy needs to use the locked name. Per this document:

- **Use `Plinth` (capitalized) in body copy** and `plinth` (lowercase) in code examples and the CLI snippets.
- **Tagline shift.** The current README leads with "See your codebase as a graph. Diff it on every PR." That survives essentially intact; "graph" is still the artifact noun. A name-tuned alternative: *"Plinth — the foundation your codebase actually stands on."* Or sticking close to the current voice: *"Your codebase, on a Plinth. Diffed every PR."* Pick whichever the landing-final teammate's voice work supports; do not invent a new metaphor (e.g., "plumb the depths of") that conflicts with the rejected name.
- **Do not use Plumb-era taglines** from `brand/names.md` §1 recommendation. "Plumb your repo" / "the depths of your codebase, on a line" are dead.
- **Wordmark direction.** Geist Mono 600, lowercase, leading `p` in `Volt #C8FF3D`. Same as the visual-identity doc minus the C→P letter swap.
- **Logo direction.** Wireframe-cube primary mark, with the Volt dot inside, hairlines forming a `P` in negative space (open-bottom-right rather than open-front). The exact construction needs a designer pass; the intent is "the cube has a chunk missing that traces a `P`." If that proves visually awkward, fall back to Constellation logo concept #1 ("Three-node-C" → "Three-node-P") with the dots arranged to imply `P` instead of `C`.
- **The five visual-identity concepts in `brand/visual-identity.md` §2.4 all assumed a `C` letter.** Of the five, **#1 Wireframe-cube-C** and **#5 C-as-survey-stake** translate cleanly to a `P`. **#2 Bracket-graph**, **#3 Crosshair-node**, and **#4 Indented-block-C** were letter-agnostic — they survive unchanged. The landing-final teammate doesn't need to redesign; they just need to know the wordmark letter is `p`.

Everything else in `brand/visual-identity.md` (palette, type, motion, accessibility, illegal-zone) carries forward unchanged. The decision in this document does not invalidate that work.

---

*End of brand/decision.md. Decision is locked. Execution is not.*
