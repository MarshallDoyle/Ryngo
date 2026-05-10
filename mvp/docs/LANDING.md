# Ryngo — landing page plan

Plan, not implementation. This describes what `ryngo.ai/` (the
unauthenticated marketing surface) looks like when we ship it. The app
itself stays at `ryngo.ai/app` (or directly when authed).

## Goals

1. **Within 5 seconds of arrival**, a visitor sees Ryngo doing the
   thing — not a screenshot, not a video, the live React Flow editor
   with a real codebase already inside it.
2. **Within 15 seconds**, the visitor can pan, click a node, and see
   the structure respond. No paste, no clone, no signup.
3. **A "Walk me through it" button** opens a short interactive tour
   (8 steps, ~30 s total, skippable) that points at specific UI
   elements with tooltip bubbles. Persists "seen" in localStorage so
   returning visitors aren't nagged.
4. **Three named CTAs by the fold:**
   - "Try with your repo →" — scrolls to / focuses the URL paste box
   - "View example: Express" / "View example: FastAPI" / "View example:
     Next.js" — switches the embedded demo to a different pre-baked IR
   - "How it works" — scrolls to a 3-step illustrated section
5. **Honest copy.** Same opinionated voice as `missionStatement.md`. No
   "leverage / powerful / AI-powered / 10x." If a sentence could appear
   on any other developer-tools landing page, cut it.

## Non-goals

- Pricing page (no SaaS pricing yet).
- Auth wall on the demo (the demo is read-only, no rate limit hit).
- Full SSR / hydration. The page is mostly static HTML; the demo
  viewer hydrates on idle. Tools like Next.js are overkill here.
- Per-visitor analytics beyond a single page-view counter. We're not
  building a marketing funnel; we're showing the product.

---

## Architecture

```
ryngo.ai/                 ← static landing page (HTML + small bundle)
  ├─ hero
  ├─ embedded demo viewer ← React Flow + pre-baked IR
  ├─ walkthrough overlay  ← tooltip steps when invoked
  ├─ "How it works" 3-step
  ├─ persona strip (vibe coder / PM / engineer)
  ├─ LLM-native callout    ← MCP, Claude Code, ChatGPT Apps
  ├─ examples gallery      ← repo-switcher buttons
  └─ FAQ + footer

ryngo.ai/app              ← the full SPA (current viewer + URL paste)
ryngo.ai/api/*            ← unchanged
ryngo.ai/mcp              ← unchanged (Streamable HTTP MCP)
```

### One Cloud Run service serves all four

Routing in `server.js`:

```js
app.use("/api", apiRouter);
app.post("/mcp", handleMcpHttpRequest);
app.use("/app", express.static(path.join(distDir, "app")));
app.use("/", express.static(path.join(distDir, "landing")));
```

`vite build` is configured with two entry points (`landing/main.js`,
`src/main.jsx`) and outputs to `dist/landing/` and `dist/app/`. The
landing bundle should be **small** — under 60 KB gzipped if possible —
so first paint is sub-second from a cold edge.

### File layout

```
mvp/
├─ landing/
│  ├─ index.html           ← marketing copy, semantic, no React
│  ├─ main.js              ← demo viewer + walkthrough mount
│  ├─ demo-irs/
│  │  ├─ express-fastify.json
│  │  ├─ fastapi-sqlmodel.json
│  │  ├─ nextjs-prisma.json
│  │  └─ default.json      ← shipped on first paint, copy of one above
│  ├─ walkthrough-steps.js
│  └─ landing.css          ← scoped styles, doesn't import the app's
│                             styles.css to keep the bundle tiny
├─ src/                    ← unchanged (the /app surface)
└─ scripts/
   └─ build-demo-irs.js    ← clones the chosen public repos, runs
                             analyzeRepo, writes the JSONs into
                             landing/demo-irs/. Run by `npm run
                             build` so demos stay in sync with the
                             current parser.
```

---

## The demo IR — what's inside the embedded viewer

