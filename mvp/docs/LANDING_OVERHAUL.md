# Landing-page overhaul — consolidated plan

Synthesizes the LiteLLM + Unsloth research (`litellmresearch.md`,
`unslothresearch.md`) with the user's decisions:

- **Pricing:** one free tier today, no enterprise tile yet.
- **Social proof:** deferred — testimonials add later.
- **Stats banner:** must be **live** (read from Codex's events warehouse +
  corpus baseline), not static placeholders.

This file is the working brief Codex + Claude both work from. Where a
section says "claude" or "codex", that's the suggested owner; either
agent can pick up an unclaimed slice.

---

## What's already in flight (do not stomp)

| In flight | Owner | Files |
|---|---|---|
| Eval UI consuming `tokens-summary.json` | codex | `landing/index.html`, `landing.css` |
| Three Ryngo.md flow cards (spec'd, drop-in HTML+CSS) | claude → codex | `mvp/docs/LANDING_RYNGO_MD.md` → `landing/index.html` |
| Phase 9 — usage / compiler-quality warehouse | codex | `mvp/lib/events.js`, `mvp/docs/DATA_WAREHOUSE.md` |

The overhaul below **slots between Codex's eval UI work and the
Ryngo.md cards** — i.e. it's the rest of the landing page outside
those two new sections.

---

## The 9 changes, in shipping order

### 1. Backend — `/api/stats/public` live-stats endpoint  *(claude)*

The stats banner has no data source today. Build it.

**What it returns** (JSON, cached server-side for 60 s):

```json
{
  "asOf": "2026-05-10T20:42:00Z",
  "live": {                          // aggregated from events warehouse
    "reposAnalyzed": 14,             // count(distinct owner||'/'||name) from analysis_runs
    "filesParsed": 6312,             // sum(analyzed_file_count)
    "nodesGenerated": 187432,        // sum(node_count)
    "edgesGenerated": 423110,        // sum(edge_count)
    "routesExtracted": 1284,         // sum(route_count)
    "dbModelsExtracted": 178,        // sum(db_model_count)
    "packagesResolved": 8430,        // sum(package_count)
    "diagnostics": 22                // sum(diagnostic_count)
  },
  "baseline": {                      // from corpus run — always non-zero
    "reposAnalyzed": 54,
    "filesParsed": null,             // backfill from corpus result JSON
    "rawTokensCompiled": 58000000,   // from tokens-summary headline
    "compressionRatios": {
      "topology": 0.0012,
      "focusedSubgraph": 0.0028,
      "compactIR": 0.608,
      "viewModel": 0.139,
      "englishSignature": 0.0000064
    }
  },
  "headline": {                      // pre-rendered banner-ready numbers
    "reposCompiled": 68,             // live + baseline (deduped)
    "nodesGenerated": "187k+",
    "tokensCompressed": "58M+",
    "agentReadyContext": "850× smaller"  // 1 / topology median ratio
  }
}
```

**Aggregation queries** (Postgres, against `analysis_runs` + `repo_submissions`):

```sql
-- live counters
select
  count(distinct repo_submissions.repo_owner || '/' || repo_submissions.repo_name)
    as repos_analyzed,
  coalesce(sum(analyzed_file_count), 0) as files_parsed,
  coalesce(sum(node_count),         0) as nodes_generated,
  coalesce(sum(edge_count),         0) as edges_generated,
  coalesce(sum(route_count),        0) as routes_extracted,
  coalesce(sum(db_model_count),     0) as db_models_extracted,
  coalesce(sum(package_count),      0) as packages_resolved,
  coalesce(sum(diagnostic_count),   0) as diagnostics
from analysis_runs
join repo_submissions on repo_submissions.id = analysis_runs.submission_id
where analysis_runs.status = 'ok';
```

**Fallback strategy:** if `eventsEnabled()` returns false (local dev,
events DB down), return only `baseline` — the banner still has real
numbers from the corpus run baked at build time. Never ship the page
with `live = null`.

**Caching:** in-memory 60-second cache (same pattern as `branchCache`
in server.js). The banner doesn't need real-time precision — minute
granularity is fine. Single Postgres round-trip per minute.

**Files:**
- `mvp/lib/events.js` — add `getLiveStats()` aggregator
- `mvp/lib/stats-baseline.js` (new) — reads `mvp/landing/data/tokens-summary.json` for the baseline block
- `mvp/server.js` — `app.get("/api/stats/public", …)` ~30 lines incl. cache

**Acceptance check:**
- `curl http://localhost:3094/api/stats/public` returns the JSON shape above
- When events DB is unreachable, `live` is `null` but `baseline` populated
- Banner can render `headline` block without any client-side math

---

### 2. Hero — stats banner + multiplier headline  *(codex implements, claude data)*

Two visual additions to the existing hero.

**a. Performance multiplier headline.** Adds one tagline below the
existing "The map your coding agent is missing":

> **850× less context. Same code map.**
> Topology in 0.12 % of raw tokens · single symbol in 0.006 % · focused subgraph in 0.28 %.

The multiplier (`850×`) is `1 / topology median ratio` from the eval —
calculated server-side and surfaced via `/api/stats/public` →
`headline.agentReadyContext`. Updates automatically when the eval re-runs.

**b. Live stats banner** under the demo iframe (LiteLLM-style strip):

```
68 repos compiled  ·  187k nodes generated  ·  58M tokens compressed  ·  850× smaller agent context
```

Numbers come from `/api/stats/public`. Banner lazy-fetches on
DOMContentLoaded, falls back to baked-in baseline values rendered
into the HTML at build time so first paint never shows zeros.

**Files:**
- `mvp/landing/index.html` — add `<section class="hero-stats">` + the multiplier line
- `mvp/landing/landing.css` — `.hero-stats { display: flex; gap: 24px; … }`
- `mvp/landing/stats.js` (new) — fetches `/api/stats/public`, rewrites the banner spans

**Copy (verbatim):**

```html
<!-- multiplier line, immediately below .tagline / .lede -->
<p class="hero-multiplier">
  <strong>850× less context.</strong> Same code map.
  <small>Topology in 0.12 % of raw tokens · single symbol in 0.006 % · focused subgraph in 0.28 %.</small>
</p>

<!-- stats banner, after .demo-frame -->
<section class="hero-stats" aria-label="Ryngo at a glance">
  <span><strong id="statRepos">68</strong> repos compiled</span>
  <span><strong id="statNodes">187k</strong> nodes generated</span>
  <span><strong id="statTokens">58M</strong> tokens compressed</span>
  <span><strong id="statRatio">850×</strong> smaller agent context</span>
</section>
```

**Acceptance check:** load `/` cold — banner shows non-zero numbers
within the first paint. Reload — numbers stay sticky from cache (no
flicker). Disable network — numbers still appear (baseline fallback).

---

### 3. Pricing — single Free card  *(codex)*

The user's decision: one tier today. **No** "contact us for enterprise"
card; **no** comparison table. Free is the only thing offered, and it
should look intentional rather than incomplete.

**Position:** above the FAQ, below the Ryngo.md flow section.

**Copy:**

```html
<section id="pricing" class="section">
  <h2>Free, while we're shipping</h2>
  <p class="section-lede">
    Ryngo is free to use today — paste any public GitHub URL, get the
    map. No account, no waitlist, no card. The MCP server is open source.
  </p>

  <div class="pricing-grid pricing-grid-single">
    <article class="pricing-card pricing-card-free">
      <header>
        <span class="pricing-chip">$0</span>
        <h3>Free</h3>
      </header>
      <ul class="pricing-features">
        <li>Public GitHub repos, every language we parse</li>
        <li>Live typed-port node viewer at <code>/app</code></li>
        <li>Compiler warnings (O(n²), I/O-in-loop, recursion, …)</li>
        <li><code>Ryngo.md</code> persistence per repo</li>
        <li>MCP server — install with one command</li>
        <li>Token-efficiency benchmark you can re-run yourself</li>
      </ul>
      <a class="cta primary" href="/app">Try it on your repo →</a>
      <p class="pricing-foot">
        A paid tier with private repos + team accounts is on the roadmap
        — <a class="inline-link" href="#newsletter">subscribe</a> to hear
        when it ships.
      </p>
    </article>
  </div>
</section>
```

The `.pricing-grid-single` modifier centers a single card with a max
width of ~480 px so it doesn't look like the page is missing two
columns.

**CSS additions:**

```css
.pricing-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 18px;
  margin-top: 24px;
}
.pricing-grid-single {
  grid-template-columns: minmax(0, 480px);
  justify-content: center;
}
.pricing-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 28px 32px;
}
.pricing-card header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 16px;
}
.pricing-card h3 { margin: 0; font-size: 22px; font-weight: 700; }
.pricing-chip {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 14px;
  background: var(--accent);
  color: var(--accent-ink);
  padding: 3px 10px;
  border-radius: 999px;
}
.pricing-features {
  margin: 0 0 22px 18px;
  padding: 0;
  font-size: 15px;
  line-height: 1.6;
}
.pricing-foot {
  font-size: 13px;
  color: var(--muted);
  margin-top: 14px;
}
```

**Acceptance check:** single card renders centered on desktop, full
width on mobile, all 6 bullets visible. The "subscribe" link's hash
matches the newsletter anchor from change #6.

---

### 4. Latest-news section — auto from `CHANGELOG.md`  *(claude builds parser, codex renders)*

Unsloth's pattern: 4 dated bullets that signal momentum. Ryngo's
`mvp/CHANGELOG.md` already follows the right shape (`date · agent ·
sentence`), so this is just a parser + a small `<section>`.

**a. Parser** — `mvp/scripts/build-news.js` (new). Reads the top 5
lines of CHANGELOG.md, splits on the date prefix, writes
`mvp/landing/data/news.json`:

```json
{
  "updatedAt": "2026-05-10",
  "items": [
    {
      "date": "2026-05-10",
      "title": "Three ways to plug Ryngo.md into your agent (spec)",
      "blurb": "Landing spec for MCP / copy-paste / commit-to-repo flows; backend now serves the raw Markdown for download.",
      "link": "https://github.com/MarshallDoyle/Ryngo/commit/7cf3069"
    },
    …5 items total
  ]
}
```

The script runs as part of the build (added to `package.json scripts`).
Each landing deploy gets a fresh `news.json`.

**b. Section** — appears above pricing, below the Personas section:

```html
<section id="news" class="section section-alt">
  <h2>Latest</h2>
  <ul class="news-list" id="newsList">
    <!-- populated from news.json; static fallback rendered server-side
         so the page never has an empty list on first paint -->
  </ul>
  <a class="inline-link" href="/changelog">Full changelog →</a>
</section>
```

```css
.news-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
.news-list li {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.news-list time {
  font-family: ui-monospace, SFMono-Regular, monospace;
  color: var(--muted);
  font-size: 13px;
}
.news-list .news-title { font-weight: 600; }
.news-list .news-blurb { color: var(--muted); font-size: 14px; line-height: 1.5; }
```

**Files:**
- `mvp/scripts/build-news.js` (new, ~80 LOC)
- `mvp/landing/data/news.json` (generated)
- `mvp/landing/index.html` — `<section id="news">`
- `mvp/landing/landing.css` — `.news-list` block

**Acceptance check:** running `npm run build:news` writes
`landing/data/news.json` with 5 items keyed off CHANGELOG. Landing
page fetches it on load. Worst case (fetch fails) the static fallback
keeps 5 items visible.

---

### 5. "Coming soon" teaser cards  *(codex)*

Unsloth's pattern: small cards saying what's next. Builds confidence
the team is shipping. Position: between latest-news and pricing.

**Three cards, copy provided:**

```html
<section id="roadmap" class="section">
  <h2>Coming soon</h2>
  <div class="roadmap-grid">

    <article class="roadmap-card">
      <span class="roadmap-chip">in progress</span>
      <h3>Tree-sitter parsers</h3>
      <p>Swap regex extractors for tree-sitter in TS + Python. Same IR, deeper signatures, fewer edge-case misses on JSX / generics / decorators.</p>
    </article>

    <article class="roadmap-card">
      <span class="roadmap-chip">next</span>
      <h3>Go + Rust support</h3>
      <p>Go via <code>go list -deps -json</code>, Rust via <code>rust-analyzer scip</code>. Real types, real cross-crate edges.</p>
    </article>

    <article class="roadmap-card">
      <span class="roadmap-chip">queued</span>
      <h3>Multi-repo aggregation</h3>
      <p>One Ryngo view across your whole org's repos. Cross-repo call graphs, shared regions, service-level diff.</p>
    </article>

  </div>
</section>
```

```css
.roadmap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 18px;
}
.roadmap-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
}
.roadmap-chip {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
  background: var(--bg);
  padding: 3px 8px;
  border-radius: 6px;
  margin-bottom: 10px;
  display: inline-block;
}
.roadmap-card h3 { margin: 4px 0 8px; font-size: 17px; }
.roadmap-card p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
```

**Acceptance check:** three cards render in a row on desktop, stack on
mobile. Each chip has its own muted background; cards visually
distinct from `.pricing-card` and `.ryngo-md-card`.

---

### 6. Newsletter signup  *(codex)*

Unsloth has two, which is overkill — Ryngo gets one. Position: footer
band, just above the existing footer link grid. Substack or Buttondown,
your call; Substack matches the existing newsletter Unsloth has so
copy/paste of their embed works.

```html
<section id="newsletter" class="section section-newsletter">
  <h2>Get a weekly diff of what shipped</h2>
  <p class="section-lede">
    One short email per week. New languages, new adapters, new corpus
    numbers, new MCP tools. No marketing.
  </p>
  <form class="newsletter-form" action="https://ryngo.substack.com/subscribe" method="POST" target="_blank">
    <input type="email" name="email" placeholder="you@your-domain.com" required />
    <button type="submit" class="cta primary">Subscribe</button>
  </form>
  <p class="newsletter-foot">
    Or: <a href="https://github.com/MarshallDoyle/Ryngo/blob/main/mvp/CHANGELOG.md" target="_blank">read the full changelog</a>.
  </p>
</section>
```

**Setup task:** create `ryngo.substack.com` (or claim an alternate
domain). 5 minutes. Until then, the form can post to a `/api/newsletter`
endpoint that stores emails in a Postgres table (`newsletter_subscribers`)
which Codex can drain manually.

**Files:**
- `mvp/landing/index.html` — `<section id="newsletter">`
- `mvp/landing/landing.css` — `.newsletter-form` block
- (optional now, mandatory later) `mvp/server.js` `/api/newsletter` POST endpoint

**Acceptance check:** form submits without page reload, success message
appears inline. Email lands in the configured destination.

---

### 7. Tagline density — companion sentence  *(codex copy edit)*

The existing tagline is poetic; keep it. Add a companion sentence that
fills in **what it is** and **what it integrates with** — LiteLLM-style.

```html
<!-- existing -->
<h1 class="tagline">The map your coding agent is missing.</h1>

<!-- ADD as new <p> immediately after, before .lede -->
<p class="tagline-companion">
  Ryngo is a deterministic code-to-graph compiler with an MCP server.
  Paste a GitHub URL, get a typed node-editor. Mark intents in
  <code>Ryngo.md</code>; Claude Code, Cursor, Codex, and Aider all read
  the same file.
</p>
```

Names the category ("deterministic code-to-graph compiler"), the
mental model ("paste a URL, get a node-editor"), the integration
surface (the four LLM harnesses by name), and the persistent state
mechanism (`Ryngo.md`). 36 words, slightly above LiteLLM's 23 but
denser per-word.

```css
.tagline-companion {
  max-width: 720px;
  margin: 16px auto 4px;
  color: var(--muted);
  font-size: 17px;
  line-height: 1.55;
}
```

---

### 8. Founder Calendly + community in the footer  *(codex)*

LiteLLM's pattern. Three additions to the existing footer:

```html
<footer class="site-footer">
  <div class="footer-col">
    <h4>Talk</h4>
    <ul>
      <li><a href="https://cal.com/marshall-doyle/ryngo" target="_blank">Book 15 min with the founder ↗</a></li>
      <li><a href="https://discord.gg/ryngo" target="_blank">Discord ↗</a></li>
      <li><a href="mailto:hi@ryngo.ai">hi@ryngo.ai</a></li>
    </ul>
  </div>

  <div class="footer-col">
    <h4>Build</h4>
    <ul>
      <li><a href="https://github.com/MarshallDoyle/Ryngo">GitHub</a></li>
      <li><a href="/docs">Docs</a></li>
      <li><a href="https://github.com/MarshallDoyle/Ryngo/blob/main/mvp/CHANGELOG.md">Changelog</a></li>
      <li><a href="/mcp">MCP install</a></li>
    </ul>
  </div>

  <div class="footer-col">
    <h4>About</h4>
    <ul>
      <li><a href="https://marshall-doyle.com/" target="_blank">Marshall Doyle</a></li>
      <li><a href="/mission">Mission</a></li>
      <li><a href="/privacy">Privacy</a></li>
      <li><a href="/terms">Terms</a></li>
    </ul>
  </div>
</footer>
```

**Setup tasks:**
- Create a Cal.com or Calendly link for "Book 15 min with the founder"
- Spin up a Discord server (it's free; ~5 minutes)
- Decide on `hi@ryngo.ai` or your existing email

Until each is real, link to a holding mailto. Better to have a real
working footer than dummy links.

---

### 9. Screenshots per feature  *(claude captures, codex inlines)*

Unsloth pairs every claim with a screenshot. Ryngo has a live iframe
which is better than screenshots — but the rest of the scroll is
prose. Add 3–4 static stills that anchor specific claims:

| Claim | Static still needed |
|---|---|
| "typed ports" | Close-up of a FunctionNode showing param/return handles + types |
| "compiler warnings" | Close-up of FunctionNode with ⚠ badge open, warnings panel visible |
| "Ryngo.md persistence" | Inspector with "View Ryngo.md" panel open, file content visible |
| "diff view" | Side-by-side diff of two refs of the same repo |

All can be captured by running `npm run dev`, opening
`karpathy/autoresearch`, taking macOS screenshots, then cropping with
Preview. Save as `mvp/landing/images/feature-{ports,warnings,ryngo-md,diff}.png`.

**Acceptance check:** each existing feature section in `index.html`
gets a `<figure>` with the screenshot. No section reads as prose-only.

---

## Deferred to a later iteration

- **Mascot / character** — gated on logo-lab finalist. Once you pick `RY-N` from `logos.html`, the favicon, header logomark, and any illustration slots all swap to that mark. Until then, nothing to do.
- **Customer testimonials** — gated on having actual users. Don't ship placeholder quotes. As soon as one Cursor / Claude Code / Aider user is shipping with Ryngo, ask for a one-line + their title + their company.
- **Enterprise pricing tile** — return when there's a paid feature to charge for. Today there's nothing to put in it.
- **Numeric charts / graphs** — Codex's eval section already does the heavy lifting on token-efficiency visualization. No need to add more chart UI until there's a second story to tell (compiler quality? warning recall? adapter coverage?).

---

## Shipping order

Three iterations. Each is its own commit + push so the landing improves
incrementally rather than landing in one big mass.

### Iteration 1 — the foundation  *(all parallelizable)*

| Change | Owner | Blocks downstream? |
|---|---|---|
| 1 · `/api/stats/public` endpoint | claude | yes — blocks #2 |
| 3 · Free pricing card | codex | no |
| 4a · `build-news.js` parser + `news.json` | claude | yes — blocks #4b |
| 7 · Tagline companion sentence | codex | no |
| 8 · Footer additions (Cal.com, Discord, links) | codex | no |
| Drop-in: 3 Ryngo.md flow cards (already spec'd) | codex | no |

Ship target: one commit each from claude + codex.

### Iteration 2 — the visible payoff

| Change | Owner | Depends on |
|---|---|---|
| 2 · Hero stats banner + multiplier headline | codex | #1 |
| 4b · Latest-news `<section>` | codex | #4a |
| 5 · "Coming soon" roadmap cards | codex | none |
| 6 · Newsletter signup | codex | none |

Ship target: one Codex commit, ~150 LOC of HTML + CSS.

### Iteration 3 — polish

| Change | Owner |
|---|---|
| 9 · Feature screenshots | claude (capture) → codex (inline) |
| Mascot swap (gated on logo lock-in) | both |
| Newsletter wiring to real Substack / Buttondown | claude |
| Calendly real URL | claude |

---

## File map summary

```
mvp/
├── docs/
│   ├── LANDING_OVERHAUL.md       ← this file
│   └── LANDING_RYNGO_MD.md       ← (already shipped) three Ryngo.md cards
├── lib/
│   ├── events.js                 ← add getLiveStats() — change #1
│   └── stats-baseline.js         ← new — change #1
├── scripts/
│   └── build-news.js             ← new — change #4a
├── server.js                     ← add /api/stats/public — change #1
└── landing/
    ├── index.html                ← changes #2, #3, #4b, #5, #6, #7, #8, #9
    ├── landing.css               ← matching CSS for every change above
    ├── stats.js                  ← new — change #2 (banner hydration)
    ├── data/
    │   ├── tokens-summary.json   ← already shipped
    │   └── news.json             ← new — change #4
    └── images/
        └── feature-*.png         ← new — change #9
```

---

## Verification

After iteration 1:
1. `curl http://localhost:3094/api/stats/public` returns the expected JSON shape, with `live` either populated or null and `baseline` always populated.
2. Pricing card centered on desktop, full-width on mobile, all 6 bullets visible.
3. `npm run build:news` writes 5 items into `landing/data/news.json`.
4. Footer renders 3 columns with real links (or working mailto / # placeholders).
5. Tagline + companion sentence both visible above the demo iframe.

After iteration 2:
6. Hero stats banner shows non-zero numbers on first paint, hydrates with live values from `/api/stats/public` within 1 s of page load.
7. Latest-news section shows 5 dated items.
8. Roadmap section shows 3 "coming soon" cards.
9. Newsletter form posts (to a real or placeholder destination); success message inline.

After iteration 3:
10. Each prose feature section has a paired static screenshot.
11. Mascot mark replaces the placeholder R in header + favicon.
