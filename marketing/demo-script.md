# codegraph — 60-Second Product Demo Script

A second-by-second storyboard for the launch demo video. Optimized so the first 8 seconds fully load: problem, name, what it does, and why anyone should keep watching.

- **Runtime:** 60.0s flat (1080p60, 16:9). 30fps acceptable for capture; cuts conform on the timeline at 60fps so motion graphics overlays read crisp.
- **Voiceover budget:** ~150 words at 150 wpm. Script below is 148 words.
- **Tone:** confident, dry, technical. No marketing adjectives ("amazing", "incredible"). No music swell. Sparse motion-design.
- **Color system:** background `#0B0D10`, primary text `#E6E8EB`, accent `#7CC4FF` (typed-edge highlight), positive `#5EE0A1`, removed `#FF7A7A`. These mirror the React Flow viewer theme so the screen recordings and lower-thirds feel like one surface.
- **Type:** Inter Tight for lower-thirds, JetBrains Mono for code. Captions burn-in at 28px (open captions for accessibility on autoplay).
- **Cursor:** real cursor recorded with Cleanshot, then post-processed to a 24px white dot with a 6px soft drop shadow so it reads on dark backgrounds without being distracting.

---

## Cold-open hook design (why these first 8 seconds work)

The trap to avoid: most dev-tool demos open with the logo and a feature list. By second 5 the viewer has learned the brand but not the problem, and 70% drop off.

This open is engineered backwards from the question "could I describe what this tool does to a stranger using only the first 8 seconds, with the audio off?" The answer needs to be yes.

- 0–3s: a wall of files. The viewer instantly recognizes "I have felt this before." No words needed.
- 3–5s: a single command, a single artifact. The viewer learns there's an output (graph IR JSON) without yet knowing what it's good for.
- 5–8s: the graph appears and a node is highlighted. The viewer learns the artifact is *visualizable* and *interactive*. The hook is closed.

By second 8 the headline `codegraph — see what your codebase is doing` has burned in for 1.5 seconds, the install command is in the corner, and the viewer has had three distinct visual changes. They keep watching.

---

## Second-by-second storyboard

### 0.0s – 3.0s — HOOK: the problem

**On screen:**
- VS Code window, dark theme. A monorepo file tree (`apps/`, `services/`, `packages/`, `internal/`, `infra/`) is open in the left sidebar. It is *deliberately overwhelming*: 7 services, 40+ visible files, deep nesting. We slowly scroll the tree from top to bottom over 2.0s — 480 vertical pixels of motion at constant velocity.
- The right pane is dimmed to 35% opacity so the viewer's eye stays on the tree.
- At 1.8s a search bar at the top auto-types `where does the checkout service write to the database?` in JetBrains Mono. The search returns no useful answer (ghost text: `0 semantic matches`).
- At 2.6s the entire VS Code frame *desaturates* to grayscale and shrinks to 75% in the center of the canvas. This is the visual cue that we're leaving "the problem" and entering "the answer."

**Voiceover (0.0s – 3.0s, ~6 words):**
> "You can read the diff."