**Two complementary candidates** for the default demo, picked because
each shows multiple Ryngo features in a small footprint:

| Candidate | Why it's good | Trade-offs |
|---|---|---|
| `tiangolo/full-stack-fastapi-template` | FastAPI + SQLModel + a frontend in `/frontend`; 18 routes, multiple layers cleanly separated | Real codebase, cred-positive |
| `vercel/commerce` | Next.js + components + 5 pages; recognizable brand | Less back-end depth |
| **synthetic "Ryngo Bookstore"** | a 30-file fictional Express+Prisma+React app we curate ourselves | Fully controllable; not real, slightly less credible |

**Recommendation:** ship `tiangolo/full-stack-fastapi-template` as
default + `vercel/commerce` and `expressjs/express` as alternates in
the gallery. They're real, well-known, and exercise the layers cleanly.

The IRs are pre-baked at build time so the page loads with the demo
already structured — no clone, no analyze, instant. Stored as JSON,
loaded via `fetch('/demo-irs/<name>.json')` on viewer mount.

When the parser improves (Phase 5.1 tree-sitter, etc.), `npm run
build` re-runs `build-demo-irs.js` and the JSONs update. The demo
stays in lockstep with the live product.

---

## The walkthrough

### Mechanism

Custom — no library. ~150 lines.

```jsx
<Walkthrough
  steps={STEPS}
  onComplete={() => localStorage.setItem("ryngoTourSeen", "1")}
/>
```

Each step:
```js
{
  id: "layers-intro",
  selector: ".rfn-layer-backend",   // CSS selector inside the demo
  position: "right",                 // tooltip position
  title: "Backend layer",
  body: "Every file Ryngo classified as backend code lives here. Routes, env reads, and DB calls are counted automatically.",
  highlight: true,                   // dim everything else
  advance: "click",                  // 'click' | 'auto:Nms' | 'next-button'
}
```

Component:
1. Reads `STEPS[currentStep]`, finds the target via
   `document.querySelector`.
2. Computes tooltip position via `getBoundingClientRect` + the
   declared `position`.
3. Renders a dimmer over the rest of the page (`<div class="walk-mask">`)
   plus a "spotlight" hole around the target's bbox.
4. Tooltip with title / body / "Skip tour" + "Next" buttons.
5. On advance, scrolls the target into view if needed, increments
   step.

### The 8-step tour (for the default demo IR)

| # | Target | Body |
|---|---|---|
| 1 | whole `.react-flow` canvas | "This is your Ryngo map. Every panel is a layer of the stack — Frontend, Backend, Data, Infra. Pan with two fingers, zoom with pinch." |
| 2 | `.rfn-layer-backend .rfn-layer-header` | "Backend. 18 files, 12 routes detected. The numbers come from the analyzer — no human curation." |
| 3 | one `.rfn-layer-data` chip | "Data layer. Prisma schemas and ORM-touching files cluster here. The bundled edge above shows all 47 calls from Backend → Data." |
| 4 | the Layers / Files toggle | "Switch to Files view to see code-level detail — every function with its parameters, types, and return values." |
| 5 | one `.rfn-fn` after toggling | "Each port is a parameter. Color = type. Hover to see the type spelled out. Drag a port to draw a relationship — it'll be saved in `.ryngo/wires.md` for your AI agent to read." |
| 6 | the `?` keyboard help icon | "Cmd-K opens fuzzy search. Type any function or file name, jump straight to it." |
| 7 | the right-click context menu (we trigger it programmatically) | "Right-click any node to mark an intent: refactor, delete, extract, add tests. Each becomes a markdown file in `.ryngo/intents/` your coding agent can pick up." |
| 8 | the URL paste box | "That's the loop. Paste your own GitHub URL above to see your codebase the same way." |

Total time at default pacing: ~35 seconds. Auto-advance per step is
3.5 s; the user can hit "Next" anytime or "Skip tour" to exit.

### When the tour fires

- **Not** automatically on first visit — that's annoying.
- Big "Walk me through it" button next to the demo viewer.
- Tooltip near the button on first visit only: "First time? Take the
  30-second tour →" — dismissible, persists.

---

## Page sections (top to bottom)

### 1. Hero (no fold-line — visible immediately)

```
            [R logomark]   Ryngo
                            
             The map your coding agent is missing.
             
             [Try with your repo →]   [Walk me through it]
             
             ┌──────────────────────────────────────────────┐
             │  [embedded React Flow viewer, 600px tall]    │
             │  Default IR: tiangolo/full-stack-fastapi…    │
             │                                              │
             │  [Layers] [Files]    [config files ☐]        │
             └──────────────────────────────────────────────┘
             
              Examples: [FastAPI]  [Next.js]  [Express]
```

Hero copy is **two lines max** — the tagline + a sub-line. Anything
more wastes the prime real estate.

### 2. Three-step "How it works"

Three short cards, illustrated.

```
1. Paste a GitHub URL.        2. Mark intents.            3. Your AI
   See it as a graph in            Right-click any node:       reads
   seconds. No setup.              refactor / extract /        them.
                                   delete / tests.             Ryngo
                                                               verifies.
```

### 3. Personas

Three columns, no gradients, no icons that look like every SaaS site:

| For PMs | For vibe coders | For engineers |
|---|---|---|
| See the system you own. Ask "what's in scope?" without messaging engineering. Share a link instead of an architecture meeting. | Generate code, mark what should change, hand the marks back to your AI of choice. The loop closes because every annotation is a markdown file your agent reads. | Stop explaining the codebase to PMs and execs. Send them a Ryngo link. They pan around. You get your afternoon back. |

### 4. LLM-native section

```
Ryngo speaks the LLM's language.
─ Stable node ids that round-trip across runs
─ MCP server for Claude Code / Claude Desktop / ChatGPT Apps
─ HTTP MCP at ryngo.ai/mcp for any hosted connector  
─ Plain markdown in .ryngo/ — no schema, no SDK, just files

   We are not a coding agent. We are the map your coding agent is missing.
```

### 5. Examples gallery

Six buttons, each loads a different pre-baked IR into the embedded
viewer:

```
[FastAPI · 18 routes]
[Next.js · 5 pages, 12 API routes]
[Express · real demo app]
[Prisma + tRPC · 8 db models]
[Pure TS lib (zod) · 591 typed functions]
[Notebook ML (nanoGPT) · 6 cells]
```

Click → swap the embedded viewer's IR + camera fit. The examples
showcase different parts of the analyzer (frameworks vs libs vs
notebooks) so visitors see the breadth.

### 6. FAQ

Real questions, terse answers. Aim for 6 max.

- Does Ryngo store my code? No. We clone shallow, build the IR,
  cache the IR, throw the source away.
- Can I run it on a private repo? Self-host the Docker image and point
  it at any git URL it can reach. Hosted private-repo support is
  Phase 9.
- Does it call an LLM? No. Ryngo never runs inference. Your agent
  uses our MCP server to fetch maps, then calls whatever model it's
  paying for.
- Does it work on Go / Rust / Java? Files appear; deep extraction
  requires the language toolchain (planned Phase 5.4–5.8). TypeScript,
  JavaScript, Python, and Jupyter are first-class today.
- How big a repo? 1500 file cap on shallow clone; truncates beyond.
  Targeted at "service-sized" not "monorepo-of-the-quarter."
- Is this open source? The MVP is at github.com/MarshallDoyle/Ryngo.
  Self-hosting is supported; the deployment plan is in
  `docs/HOSTING.md`.

### 7. Footer

`mission · github · docs · contact · ryngo.ai`. No newsletter signup,
no "follow us on X." If you want to follow, the GitHub repo is the
follow.

---

## Performance budget

| Metric | Target |
|---|---|
| HTML size (gzipped) | < 8 KB |
| Critical CSS (inlined) | < 4 KB |
| Above-fold first paint | < 800 ms on a fresh Cloud Run cold start, < 200 ms on warm |
| Demo bundle (lazy) | < 220 KB gzipped (React Flow + nodes + walkthrough) |
| Demo IR JSON | < 80 KB gzipped per IR |
| Lighthouse perf score | ≥ 90 (mobile) |