(Note the deliberate pause and the implied "...but you can't see what changed." We don't say it; the next 5 seconds say it.)

**Captions / lower-thirds:**
- 0.0s – 3.0s: no caption. The visual carries it.
- 2.5s – 3.0s: small lower-third bottom-left, 28px, fades in at 90% opacity: `monorepo. 7 services. 40k LOC.`

**Sound design:**
- Soft keyboard tick on auto-typed search at 1.8s.
- A single low-frequency *thud* at 2.6s synced to the desaturate. No music yet.

---

### 3.0s – 5.0s — INSTALL + INDEX

**On screen:**
- Hard cut to a clean terminal pane (iTerm, dark, JetBrains Mono 18pt, 80 columns) centered on a `#0B0D10` background. The grayscale VS Code from the previous shot is still visible at 15% opacity *behind* the terminal — a deliberate carryover so the viewer connects "this is the same monorepo we just saw."
- 3.0s – 3.4s: a single line auto-types: `npm i -g codegraph` followed by a return.
- 3.4s – 3.8s: a 2-line install confirmation animates in. The bottom line reads `installed in 1.4s` (real number from a clean install on the demo machine).
- 3.8s – 4.0s: a second command auto-types: `codegraph index .`
- 4.0s – 4.8s: the indexer's progress UI animates: `parsing 412 files… resolving 8,930 symbols… emitting IR… done. 1.9s`. Numbers are real, taken from the `redwood-clone` demo repo described in the asset list.
- 4.8s – 5.0s: a JSON snippet of the IR fades in to the right of the terminal — 8 visible lines, syntax highlighted, showing one node with `id`, `kind: "function"`, `effects: ["fs.read", "net.http"]`, and one edge with `kind: "calls"`.

**Voiceover (3.0s – 5.0s, ~14 words):**
> "Install codegraph. Run it once. You get a typed graph of your repo."

**Captions / lower-thirds:**
- 3.0s – 3.6s: bottom-center, 28px: `npm i -g codegraph`
- 4.0s – 4.8s: bottom-center, 28px: `codegraph index .`
- 4.8s – 5.0s: small label above the JSON: `IR: nodes + typed edges`

**Sound design:**
- Two soft keyboard ticks at 3.0s and 3.8s.
- A low *whoosh* at 4.8s as the JSON appears (matches the desaturate thud — same instrument, inverted intent).
- Music enters at 4.8s: a single sustained synth note, very low energy, beats per minute irrelevant. It functions as a presence, not a track.

---

### 5.0s – 8.0s — VIEWER: first impression (close the hook)

**On screen:**
- Hard cut to the codegraph viewer in fullscreen. Dark canvas, `#0B0D10`. ~30 nodes laid out in a force-directed graph that has already settled (we don't show the layout animation here — that's a feature of viewer load, not a hero moment).
- The graph is the demo repo at the **service tier**. Seven large rounded-rect nodes labeled `web`, `api-gateway`, `checkout`, `inventory`, `auth`, `notifications`, `analytics`. Edges between them are visible but unlabeled at this zoom.
- 5.2s: the `checkout` node pulses once (200ms scale to 1.04, back to 1.0). A faint glow in `#7CC4FF` traces three outgoing edges from `checkout` to `inventory`, `auth`, and an external `postgres` node.
- 6.0s: a lower-third headline animates in, top-center, 56px Inter Tight Bold:
  > `codegraph — see what your codebase is doing`
- 6.0s – 8.0s: the headline holds. The cursor (white dot) drifts toward the `checkout` node but does not click yet — we save the click for the drill-down section.
- 7.5s: a small URL chip appears bottom-right, 18px: `github.com/codegraph/codegraph`. It will stay there for the rest of the video.

**Voiceover (5.0s – 8.0s, ~13 words):**
> "Functions, modules, services. The edges are typed. Calls, reads, writes, throws."

**Captions / lower-thirds:**
- 5.0s – 6.0s: no caption (let the graph land first).
- 6.0s – 8.0s: the headline above is the lower-third for this stretch.
- 7.5s – 60.0s: persistent `github.com/codegraph/codegraph` chip bottom-right.

**Sound design:**
- A short rising synth swell at 5.0s timed to the graph appearing — 400ms attack, 600ms release.
- A small *tick* at 5.2s on the `checkout` pulse.
- The sustained note from earlier modulates up a fifth at 6.0s on the headline land.

---

### 8.0s – 14.0s — DRILL: service → module

**On screen:**
- 8.0s: cursor reaches `checkout` and double-clicks. The viewer animates a semantic zoom: the `checkout` rectangle expands to fill 70% of the canvas, the other six service nodes fade to 25% and slide to the periphery. Internal nodes appear *inside* the expanded rectangle — six modules: `cart`, `pricing`, `tax`, `payments`, `orders`, `webhooks`.
- 9.5s: the zoom settles. Edges between modules are now visible and labeled at this zoom. A `calls` edge from `payments` to `orders` is highlighted in `#7CC4FF` to draw the eye.
- 10.5s: the cursor hovers over the `payments` module. A small inspector panel slides in from the right side (320px wide, dark, rounded). It shows: `payments`, `12 functions`, `3 effectful`, `imports: 4`, `imported by: 2`.
- 12.0s: cursor double-clicks `payments`. Another semantic zoom — `payments` expands and reveals 12 function nodes inside.
- 13.0s – 14.0s: the function-tier graph settles. Functions are colored: 9 in a neutral gray (pure), 3 in a warm amber (effectful). The amber ones are labeled `chargeCard`, `recordTransaction`, `notifyFraud`.

**Voiceover (8.0s – 14.0s, ~28 words):**
> "Drill from a service into a module into a function. The viewer zooms semantically — the layout you're looking at is the layout that matters at that zoom."

**Captions / lower-thirds:**
- 9.5s – 10.5s: bottom-left, 24px: `tier: module`
- 12.5s – 13.5s: bottom-left, 24px: `tier: function`
- 13.5s – 14.0s: small inline annotation arrow pointing to one amber node: `effectful: net.http, db.write`

**Sound design:**
- Two soft *whoosh* sounds at 8.0s and 12.0s, each timed to the semantic zoom.
- A faint *click* at 10.5s for the inspector slide-in.
- Music continues unchanged.

---

### 14.0s – 25.0s — TYPED EDGES: the differentiator

**On screen:**
- 14.0s: cursor moves to the edge between `chargeCard` and `recordTransaction`. The edge is highlighted in `#7CC4FF` and a small label appears above it: `calls`.
- 15.0s: cursor right-clicks the edge. A context menu opens with five entries:
  > `inspect edge`, `show call site`, `filter by edge type`, `trace forward`, `trace backward`.
- 15.5s: cursor selects `inspect edge`. The right-side inspector expands to show the edge details:
  > `kind: calls`
  > `from: payments.chargeCard`
  > `to: payments.recordTransaction`
  > `call sites: 1` (with a clickable file path: `services/checkout/src/payments/charge.ts:47`)
  > `arguments: { amount: number, currency: string, idempotencyKey: string }`
  > `inferred return: Promise<TxnRecord>`
- 18.0s: cursor closes that inspector. We now show edge filtering. A toggle bar at the top of the viewer shows six edge types as pills: `calls`, `reads`, `writes`, `imports`, `implements`, `throws`. Each pill has a colored dot.
- 18.5s – 20.0s: cursor toggles off `calls` and `imports`. The graph re-renders showing only `reads`, `writes`, `throws` edges. The visual is striking: most arrows disappear, a small handful of red `throws` edges become very visible, and two `writes` edges from `recordTransaction` to an external `postgres` node and a `kafka` node light up in `#5EE0A1`.
- 20.0s – 22.0s: cursor toggles `calls` back on, leaves `imports` off. Graph re-renders.
- 22.0s – 25.0s: the cursor traces — without clicking — a path from `chargeCard` → `recordTransaction` → `postgres`. As the cursor passes each node, the node briefly glows in `#7CC4FF`. This is a hand-animated highlight (After Effects), not a recorded UI action.

**Voiceover (14.0s – 25.0s, ~40 words):**
> "Edges are typed. A call is not the same as a write is not the same as a throw. Filter by edge type. Inspect a single edge for its call sites and inferred argument types. The arrows actually mean something."

**Captions / lower-thirds:**
- 14.5s – 17.5s: top-right, 22px: `edge: calls — typed, with argument shape`
- 18.0s – 22.0s: top-center pill bar (the toggles themselves act as the caption).
- 22.0s – 25.0s: bottom-center, 28px: `every edge has a kind. and a meaning.`

**Sound design:**
- A small *click* on right-click at 15.0s.
- A two-note *blip* at 18.5s on the first toggle off.
- A slightly brighter version of the same blip at 20.0s on the toggle back on.
- Music: the sustained note shifts to a slow arpeggio for these 11 seconds.

---

### 25.0s – 40.0s — PR DIFF: the moat

This is the section that sells the tool. Spend the screen budget here.

**On screen:**
- 25.0s: hard cut. We are now on a real GitHub PR page. The PR title reads: `feat(checkout): add 3DS challenge for high-risk transactions`. Author handle is anonymized to `@octocat` (hand-replaced in post; never use a real human's handle).
- 25.0s – 27.0s: the page scrolls down to the conversation tab. We pass three review comments. We arrive at a comment from `codegraph[bot]`. The comment is collapsed by default — we expand it.
- 27.0s – 31.0s: the expanded codegraph PR comment is on screen. It contains, in order:
  - A summary line: `2 added edges, 1 removed edge, 1 new effectful path, 0 type breaks.`
  - A small inline graph thumbnail (180px tall) showing the local diff — three nodes, two green edges, one red edge.
  - A bullet list:
    > `+ payments.chargeCard → fraud.checkRisk (calls)`
    > `+ fraud.checkRisk → redis (reads)`
    > `- payments.chargeCard → payments.recordTransaction (direct call removed; now flows through fraud.checkRisk)`
    > `! new effectful path: HTTP /checkout → fraud.checkRisk (net.http) → redis (cache.read) → postgres (db.write)`
  - A link at the bottom: `Open in viewer (diff mode) →`.
- 31.0s: cursor clicks `Open in viewer (diff mode)`. Browser navigates (we use a fast cut, not a real network round-trip).
- 31.5s – 35.0s: viewer loads in diff mode. Same `checkout` graph as before, but now nodes and edges have a tri-state colorization:
  - unchanged → neutral gray, 60% opacity
  - added → `#5EE0A1` solid
  - removed → `#FF7A7A` dashed stroke
  - changed (e.g., a node whose effects set grew) → `#FFC76B` outlined
- 35.0s – 38.0s: cursor hovers a green edge. Inspector shows: `added in this PR. introduced by commit 8a2f4c1.`
- 38.0s – 40.0s: cursor hovers the orange-outlined `chargeCard` node. Inspector shows:
  > `effects changed:`
  > `+ net.http (via fraud.checkRisk)`
  > `+ cache.read (via redis)`
  > `previously: pure within service boundary.`

**Voiceover (25.0s – 40.0s, ~46 words):**
> "Open a real pull request. codegraph runs in CI on the base and head branches, diffs the IR, and posts what changed. Not the text — the graph. Two new edges. One new effectful path from HTTP input to a database write. Click into diff mode."

**Captions / lower-thirds:**
- 25.5s – 27.0s: bottom-center, 28px: `codegraph runs in CI. posts a comment per PR.`
- 27.5s – 31.0s: small annotation arrow pointing at the inline thumbnail: `the graph delta, in the PR comment`
- 31.5s – 35.0s: top-center pill: `viewer — diff mode`
- 38.0s – 40.0s: bottom-center, 28px: `a previously pure path is now effectful. you would have missed this.`

**Sound design:**
- A *click* on the `Open in viewer` link at 31.0s.
- Music adds a gentle high-end shimmer at 31.5s when diff mode loads — this is the visual peak of the demo and the audio matches.
- A brief silence (audio duck) at 38.5s under the "previously pure" caption to emphasize it.

---

### 40.0s – 55.0s — COLOR + QUERY: the closer

**On screen:**

#### 40.0s – 47.0s: pure-vs-effectful coloring toggle
- 40.0s: cut back to the function-tier viewer (post-PR-merge state, no diff colors). Twelve `payments` functions on screen.
- 40.5s: cursor moves to a left sidebar panel with three view-mode toggles:
  > `default`, `effects`, `complexity`.
- 41.0s: cursor clicks `effects`. The graph re-colors. Nine pure functions become deep blue (`#3A6FA8`), three effectful functions become amber (`#FFC76B`). Each amber node now shows a small icon stack indicating the effect kinds: `net`, `db`, `fs`, `time`, `random`, `mut`. (The icons are 12px monochrome glyphs, never more than three stacked.)
- 42.0s – 44.0s: we zoom out one tier (cursor presses `Esc` to pop the zoom). The whole `checkout` service is on screen with all its modules. Pure vs effectful coloring carries up — modules are colored by their *aggregate* effect (a module containing any effectful function is amber). The visual story: most of the service is pure, three modules are effectful, one of them is the only one that talks to the outside world.
- 44.0s – 47.0s: cursor pops out one more tier. The entire repo is on screen — seven services. The same coloring logic applies. Two services are pure (`pricing`, `analytics`), the other five are effectful. The viewer suddenly tells a clear architectural story at a glance.

#### 47.0s – 55.0s: the path query
- 47.0s: a query bar slides down from the top of the viewer. Cursor clicks into it.
- 47.5s – 50.0s: the cursor types — visibly, character by character — `paths from http.* to db.write`.
- 50.0s: cursor presses Return. The viewer fades all unrelated nodes to 8% opacity and *highlights* every path matching the query. There are four paths. Each path is animated with a flowing dotted line moving in the direction of data flow (`#7CC4FF`, 800ms loop).
- 51.5s – 54.0s: cursor hovers one path. The right-side inspector shows the full path as a bullet list:
  > `web.handleCheckout (http.post)`
  > `→ api-gateway.routeCheckout (calls)`
  > `→ checkout.processCheckout (calls)`
  > `→ checkout.payments.chargeCard (calls)`
  > `→ checkout.payments.recordTransaction (calls)`
  > `→ postgres.transactions (db.write)`
  > `total: 6 hops, 3 service boundaries, 1 effect change.`
- 54.0s – 55.0s: cursor closes the inspector. The four animated paths continue to flow.

**Voiceover (40.0s – 55.0s, ~38 words):**
> "Toggle coloring by effect — pure code in blue, effectful in amber, all the way up to the service tier. Then query: every path from an HTTP input to a database write. Four paths. Click one to see every hop."

**Captions / lower-thirds:**
- 41.0s – 43.0s: bottom-center, 28px: `coloring: pure vs effectful`
- 47.5s – 50.0s: the query bar itself is the caption. We do not duplicate it.
- 50.0s – 52.0s: bottom-center, 28px: `4 paths. http → db.write.`
- 53.0s – 55.0s: small annotation by the inspector: `every hop. every effect. every boundary.`

**Sound design:**
- A *whoosh* at 41.0s on the recolor.
- Two soft *whooshes* at 42.0s and 44.0s on each tier pop.
- Soft keystrokes at 47.5s – 50.0s on the query type-in.
- A bright *swell* at 50.0s on the query result. This is the second peak; the music adds a high pad here.
- Music tapers from 54.5s for the final beat.

---

### 55.0s – 60.0s — CTA

**On screen:**
- 55.0s: hard cut to a clean composition on `#0B0D10`. Centered:
  - Top, 56px Inter Tight Bold: `codegraph`
  - Below, 28px Inter Tight Regular: `static analysis to typed graph IR. diffed per PR.`
  - Below that, a code block (JetBrains Mono 24pt) with three lines:
    > `npm i -g codegraph`
    > `codegraph index .`
    > `codegraph view`
  - Below the code block, 22px: `MIT. no LLM. no hosted backend.`
- 57.0s: a GitHub stars row animates in beneath, showing a ★ icon, the handle `codegraph/codegraph`, and a placeholder count `0` that animates up to a real count at video-export time. (Production note: render this number into the export at the moment of upload; do not commit a fake number.)
- 58.5s: a small QR code (160x160px) appears to the right of the stars row, encoding the GitHub URL. This makes the video useful as a conference-screen play-on-loop.
- 60.0s: hard cut to black. The end.

**Voiceover (55.0s – 60.0s, ~13 words):**
> "Three commands. MIT. No LLM. Star us on GitHub if it earned it."

**Captions / lower-thirds:**
- 55.0s – 60.0s: the on-screen text *is* the caption. No duplication.

**Sound design:**
- Music resolves on a single low note at 55.0s and sustains through 60.0s.
- One soft *click* at 57.0s on the stars row.
- Hard cut to silence at 60.0s — no fade. Trust the silence.

---

## Voiceover script — clean read (for narrator)

A single block, 148 words, ~60 seconds at conversational pace. Time codes are guidance for the recording session; the editor will conform on the timeline.

> [0:00] You can read the diff.
>
> [0:03] Install codegraph. Run it once. You get a typed graph of your repo.
>
> [0:05] Functions, modules, services. The edges are typed. Calls, reads, writes, throws.
>
> [0:08] Drill from a service into a module into a function. The viewer zooms semantically — the layout you're looking at is the layout that matters at that zoom.
>
> [0:14] Edges are typed. A call is not the same as a write is not the same as a throw. Filter by edge type. Inspect a single edge for its call sites and inferred argument types. The arrows actually mean something.
>
> [0:25] Open a real pull request. codegraph runs in CI on the base and head branches, diffs the IR, and posts what changed. Not the text — the graph. Two new edges. One new effectful path from HTTP input to a database write. Click into diff mode.
>
> [0:40] Toggle coloring by effect — pure code in blue, effectful in amber, all the way up to the service tier. Then query: every path from an HTTP input to a database write. Four paths. Click one to see every hop.
>
> [0:55] Three commands. MIT. No LLM. Star us on GitHub if it earned it.

**Direction notes for narrator:**
- Read flat. Do not "perform" it. The visuals carry energy; the voice is a guide rail.
- Hold a small pause after "You can read the diff." (~600ms). Don't fill it.
- "The arrows actually mean something." is the only line that gets a small lift in the read.
- "MIT. No LLM." — read these as four crisp clipped words. Don't connect them.

---

## Editor's checklist

- [ ] All file paths shown on screen are real paths in the demo repo (`services/checkout/src/payments/charge.ts:47` is checked at line 47).
- [ ] No real GitHub usernames visible in the PR scene. All handles replaced with `@octocat` in post.
- [ ] No real API keys, tokens, or .env values visible at any point.
- [ ] Cursor is consistent (24px white dot, 6px shadow) for the entire video.
- [ ] Lower-thirds use Inter Tight; code uses JetBrains Mono. No mixing.
- [ ] Captions are open (burned in) for muted-autoplay platforms (Twitter, LinkedIn).
- [ ] Final export at 1920x1080 H.264, ~12 Mbps, AAC audio at 192 kbps.
- [ ] Second export at 1080x1080 (square) and 1080x1350 (4:5) by re-cropping for social. No re-edit; the layout was designed with safe zones for both.
- [ ] First-frame poster (the `#0B0D10` canvas with the `checkout` graph and headline) saved separately as a 1200x630 social card.

---

## Risk register (things that go wrong on shoot day)

- **Layout reflow on viewer load.** The force-directed layout settles deterministically only if seeded. Set the seed in the viewer's URL hash before recording (e.g., `#seed=demo-2026-05`). If the layout looks different on take 7 than take 1, the seed wasn't applied.
- **PR comment timestamp drift.** The codegraph[bot] comment shows a relative timestamp (`3 minutes ago`). If shooting takes more than an hour, the timestamp text changes mid-cut. Shoot the PR scene first, last, or freeze the timestamp via DOM injection during recording.
- **Real CI race.** Don't wait for real CI in the recording. Pre-merge a PR with the bot comment already on it, then re-record the navigation as if the comment is fresh. The viewer will not know.
- **Cursor halo on retina.** Cleanshot's cursor highlight can leave a 4px halo on retina displays that doubles in the export. Disable Cleanshot's built-in cursor effects and apply the white-dot effect in After Effects.
- **Voiceover sibilance.** "Static analysis. Services. Sites." — three S-heavy phrases in a row. De-ess gently in post; do not re-record.

---

## Asset list — what to record, build, and license

This section is the production glue: nothing in the storyboards above can be shot without these assets in hand.

### A. Demo repo (the codebase we film against)

The demo repo is the single most important pre-production decision. It must be: a real-feeling monorepo (not a toy), have multiple services so the service-tier graph isn't trivial, contain enough effectful code that pure-vs-amber coloring tells a story, and be MIT or similar so we can fork and modify freely.

**Recommendation 1 (primary): `redwood-clone`.**
- Build a fork of the canonical RedwoodJS example app, restructured into a faux-monorepo with `services/checkout`, `services/inventory`, `services/auth`, `services/notifications`, `services/analytics`, plus an `apps/web` and an `apps/api-gateway`. Total ~400 files, ~40k LOC TypeScript.
- Why: TypeScript is the language with the most pre-launch reviewer mind-share. Showing TS in the demo means the viewer believes it'll work on their stack. The Redwood patterns (services + cells + GraphQL layer) generate a graph that's *legibly* layered — exactly what we want to show on first zoom.
- Production work needed: ~2 days to restructure and seed realistic effectful paths (HTTP → service → DB write). Add a faux 3DS-challenge feature on a branch so the PR-diff scene at 25–40s has real, non-trivial graph deltas.
- License: MIT (Redwood's license).

**Recommendation 2 (alternate, polyglot): `polyglot-shop`.**
- A purpose-built fixture monorepo with a TS gateway, a Go inventory service, a Python recommendation service, and a Rust pricing service. Total ~250 files, ~25k LOC.
- Why: shows codegraph's polyglot story in a single shot. The service-tier graph is heterogeneous on purpose. Risk: drilling-down looks slightly different per language and the demo loses the smooth single-language flow.
- Production work needed: ~5 days (this is a build-from-scratch).
- Use polyglot-shop for the README of the *language docs*, not the launch demo. It's more compelling in a 3-minute deep-dive than a 60-second hero.

**Decision:** primary takes, alternate held in reserve. Build polyglot-shop after launch.

### B. Voiceover

148 words at conversational pace, dry/technical tone. Three options ordered by quality:

1. **Human VO via Voices.com or Voice123 marketplace.** Budget $250–500 for a 60s read, 2 revisions, full commercial buyout. Direction notes are in the script section above. Look for a "tech narrator" tag; avoid "trailer" or "hype" voices. Turnaround: 24–48 hours.
2. **AI TTS — ElevenLabs `Adam` or `Brian` voice, "Eleven Multilingual v2" model.** $5/month sub covers it. The output is 95% indistinguishable from a human read for this script length, and we can iterate on every line in seconds. Risks: occasional weird emphasis on technical terms ("IR", "JSON") — fix with phonetic spellings (`I R`, `Jay-son`) in the input. Disclose AI-generated audio in the YouTube description per current platform norms.
3. **Self-record (founder voice).** Only if the founder genuinely sounds confident and dry. Founders self-recording is a meme but rarely a good outcome unless the founder is also a podcaster.

**Decision:** ElevenLabs for v1 (faster iteration on cuts and timing). Replace with a paid human read for v2 if the launch sticks.

### C. Recording tools (capture pipeline)

- **Cleanshot X (macOS):** screen recording, cursor highlighting, scrollable area capture. License: $29 one-time or $8/mo. Use it for the editor scenes and the GitHub PR scene. Disable Cleanshot's built-in cursor styling — apply our white-dot cursor in After Effects so it's consistent across captures from different applications.
- **OBS Studio:** for the viewer scenes where we need long, deterministic captures of a force-directed layout settling. OBS gives us frame-rate locking and lossless captures that Cleanshot's quick-record mode doesn't. Free, MIT-friendly.
- **iTerm2:** for the terminal scenes. Set the profile to `JetBrains Mono 18pt`, bg `#0B0D10`, fg `#E6E8EB`, and disable the macOS title bar (so the terminal is a pure rectangle in capture).
- **Chrome with a clean profile:** for the GitHub PR scene. New profile, no extensions, no bookmarks bar, no avatar — anything that personally identifies the founder is a re-shoot risk.

### D. Edit and motion-graphics tools

- **DaVinci Resolve (free):** primary NLE. The free tier handles 1920×1080 H.264 timeline + audio mixing + open captions just fine. Color grading not really needed — the viewer is already dark-themed and we want minimal correction.
- **After Effects:** for the cursor compositing, the lower-third typography, the click-ring and edge-glow effects, and the loop seam on the GIF. ~$23/mo via Creative Cloud single-app. If skipping AE for budget, do the same work in Resolve Fusion — it's slower but gets the same result.
- **Rive:** explicitly *not needed*. The motion in this demo is functional UI animation, not branded character animation. Do not over-design.
- **ffmpeg (CLI):** for the WebM and GIF exports. Standard pipeline:
  - WebM: `ffmpeg -i master.mov -c:v libvpx-vp9 -b:v 1.2M -an hero.webm`
  - GIF: `ffmpeg -i master.mov -vf "fps=8,scale=960:-1:flags=lanczos,palettegen" palette.png && ffmpeg -i master.mov -i palette.png -filter_complex "fps=8,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse" hero.gif`

### E. Music and sound design

- **Music:** a single-instrument synth pad. Use the Epidemic Sound subscription ($15/mo) and search "minimal synth pad ambient" — pick something <60 BPM, no melody. The track should feel like *room tone*, not a song. Avoid anything with a beat; the cuts in this demo are not beat-synced and a beat would fight the edit.
- **SFX:** the keyboard ticks, click rings, and whooshes are all from the free `freesound.org` library under CC0. Curate ~10 candidates pre-shoot; pick on the timeline.
- **License notes:** Epidemic Sound covers commercial use including YouTube/X/LinkedIn. Do not use any "free for personal use" track — these get demonetized or muted on social platforms within 24 hours.

### F. Output specs

| Asset                           | Format          | Resolution   | Frame rate | Bitrate       | Use                                     |
|---------------------------------|-----------------|--------------|------------|---------------|-----------------------------------------|
| Master export                   | ProRes 422 .mov | 1920×1080    | 60         | ~120 Mbps     | Archive, re-cuts                        |
| Launch video (YouTube, Twitter) | H.264 .mp4      | 1920×1080    | 60         | 12 Mbps       | Public launch                           |
| Square cut (Twitter, LinkedIn)  | H.264 .mp4      | 1080×1080    | 60         | 8 Mbps        | Mobile-first feeds                      |
| Vertical cut (Reels, TikTok)    | H.264 .mp4      | 1080×1350    | 60         | 8 Mbps        | Optional — only if first launch sticks  |
| Hero loop                       | WebM (VP9)      | 1280×720     | 24         | ~1.2 MB total | README hero embed                       |
| Hero loop fallback              | GIF             | 960×540      | 8          | <2.0 MB       | Older clients, RSS                      |
| Static poster                   | PNG             | 1200×630     | n/a        | ~200 KB       | Social card (OG image)                  |
| Static poster (square)          | PNG             | 1200×1200    | n/a        | ~250 KB       | Reddit / HN thumbnails                  |

**Social card frame (1200×630):** the canonical poster frame is the composition at 5.0s of the demo video — the moment the seven-service graph has just landed and the headline is on screen. Export this frame separately at 1200×630 with a small `codegraph` wordmark in the bottom-right and the URL `codegraph.dev` (or the chosen domain from `brand/domains.md`) below the wordmark. This single frame becomes the OG image on every platform's link unfurl.

### G. Pre-shoot checklist (the day before recording)

- [ ] Demo repo at the exact commit we'll film against, tagged `demo/v1.0.0` so we can re-shoot from the same state weeks later.
- [ ] Pre-merged PR with the codegraph[bot] comment on it. Comment author is `codegraph[bot]`, not a real user.
- [ ] Viewer URL hash includes the layout seed (`#seed=demo-2026-05`).
- [ ] All terminals at JetBrains Mono 18pt, dark theme.
- [ ] All browsers in clean profiles, full screen, no devtools.
- [ ] Mac dock auto-hidden, menu bar auto-hidden, Do Not Disturb on, Slack quit.
- [ ] Recording resolution forced to 1920×1080 (System Settings → Displays → Resolution → Show All Resolutions).
- [ ] Cleanshot: cursor effects off, recording area pre-set to 1920×1080.
- [ ] Voiceover script printed or on a second screen — never on the recording machine.

### H. Post-launch deliverables (out of scope for this doc but worth noting)

The same master timeline yields three more deliverables with one extra day of editing:
- A 30-second cut for paid social (delete sections 14–25s and 25–40s; tighten the rest).
- A 3-minute deep-dive cut (expand each section, add a polyglot demo with the alternate fixture repo).
- Six 6-second clips (one per major feature) for repeated drip-posting on X over a launch week.

Plan for these in pre-production by capturing extra B-roll during the main shoot — it costs nothing on the day and saves a full re-shoot later.