The demo viewer must NOT block first paint. Strategy:
1. HTML + critical CSS render the hero copy and a placeholder
   skeleton where the viewer will live.
2. After `requestIdleCallback` (or a 200 ms timeout), inject the demo
   viewer bundle.
3. Walkthrough script lazy-loads only when the button is clicked.

---

## Implementation phases

Each phase is independently shippable.

### Phase 4.5.1 — Static landing shell (~2 hours)

- New `mvp/landing/index.html` with hero, How-it-works, personas,
  LLM-native, FAQ, footer. **No React.** Pure HTML + a 30-line
  inline `<script>` for the gallery + theme toggle.
- New `mvp/landing/landing.css` (scoped, doesn't import the app's CSS).
- Update `mvp/server.js` route order: `/api`, `/mcp`, `/app`, `/`.
- Update `vite.config.js` with two entry points (`landing` + `app`).
- Lighthouse pass: ≥ 90.

### Phase 4.5.2 — Embedded demo viewer (~2 hours)

- `mvp/landing/main.js` — mounts a single React component at
  `#demo-viewer-root` that fetches the default demo IR JSON and
  renders the same `nodeTypes` we use in the app.
- `mvp/scripts/build-demo-irs.js` — runs analyzeRepo against three
  curated repos at build time, writes JSONs to
  `mvp/landing/demo-irs/`. Triggered by `npm run build` so demos
  stay current.
- Loads on `requestIdleCallback`, doesn't block hero paint.

### Phase 4.5.3 — Walkthrough (~2 hours)

- `mvp/landing/Walkthrough.jsx` — 150 LOC, no library.
- `mvp/landing/walkthrough-steps.js` — the 8 steps above.
- "Walk me through it" button in the hero.
- localStorage persist `ryngoTourSeen`.

### Phase 4.5.4 — Examples gallery (~1 hour)

- 6 buttons; click swaps the demo viewer's IR via a controlled state
  store.
- Camera animates to fit when IR swaps.
- The button labels are derived from each IR's `stats` so they stay
  honest as the analyzer changes.

### Phase 4.5.5 — SEO + polish (~1 hour)

- `<meta>` tags: description, OG image (a 1200×630 PNG render of the
  default demo viewer — generated by `scripts/build-og-image.js`
  from the same IR).
- `application/ld+json` structured data for the SoftwareApplication
  schema.
- Lazy-loaded the Inter / Manrope webfonts (or fall back to system
  monospace + sans).

Total: **~8 hours of focused work**, distributable across 2–3 ship
cycles. Phase 4.5.1 alone is enough to be deployable as a "coming
soon" page; each subsequent phase adds the live demo, the tour, and
the polish.

---

## When to ship which phase

| Phase | Trigger to ship |
|---|---|
| 4.5.1 (shell) | Once domain + Cloud Run deploy lands (Phase 7.4) |
| 4.5.2 (demo) | When the typed-port viewer is stable enough that visitors won't see broken layouts |
| 4.5.3 (walkthrough) | After 4.5.2 — the tour points at the demo |
| 4.5.4 (gallery) | When we're confident the analyzer handles all 3+ alternate examples without weird artifacts |
| 4.5.5 (SEO) | Right before public announcement |

Don't ship 4.5.1 until 7.4 is live. A landing page at a non-existent
domain is wasted work.

---

## What this plan deliberately does not include

- **Authentication / user accounts.** None on day one.
- **Pricing or billing.** None on day one.
- **A blog / changelog.** Use the GitHub repo's release notes.
- **A "Star us on GitHub" CTA bar.** Annoying.
- **Cookie banner.** No tracking → no banner.
- **A live chat widget.** No.
- **Animated SVGs in the hero.** The product itself is the animation —
  the live demo. Anything else is decoration.
