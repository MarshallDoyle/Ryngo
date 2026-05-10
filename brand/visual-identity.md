# codegraph — Visual Identity Direction

> Status: exploration / pre-lock. Three directions, one recommendation, application sketches, and an explicit illegal-zone. No SVGs in this doc — every visual is described tightly enough that a designer (or an LLM with image tools) can produce it without further briefing.

---

## 0. Brand context

**What codegraph is.** A code-as-typed-graph tool. It parses a repository into a typed graph of definitions, references, calls, types, and imports — and lets humans and machines query that graph. No LLM in the hot path. MIT license. Local-first, fast, deterministic.

**Who it competes with for visual mindshare.**
- **Sourcegraph** — owns deep blue + warm orange, owns "code search at scale," owns enterprise-trust visuals.
- **CodeSee / Sourcetrail** — own literal "code map" visuals (auto-generated diagrams).
- **Linear** — owns electric purple on dark, owns minimalist precision, owns the "design-led dev tool" lane.
- **Vercel** — owns geometric monochrome with a single accent (often black/white).
- **Unsloth** — owns hot pink + dark, owns "fast/OSS/technically dense."
- **LiteLLM** — owns clean blue + breadth-of-integrations look.
- **tree-sitter / ast-grep** — own "syntax tree" visuals (parens, brackets, indented lines).
- **Observability tools (Datadog, Honeycomb, Grafana)** — collectively own "graph with glowing nodes on dark." Touching this is a tax we pay, not a moat we build.

**What we want the brand to feel like.**
1. *Trustworthy infrastructure* — this is something you put in your CI, not a toy.
2. *Technical density* — written by people who know what an AST is.
3. *Quietly fast* — not "BLAZINGLY FAST 🚀", but visibly engineered.
4. *OSS-native* — at home in a README, on a terminal screenshot, on Hacker News.
5. *Not another observability dashboard.* The graph is a substrate, not the product surface.

**Brand voice anchors.** Sourcegraph's developer credibility, Linear's precision, Vercel's restraint, Unsloth's OSS energy — but *none* of their colorways. We need our own claim.

---

## 1. Direction A — "Cartographer"

> The metaphor: a codebase is a territory, and codegraph is the survey crew. Topographic lines, contour shading, latitude grids, lensing. The product doesn't show you "the graph" — it shows you the *terrain* of your code.

### 1.1 Mood and idea

Cartographer leans into the oldest visual language we have for "I have surveyed this complex thing and made it legible." Think USGS topo maps, nautical charts, the cover of a Le Guin paperback, satellite false-color imagery. The graph is implied (contour lines emerge from it) rather than stated.

The temperature is cool — blue-greens, like deep-water bathymetry — with a single warm contour highlight that reads as "the path you asked about." When you query `who calls this function?`, the answer is rendered as a glowing route across a quiet topographic backdrop.

This direction works hardest on the *landing page hero* and on *generated visuals* (graph exports, docs diagrams). It's the most distinctive direction at a glance, but it's also the most expensive to execute — every illustration needs to feel like it came from the same survey office.

### 1.2 Color palette

| Role | Hex | Name | Rationale |
|------|-----|------|-----------|
| Background (dark) | `#0B1F26` | Abyss | Deep teal-black. Readable on OLED, evokes deep-water bathymetry. Distinct from Sourcegraph's `#0F111A` navy and Linear's `#0E0E10` charcoal. |
| Background (light) | `#F4F1E8` | Vellum | Warm off-white, the color of a real survey-office paper. NOT pure white — pure white would push us toward Stripe/Vercel. |
| Primary | `#1F6F7A` | Bathyal | Mid-teal. The "ink" color on the light bg, the "land" color on the dark bg. |
| Accent | `#7FD8C5` | Shoal | Lighter mint-teal. Used for active contour lines, hover states, the "your query" highlight. |
| Warm contrast | `#E8B96A` | Bearing | Muted gold/sextant brass. The single warm hue. Used SPARINGLY — for the matched-result highlight, never for chrome. |
| Neutral text | `#5C6F73` | Slate-Tide | Body copy on Vellum, secondary text on Abyss. |

**Contrast (WCAG AA):**

- `Bathyal #1F6F7A` on `Vellum #F4F1E8` → contrast ratio ~5.6:1 → **AA pass** for normal text, **AAA** for large text.
- `Slate-Tide #5C6F73` on `Vellum #F4F1E8` → ~4.7:1 → **AA pass** for normal text.
- `Vellum #F4F1E8` on `Abyss #0B1F26` → ~13.5:1 → **AAA pass** everywhere.
- `Shoal #7FD8C5` on `Abyss #0B1F26` → ~10.2:1 → **AAA pass**, but reserve for accents — too much teal-on-teal becomes mush.
- `Bearing #E8B96A` on `Abyss #0B1F26` → ~9.4:1 → **AAA pass**. Strong enough for a CTA, but use it as a focal accent, not as a brand-wide button color (otherwise we drift toward Sourcegraph's blue+orange).
- `Bathyal #1F6F7A` on `Abyss #0B1F26` → ~2.0:1 → **fail**. Treat Bathyal as a light-bg color only; on dark, switch to Shoal.

### 1.3 Typography

- **Heading:** **GT America Mono** (or, free fallback: **Berkeley Mono** if licensable, or **JetBrains Mono** as the last resort). The headings being mono-spaced is a deliberate "we are a tool that reads code" signal. Track it slightly negative (`-0.01em`) at large sizes so it doesn't read like a terminal prompt.
- **Body:** **Inter** at 16px base, 1.55 line-height. Inter has the best wide-character coverage for technical writing (math symbols, arrows, brackets) without feeling cold. Use the variable font and sit at weight 420 for body, 600 for emphasis.
- **Mono (code):** **JetBrains Mono** with ligatures *off*. Ligatures are great for personal editors; in marketing screenshots they obscure what's actually being typed. Falls back gracefully on every dev machine.
- **Display alt:** **Söhne** or **National 2** for the rare big editorial headline. Optional — mono headings carry most of the weight.

The pairing rule: mono for headlines and labels, humanist sans for paragraphs, mono with ligatures off for code blocks. Three voices, no overlap.

### 1.4 Logo concepts (5 alternatives)

1. **Contour-C.** A capital `C` formed entirely by stacked topographic contour lines — five or six concentric, irregular ovals that together suggest the silhouette of a `C`. The lines are hairline-weight, never filled. The "C" is implied by the negative space at right; your eye completes the letter. Works as wordmark prefix and as a standalone mark. Tradeoff: contour lines need to render at favicon size — fewer lines, thicker strokes at 16px.
2. **Lens-on-grid.** A perfect circle (the lens) sitting over a faint latitude/longitude grid. Inside the lens, the grid bends — refracted, magnified, the lines curve toward a single bright vertex. The vertex is the only "graph node" in the entire mark. Reads as "we see structure others miss." Risk: any lens-with-thing-inside is one short hop from the Sourcegraph search-magnifier.
3. **Compass-rose-as-graph.** An eight-point compass rose where each point is a small filled dot (a graph node) and the connecting strokes are the rose's spokes. From a distance, it looks like a heraldic compass. Up close, it's a graph. Distinctive, but compasses are very claimed in the dev-tool space (think: shipping/logistics startups).
4. **Layered-island.** Three nested island shapes — like a topo map of a small atoll, viewed from above. Each layer is a different teal. No letter, no node, no lens. Pure "we make territory legible." Works beautifully as a filled icon; struggles when sized below 24px because the nested layers blur.
5. **C-as-survey-stake.** A monolinear `C` whose terminals end in tiny tick marks, like the cross-hairs on a survey transit. Subtle, almost a typographic-only mark — the "logo" is a custom letterform. Easy to use, easy to forget. Best as the wordmark's lead character rather than a standalone icon.

### 1.5 Iconography style

- **Stroke-only**, 1.5px at 24px artboard, no fills.
- **Rounded caps**, **mitered joins** — soft entry, hard turn. This combination feels "drawn with a fine pen" rather than "constructed in Figma."
- **Implicit grid**: every icon resolves to a 24×24 grid with a 2px safe margin. Nothing touches the artboard edge.
- **One accent dot per icon** allowed, in Bearing or Shoal — used to mark "the active thing" (e.g., the cursor, the matched node, the destination point).
- **No gradients** in icons. Gradients are reserved for one place: the landing-page hero illustration.

---

## 2. Direction B — "Inspector"

> The metaphor: codegraph is an x-ray machine for code. The wireframe under the surface. A structural inspection. The aesthetic is a clean terminal at 2 a.m. — black, hairlines, one electric accent, monospaced everything.

### 2.1 Mood and idea

Inspector says *we don't decorate; we reveal*. Where Cartographer renders a beautiful surface, Inspector strips the surface off entirely. Backgrounds are near-black. Type is monospaced. Lines are hairline. The single accent — an electric chartreuse — is used like a highlighter pen: you see it only on the thing the engineer is actively interrogating.

This is the most "developer credibility" direction. It's also the most crowded — Linear, Vercel's docs, Resend, Railway, every new dev-tool YC company, all converge on near-black + accent. Our job is to (a) pick an accent nobody owns yet, and (b) execute the wireframe metaphor with enough specificity that we don't read as "another minimalist dev tool."

### 2.2 Color palette

| Role | Hex | Name | Rationale |
|------|-----|------|-----------|
| Background | `#0A0A0B` | Pitch | Near-black, slightly cool. Avoid pure `#000` — it pins the accent and creates banding on most monitors. |
| Surface 1 | `#141416` | Slab | Card/panel background. ~12% lighter than Pitch. |
| Surface 2 | `#1F1F23` | Rule | Border/divider color. Hairlines are drawn at this value at 1px, never thicker. |
| Text primary | `#ECEDEE` | Bone | Off-white. Pure white on near-black is too high-contrast and tires the eye in long reading sessions. |
| Text secondary | `#8A8D93` | Ash | Mid-gray. AA-passes on Pitch. |
| Accent | `#C8FF3D` | Volt | Electric chartreuse. Owned by almost nobody in dev-tools. Not Vercel green, not Tailwind teal, not Linear purple. |

**Contrast (WCAG AA):**

- `Bone #ECEDEE` on `Pitch #0A0A0B` → ~17.8:1 → **AAA pass** everywhere.
- `Ash #8A8D93` on `Pitch #0A0A0B` → ~5.4:1 → **AA pass** for normal text.
- `Volt #C8FF3D` on `Pitch #0A0A0B` → ~16.2:1 → **AAA pass**. Strong enough to be the CTA color.
- `Volt #C8FF3D` on `Bone #ECEDEE` → ~1.5:1 → **fail**. Volt is a dark-bg-only accent. On light surfaces, demote it to a darker variant: `#7BAA1A` (Volt-Dark) which gets ~4.9:1 on Bone — AA pass.
- `Rule #1F1F23` on `Pitch #0A0A0B` → ~1.4:1 → intentional. This is a subtle hairline, not a text color.

### 2.3 Typography

- **Heading:** **Geist Mono** (or **JetBrains Mono** as fallback). Inspector commits hard — even H1 is monospaced. Track at `-0.02em` for headlines so the mono doesn't feel sparse.
- **Body:** **Geist Sans** (Vercel's open release). It's deliberately neutral — it gets out of the way of the mono headings and the code blocks. If Geist feels too on-the-nose, **Inter** is the safe substitute.
- **Mono (code):** **Berkeley Mono** if budget allows (paid, but its proportions are gorgeous and it's genuinely uncommon). Fallback: **JetBrains Mono** (free) or **IBM Plex Mono** (free, slightly warmer).
- **Numerals:** Tabular figures everywhere. Stats, version numbers, benchmark tables — they must align vertically. Inter, Geist, JetBrains Mono all support `font-feature-settings: "tnum"`.

The pairing rule: mono headings, sans body, mono code. Inspector commits more aggressively to mono than Cartographer does — if Cartographer is "mono for labels," Inspector is "mono for everything that isn't a paragraph."

### 2.4 Logo concepts (5 alternatives)

1. **Wireframe-cube-C.** An isometric cube drawn in pure hairlines (no fills). The front face is missing — it's been cut open, like an architectural section. Inside the cube, a single Volt-colored dot floats. The negative space of the missing face traces a `C`. Reads as "the inside of a structure," matches the x-ray metaphor.
2. **Bracket-graph.** The literal characters `[` and `]` rendered in heavy mono, with a single hairline connecting their inner serifs through empty space — and one Volt dot at the midpoint of the connector. Almost-a-wordmark, almost-a-graph. Highly legible at any size. Risk: tree-sitter / ast-grep already lean on bracket motifs.
3. **Crosshair-node.** A Volt dot at the intersection of two hairline crosshairs (like an inspector's reticle), enclosed in a square frame. Reads as "we point at the exact thing." Easy to miniaturize (works as a 16px favicon). Risk: reticles are common in surveillance/security tooling.
4. **Indented-block-C.** A `C` formed by three stacked horizontal mono brackets at progressive indentation levels, mimicking how nested code looks. The whole mark is built from `>` characters. Reads as "structure of code, abstracted." Distinctive; doesn't really look like anyone else's logo.
5. **Schematic-C.** A `C` drawn as if it were an electrical schematic — short straight segments meeting at right angles, with a tiny resistor-zigzag in the lower curve. The Volt dot sits at one terminal. Plays directly to the "x-ray / schematic" reading. Risk: feels close to electrical-engineering brands rather than software.

### 2.5 Iconography style

- **Hairline strokes**, 1px at 24px, on a 24×24 grid.
- **Square caps**, **mitered joins** — sharp, technical. No softness.
- **Fill: never.** Inspector icons are exclusively line.
- **Volt accent dot or stroke** allowed in exactly one location per icon, marking the "active" element.
- **45° and 90° only.** No arbitrary angles. The whole icon set should feel like an isometric blueprint.
- **Optional: dashed strokes** for "potential" or "indirect" relationships (e.g., a dotted edge between two function nodes).

---

## 3. Direction C — "Constellation"

> The metaphor: a codebase is a constellation — a set of points that, once you know how to read them, form recognizable shapes. The visual language is dots and connecting lines on near-black, with one warm accent. Spare, almost astronomical.

### 3.1 Mood and idea

Constellation is the most metaphorically literal of the three: codegraph builds a graph, and the brand shows graphs. The risk — and we have to confront it head-on — is that *every observability tool on the market* uses dots-and-lines on dark backgrounds. Datadog, Honeycomb, Grafana, every Series-B startup with a tracing product. To win in this lane we cannot just "do graph dots well." We have to commit to a specific dialect.

The dialect we propose: **astronomical, not network-diagram.** The dots are unevenly spaced (real constellations are not grid-aligned). The lines are hair-thin and *not* glowing. The accent is a warm amber — the color of a sodium-lamp star chart at an observatory, not a glowing-blue notification. The whole image should feel printed on dark paper, not rendered on a GPU.

This direction is the most flexible for *generated content* — we can render any user's repo as a constellation and it'll always be on-brand. It's also the easiest to under-execute (any random dot pattern reads on-brand, which means nothing is distinctively on-brand).

### 3.2 Color palette

| Role | Hex | Name | Rationale |
|------|-----|------|-----------|
| Background | `#08090C` | Void | Near-black with a faint blue cast. Not Pitch from direction B — slightly cooler to push us away from Inspector's terminal feel. |
| Surface | `#12141A` | Mantle | Panel/card background. |
| Hairline | `#262A33` | Astrolabe | Faint connector lines between nodes. Drawn at 1px. |
| Text primary | `#E6E8EC` | Starlight | Off-white, slightly warmer than Bone. |
| Text secondary | `#7A8089` | Pewter | Mid-gray, AA on Void. |
| Accent | `#FF8A3D` | Ember | Warm amber. Distinct from Sourcegraph's saturated `#FF5543` orange — Ember is muted, slightly more yellow, more "candle" than "alert." |

**Contrast (WCAG AA):**

- `Starlight #E6E8EC` on `Void #08090C` → ~17.5:1 → **AAA pass**.
- `Pewter #7A8089` on `Void #08090C` → ~4.7:1 → **AA pass** for normal text. Tight — for body copy, prefer Starlight at lower opacity (e.g., 75%) or step Pewter up to `#8A9099`.
- `Ember #FF8A3D` on `Void #08090C` → ~9.6:1 → **AAA pass**.
- `Ember #FF8A3D` on `Starlight #E6E8EC` → ~2.4:1 → **fail**. Ember is a dark-bg-only accent. For light surfaces, use a darker variant `#C25A14` which gets ~4.6:1 on Starlight.
- `Astrolabe #262A33` on `Void #08090C` → ~1.6:1 → intentional. Hairline, not a text color.

The key palette move: **only one warm color**, used sparingly. If you turn off the Ember accent, the whole brand should still hold together as a monochrome.

### 3.3 Typography

- **Heading:** **Söhne Breit** or **National 2** for editorial-feel headlines, **JetBrains Mono** for technical pages. Constellation tolerates mixing — a marketing landing page can use a humanist sans for emotional warmth, while the docs commit to mono.
- **Body:** **Inter** at 16/1.55. Same rationale as Cartographer.
- **Mono (code):** **JetBrains Mono**, ligatures off.
- **Editorial:** **GT Sectra** or **Tiempos** for the rare long-form essay (e.g., a "manifesto" page about why no-LLM matters). Used in italic for pull quotes only; never for body.

### 3.4 Logo concepts (5 alternatives)

1. **Three-node-C.** Three Ember-colored dots arranged at the upper-left, lower-left, and right vertices of an implied `C`. Two Astrolabe hairlines connect upper→lower and upper→right. Your eye completes the curve. Spare, memorable, scales to favicon.
2. **Asterism-C.** Five to seven dots arranged in the rough shape of a `C` (like a real but invented constellation), connected by hairlines. One dot is brighter (Ember) — the "north star." Feels astronomical. Risk: starts to look like a generic "5-star constellation" logo if not executed carefully.
3. **Orbit-node.** A single bold Ember dot at center, ringed by a hairline circle, with three smaller satellite dots on the ring. Reads as "central definition + its references." Maps cleanly to the product's "find references" feature. Risk: orbits are common in atomic/molecular brands.
4. **Dot-grid-C.** A regular 5×5 grid of small dots, with a `C`-shaped subset rendered in Ember while the rest are Astrolabe. The `C` is almost subliminal — you see the grid first, the letter second. Plays well in motion (you can animate Ember dots lighting up).
5. **Single-edge.** Two Ember dots connected by a single hairline. That's the entire mark. The most reductive possible expression of "graph." Pairs with a wordmark; never works standalone above 32px because at large sizes it looks empty rather than restrained.

### 3.5 Iconography style

- **Mixed line + dot.** 1.25px stroke, with optional 2px dots at endpoints or junctions.
- **Round caps and round joins** — softer than Inspector. Constellation's icons should feel hand-placed, not engineered.
- **Ember dot allowed** as a single accent per icon.
- **No isometric perspective.** Constellation icons sit flat on the page. Isometric is Inspector's territory.
- **Variable dot size.** Small dots = secondary nodes; large dots = primary nodes. Use sparingly — at most two sizes in a single icon.

---

## 4. Recommendation: Direction B "Inspector" as primary

### 4.1 Why Inspector wins

We recommend **Inspector** as the locked direction, with elements of Constellation reserved for one-off generative visuals.

**Differentiation against the field.**
- *vs. Sourcegraph (deep blue + warm orange, sans-serif corporate).* We commit harder to mono and lean dark-first. Sourcegraph is a Fortune-500 search tool; codegraph is a CLI you `cargo install` (or equivalent) and ship to CI. The visual gap should be obvious within one second of seeing each landing page side by side.
- *vs. CodeSee (literal map auto-illustrations, soft purples).* Inspector is the opposite aesthetic: structural, austere, no auto-decoration. We don't try to make code "pretty"; we make it inspectable.
- *vs. Linear (electric purple `#5E6AD2`, dark, geometric).* Volt `#C8FF3D` is in a different hue family entirely. Both directions are dark + accent, but the accents don't even sit on the same half of the color wheel. A Volt-on-Pitch button next to a Linear button reads as a different category of product.
- *vs. Vercel (monochrome + black/white).* We have a real accent and we use a monospaced headline voice. Vercel's wordmark is a triangle and a humanist sans; we are angular hairlines and mono.
- *vs. Unsloth (hot pink + dark).* Unsloth screams; Inspector murmurs. Both OSS-coded, but Unsloth's energy is "fast/loud" and ours is "fast/quiet."
- *vs. tree-sitter / ast-grep.* They use bracket-and-paren motifs in their docs. Our wireframe-cube logo direction reads structural without leaning on parens — adjacent ecosystem, distinct identity.

**Why not Cartographer.** Cartographer is the most beautiful of the three and the easiest to fall in love with. It's also the most expensive: every illustration must look like it came from the same survey office, which is a real ongoing cost in time and design taste. For a pre-launch OSS project that needs to ship a README header *this week*, Cartographer is over-budget. We can revisit it as the "marketing site v2" direction once the project has traction.

**Why not Constellation.** Constellation is the most metaphorically natural fit — codegraph literally produces a graph — but the "dots and lines on dark" lane is the most contested visual real estate in dev-tools. Datadog, Honeycomb, Grafana, and a dozen tracing startups have already trained engineers to read that aesthetic as "observability dashboard." We'd be paying a perception tax forever. Borrow Constellation's *generated visuals* (rendering a repo's call graph as a literal star chart in marketing pages and exports) without adopting it as the primary identity.

**Where Inspector might fail, and what we do about it.**
- *"It looks like Linear / Vercel / Resend."* True at a casual glance — dark + accent is a crowded look. Mitigation: (a) Volt is genuinely uncommon as a primary accent in dev-tools, (b) we commit to mono headings (Linear and Vercel use sans), (c) the wireframe-cube logo direction is shape-distinctive in a way most "dark + accent" brands aren't.
- *"Chartreuse is hard to use without looking radioactive."* Volt should be ~5% of any given screen. It's a highlighter, not a wall paint. Codify this in the design tokens.
- *"Mono headings feel cold."* That's the trade we're making. Body copy is humanist sans (Geist Sans / Inter), so paragraphs still read warm. Headlines being mono is a deliberate signal that this tool is for people who read code for a living.

### 4.2 What we keep from the other two directions

- **From Cartographer:** the *Vellum* light-bg variant and *Bearing* warm contrast become the **light theme** for the docs site. So the docs feel like a survey-office annex of the otherwise-dark marketing site. This gives the brand somewhere to breathe that isn't black-on-black.
- **From Constellation:** the *generative graph* aesthetic is reserved for one specific use: rendering a real repo's call graph as a hero illustration. Not as logos. Not as section dividers. Not as wallpaper. One illustration, one place.

---

## 5. Application examples

All examples assume Direction B (Inspector) is locked. Each example is described in enough prose detail that a designer or image model can produce it without extra direction.

### 5.1 Landing page — hero

**Background.** Pure `Pitch #0A0A0B`. No gradient. A faint dot grid at 32px spacing in `Rule #1F1F23` covers the entire viewport — visible only in raking light, like graph paper that's been rained on. The grid never animates. It's a quiet ground, not a feature.

**Hero illustration (right half on desktop, full-width on mobile).** A wireframe isometric rendering of a small section of an actual codebase's call graph. Roughly 30–50 nodes, drawn as small hollow squares (4px). Connector edges drawn at 1px in `Bone #ECEDEE` at 30% opacity, except for one path — five to seven nodes connected end-to-end — rendered in `Volt #C8FF3D` at full opacity. The Volt path is the answer to a query like `who calls authenticate()?`. A small mono caption underneath reads `query: callers(authenticate)` with a blinking Volt cursor at the end. The illustration is static (no motion). Total dimensions: roughly 720×540 inside a 1440×900 hero.

**Headline.** Two lines, mono, weight 600, ~64px on desktop:
```
your codebase
as a typed graph.
```
No exclamation. No "blazing." The period is load-bearing.

**Subhead.** One line, sans (Geist Sans), 18px, `Ash #8A8D93`. ~20 words, factual. Names the inputs (your repo, any language with a tree-sitter grammar) and the output (a graph you can query from CLI, library, or LSP).

**CTAs.** Two buttons. Primary: `Volt #C8FF3D` background, `Pitch #0A0A0B` text, mono label `$ install`. Secondary: transparent, 1px `Rule` border, `Bone` text, mono label `read the docs →`. The arrow is a real Unicode `→`, not a custom SVG.

**Above-the-fold proof line.** Three small mono rows beneath the CTAs, each prefixed with a Volt `>`:
```
> 14 languages supported
> indexes 1M LOC in <30s on a laptop
> no LLM in the hot path
```
Each row's value (the number / phrase) is in `Bone`; the label half is in `Ash`. Tabular figures.

### 5.2 README header banner

**Dimensions.** 1280×320, exported as PNG @2x.

**Composition.** Pitch background. Centered-left, the wordmark `codegraph` in mono (Geist Mono, 600, 56px, `Bone` text, with the leading `c` in `Volt`). Beneath the wordmark, a one-line tagline in sans, 18px, `Ash`: `your codebase as a typed graph`.

**Right side.** A small wireframe-cube logo mark (the recommended logo direction — see §6) in 96×96, hairlines in `Bone`, the single internal dot in `Volt`. The cube floats with no background plate.

**Bottom edge.** A 1px `Rule` hairline runs the full width, broken in three places by tiny Volt tick marks at the 25%, 50%, and 75% positions. Subtle. Reads as a measurement scale.

**No badges in the banner image itself.** Badges (build status, license, version) sit *underneath* the banner in the README markdown, not inside the banner artwork. This keeps the banner from going stale and keeps badge updates one-line edits.

### 5.3 Social card (1200×630, used for OG / Twitter / LinkedIn shares)

**Background.** Pitch, with the same 32px Rule dot-grid at 30% opacity. Top 80px reserved for a subtle Volt-to-transparent gradient (1% intensity, almost imperceptible) — just enough to lift the eye.

**Top-left corner.** Wordmark `codegraph` in mono, 32px, leading `c` in Volt. Minimum 48px padding from edges.

**Center.** A single bold mono headline that varies per shareable page. For the homepage card: `your codebase / as a typed graph.` (two lines, 80px, `Bone`, with the period in Volt). For a blog post card: the post title in 56px mono on three lines max, truncated with an ellipsis in Volt.

**Bottom-left.** Author/source line in 18px sans (Geist Sans), `Ash`: e.g., `codegraph.dev` or `by @author · feb 2026`.

**Bottom-right.** A Volt `→` arrow at 32px. That's the only color in the lower half of the card. It anchors the eye to the implied "click here."

**No illustrations on social cards.** Resist the urge to render a graph here. Social cards are read at thumbnail size in three feeds; type-only is sharper than illustrated.

### 5.4 GitHub repo social preview (1280×640)

GitHub specifically renders this image at the top of the repo when shared. The constraints are different from a generic OG card: it sits *above* the README, so it should feel like the *cover* of the project, not the contents.

**Composition.** Pitch background. Centered, the wireframe-cube logo mark at 240×240, hairlines `Bone`, internal dot `Volt`, with a faint Volt glow at 8px blur, 20% opacity (the only place we permit a glow anywhere in the brand). Beneath the mark, the wordmark in mono at 64px with leading `c` in Volt. Beneath the wordmark, the tagline in sans 24px `Ash`.

**Bottom edge.** A row of three short mono fact-lines, each prefixed `>`, at 16px in `Ash` with values in `Bone`:
```
> mit licensed   > 14 languages   > local first
```

The whole composition sits inside a 1px `Rule` border with a 64px inset on every side, like a bookplate.

### 5.5 Favicon concept

**At 32×32 and above.** The wireframe-cube mark, simplified: front face omitted, hairlines in `Bone`, single internal Volt dot. Background: Pitch with rounded 4px corners (the rounding lives in the file, not in CSS — many platforms ignore CSS).

**At 16×16.** The cube falls apart at this size. Switch to a fallback mark: a solid `Volt` square with a `Pitch` lowercase `c` carved out. Mono letterform. Reads at any size, in any browser tab, in any bookmarks bar. It's the same identity expressed in fewer pixels — same hue, same letter, same restraint.

**Apple touch icon (180×180).** Cube version, on Pitch background, with a 16px corner radius applied at export time. No glow at this size — at 180px, glow looks dated.

**Theme color (`<meta name="theme-color">`).** `#0A0A0B` Pitch. Browser chrome on iOS and Android picks this up; the result is the URL bar matching the site, which is the smallest free polish move available.

### 5.6 CLI / terminal output styling

A note often forgotten in identity decks: **codegraph is a CLI first.** What it prints to a terminal *is part of the brand.*

- Section headers: mono, bold, `Bone` (terminal default).
- Emphasis / matched results: `Volt` (ANSI 191 is a close approximation; if truecolor is available, use the actual hex).
- Errors: a muted red `#FF6B6B` — *not* the full sat error red. Errors should feel firm, not panicked.
- Progress / indices: tabular ASCII, 1px `Rule`-equivalent box-drawing characters (`│ ─ ┌ ┐ └ ┘`). No emoji. No spinners with rocket ships.
- Spinners: a single rotating Braille glyph cycle (`⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`), in `Volt` if truecolor, default-fg otherwise. No fallback to `/ - \ |` — that pattern is louder than necessary.
- `--help` output is the canonical brand-voice surface for the CLI. Use mono, two-column layout, indented with two spaces (never tabs — tab width varies across terminals and ruins alignment). Section headings in `Bone` bold; flag names in `Volt`; flag descriptions in `Ash` (which on a default dark terminal renders as a muted gray, exactly the secondary-text role we want).
- Exit codes are documented in `--help` and consistent: `0` success, `1` user error, `2` internal error, `64`–`78` per `sysexits.h` for tooling-integration friendliness.

### 5.7 Documentation site

The docs are where developers spend the most time, so this is the surface where the brand earns the most trust per square pixel.

**Theme.** Vellum (`#F4F1E8`) light theme by default, with a one-click toggle to Pitch dark. The Vellum theme is the borrowed Cartographer surface — and it's the only place we deliberately mix the two directions. The reason: docs reading sessions are long, often during the day, often on a non-OLED screen. Near-black at noon is a tax.

**Layout.** A 240px left sidebar in `Vellum-2 #EAE6D7`, a centered content column at 760px max-width, and a 220px right rail for an in-page table of contents. Sidebar navigation uses small caps mono labels for section headers; content links are `Bathyal #1F6F7A` (the borrowed Cartographer primary). Hover state is an underline appearing in `Volt-Dark #7BAA1A`, never a color change.

**Code blocks.** A `Pitch` dark surface even on the light docs theme — a deliberate inversion that says "code is rendered in its native habitat." Code uses JetBrains Mono with `Bone` foreground. Syntax highlighting is restrained: keywords in Volt, strings in `#9CCFD8` (a single borrowed cool color from no direction in particular — flagged in §9 as an open question), comments in `Ash` italic, everything else `Bone`. Five colors total in syntax. No more.

**Inline code** (between backticks in body copy) sits on a 4px-padded `Vellum-2` chip with `Bathyal` text. It must look like a quoted token, not like a button.

**Anchor links.** A small `#` glyph in `Volt-Dark`, appearing on hover next to every heading. Click copies the URL to the clipboard. The `#` is mono, never sans, never an icon.

### 5.8 Presentation / talk deck template

A template for conference talks and internal kickoffs. Single 16:9 ratio, Pitch background.

- **Title slide:** Wordmark top-left at 32px; title centered in mono 72px, max two lines; subtitle (talk name, date, venue) in sans 24px `Ash` bottom-left.
- **Content slides:** Mono section-title at top, 36px, prefixed with a Volt `>`. Body content takes the lower two-thirds; never more than 25 words on a single slide.
- **Code slides:** A single full-bleed `Slab` panel containing one block of JetBrains Mono code at 28–32px. The slide title overlays in the upper-left corner with 64px clear space. Highlight a single line in Volt with a left-edge bar, never with a yellow rectangle (Powerpoint cliché).
- **Diagram slides:** Wireframe-only diagrams using the icon style from §2.5. Dashed strokes for indirect relationships, solid for direct. Volt accent on the "thing being explained right now."
- **Closing slide:** Wordmark center, 96px. Below it, a single line in mono 24px: `codegraph.dev`. No "thank you," no "questions?" — those are spoken, not slides.

### 5.9 Stickers and swag

Inspector translates well to single-color die-cut stickers because the wireframe-cube can survive being reduced to one ink.

- **3-inch laptop sticker:** Cube mark only, in white-ink-on-clear-vinyl. The Volt dot becomes a small filled white circle. The whole thing reads at arm's length on a black laptop lid.
- **2-inch round sticker:** Wordmark `codegraph` in mono on Pitch, with a 1px Rule border at 16px inset. The leading `c` is in Volt — printed as a separate spot color, which costs a little more but is the single distinguishing feature.
- **T-shirt:** Wordmark only, centered chest, mono, in either Volt-on-Pitch or Pitch-on-Vellum (the "docs theme" tee). No oversized logo on the back. No drop shadows. No "v1.0" version numbers — clothes outlive versions.
- **Conference banner:** Wordmark top, cube mark center at 480px, single sentence below in mono 36px. Total: three elements, one accent color, one background. Visible across a conference floor at 30 feet.

### 5.10 Error and empty states

Brand identity often dies in the corners — error pages, 404s, "no results" states. We codify them here so they don't.

- **404 page.** Pitch background. Centered, the cube mark *with the Volt dot missing*. Below: mono 32px `404 — node not in graph.` Below that: a single linkable line in `Ash` sans, `back to docs →`. The missing dot is the entire joke; you don't have to explain it.
- **No-results state in CLI.** A single line: `> 0 results.` That's it. No "Try a different query" hint unless the user passed `--verbose`.
- **No-results state in web/UI surfaces.** A muted hairline-cube outline (no Volt dot) in 64px, with a single mono line beneath it in `Ash`: `nothing here yet.` The lowercase is deliberate — capital "Nothing Here Yet" reads as a marketing decision; lowercase reads as a status.
- **Loading states.** Never a spinner that exceeds 1.5 seconds without progress information. After 1.5s, replace the spinner with a determinate progress count: `> indexed 1,247 / ~14,000 nodes (8.9%)`. Tabular figures.

### 5.11 Badges (README and elsewhere)

Badges proliferate; we should have an opinion.

- **Build / CI:** Use shields.io with a custom palette. Background `#1F1F23` (Rule), label text `#8A8D93` (Ash), value text `#C8FF3D` (Volt) when passing, `#FF6B6B` (semantic.error) when failing. Mono font (shields.io supports a `style=for-the-badge` option that approximates this).
- **License:** Volt MIT badge is acceptable but we prefer a neutral Ash treatment — license should be mentioned, not celebrated.
- **Version:** Tabular figures. The version itself in Volt; the `v` prefix in Ash.
- **Maximum 4 badges in the README.** Build, version, license, package count (or downloads). Beyond that the README turns into a Christmas tree.

---

## 6. Logo: the recommended primary mark

Of the five Inspector logo concepts in §2.4, we recommend **#1 Wireframe-cube-C** as the primary mark.

**Why.** It expresses three things simultaneously: (a) *structure* — the cube is hairline-only, the inside is visible, that's the x-ray metaphor literalized; (b) *the letter C* — the missing front face traces a `C` in negative space, so the mark is also a letterform; (c) *the active node* — a single Volt dot inside the cube is the "thing the inspector is examining." Three meanings, one mark. That's the bar for a primary logo.

**Construction.**
- A 1.25px-stroke isometric cube on a 64×64 grid.
- Standard isometric angles (30°/30°/90°).
- Front face omitted; the four edges that *would* form the front face are missing entirely. The remaining eight edges of the cube carry the form.
- Inside, slightly closer to the back-bottom-right corner, a single 4px-diameter Volt dot, filled.
- **No drop shadow. No glow on the cube itself.** The Volt dot may have a 4px Volt glow at 30% opacity in the GitHub social preview only.

**Color uses.**
- On Pitch / Slab dark: hairlines in `Bone`, dot in `Volt`.
- On Vellum (the docs light theme borrowed from Cartographer): hairlines in a darker neutral `#1F1F23`, dot in `Volt-Dark #7BAA1A`.
- Single-color print: hairlines and dot both in `Pitch` (or `Bone` on a dark print substrate). The mark must survive single-color reproduction — that's a real constraint for stickers, embossing, laser-cut metal swag.

**Wordmark pairing.**
- The lockup is: cube mark, 24px gap, `codegraph` wordmark. Vertical center alignment.
- Wordmark is Geist Mono 600, all lowercase, with `-0.02em` tracking, leading `c` in `Volt`.
- A horizontal lockup is the default. A stacked lockup (cube above wordmark) is permitted only at sizes above 200px tall.

**Clear space.** Always at least one cube-width of clear space on every side. Not a guideline, a rule.

**Forbidden manipulations.**
- No rotation. The cube has one canonical orientation.
- No outlining, embossing, beveling, or skewing.
- No filling the cube faces.
- No multi-color treatments beyond the documented (hairline, dot) two-color split.
- No "reversed" version where Volt becomes the hairline and Bone becomes the dot. The accent dot is *always* the smaller of the two ink presences.

---

## 6.5. Motion language

Inspector is a quiet brand. Motion is allowed, but the bar is high: any animation must (a) communicate something, not decorate, and (b) complete within 400ms unless it is genuinely a progress indicator.

**The single deliberate moment on the homepage.** When the hero illustration loads, the Volt path lights up *once* — node by node, left to right, ~50ms per segment, total duration ~300ms. It does not loop. It does not retrigger on scroll. It is a one-shot statement of "this is what a query returns" and then it sits still. If the user reloads the page, they see it again; if they scroll back up, it stays lit.

**Hover states.**
- Buttons: 80ms ease-out on background-color transitions. No scale transforms (no growing buttons).
- Links: underline appears in 100ms; no color change.
- Cards: 1px border darkens from `Rule` to `Bone`, no shadow, no lift. We do not pretend Inspector elements have a third dimension.

**Page transitions.** None. No fade between pages, no view transitions API trickery. Page loads are instant; the brand benefits from feeling fast more than from feeling smooth.

**Cursor effects.** None. No magnetic buttons, no custom cursors, no trailing dots. Anything that hijacks the cursor is on the wrong side of "trust."

**Reduced motion.** All motion respects `prefers-reduced-motion`. The hero illustration, when reduced motion is on, renders with the Volt path already-lit at page load — no animation, same final state. This isn't a graceful degradation; it's a parallel design choice.

**Easing.** Default to `cubic-bezier(0.2, 0.0, 0.0, 1.0)` (a standard "decelerate" curve). Never bounce. Never overshoot. Inspector does not do bounce.

**Frame budget.** Any animation must run at a steady 60fps on a 5-year-old MacBook Air with a Chrome extension cluttered tab. If a hover state stutters at any point, the hover state is wrong, not the laptop.

---

## 6.6. Accessibility commitments

These are not optional and not separate from the brand. The same audience (engineers, often working long hours, often in poorly-lit rooms) needs them to be right.

**Contrast.** Every text/background pair shipped in production must hit WCAG AA at 4.5:1 minimum for normal text, 3:1 for large text (18px+ or 14px bold+). The combinations called out in §2.2 already meet this; deviations require a documented exception.

**Color is never the only signal.** Errors are not just `#FF6B6B` — they are red text *and* a leading `!` glyph *and* a brief label. Volt highlights for matched results in graphs are accompanied by a thicker stroke or a label, not color alone. This protects users with red-green color blindness (~8% of men, ~0.5% of women) and screen readers (which see no color at all).

**Focus rings.** Every interactive element shows a visible focus ring on keyboard navigation: 2px Volt outline, 2px offset from the element. This includes the hero CTAs, every link, and every form field. Removing focus rings is forbidden.

**Type sizing.** Body text is 16px and never smaller. Footnotes and metadata are 14px floor. The "tiny mono caption" pattern (e.g., the `query: callers(authenticate)` line under the hero illustration) is 14px — never 12px.

**Line length.** Body copy is capped at 72ch (~640px depending on font). Anything wider is unreadable in long-form. The docs site explicitly enforces this.

**Headings are headings.** `<h1>` through `<h6>` reflect actual document structure, not visual size. A "small heading" that's actually a `<p>` styled to look small is a screen-reader trap.

**Alternative text.** Every illustration in marketing has an `alt` attribute that describes what the illustration is *of*, not what it looks like. The hero illustration's alt: "A wireframe call graph rendered in light gray, with one path of seven nodes highlighted in chartreuse — the answer to the query 'callers of authenticate.'"

**Keyboard navigation.** Every interactive element on the marketing site is reachable via Tab in a sensible order. The CTAs come before the proof line, which comes before the navigation. The cube mark is not focusable (it's decorative); the wordmark *is* (it links to the homepage).

**Screen-reader-friendly mono.** Mono headings can be misread by some screen readers as data tables. Use semantic HTML (`<h1>`, not `<div role="heading">`) and trust the user's screen-reader settings. Never insert hidden punctuation between letters to "fix" pronunciation.

---

## 6.7. The brand vs. the generative output

A unique tension in codegraph: the *output* of the tool is itself visual (graph diagrams, dependency trees, call paths). The output's visual language must be related to but distinct from the brand's identity. If we rendered every customer's repo in Volt-on-Pitch, the brand would dilute into a thousand near-identical hero images and the output would feel "branded" rather than "informative."

**The output's visual language.**
- Nodes are rendered in `Bone` (or the local theme's text color).
- Edges are rendered in `Ash` at 60% opacity.
- The user's *currently-selected* node and its immediate neighbors are rendered in `Volt`.
- That's the only Volt in the rendered output. The rest of the graph is intentionally low-contrast.
- No background gradients on rendered graphs.
- No glow on nodes.
- Node labels are JetBrains Mono at 12px.

**Why this matters.** A user pasting a codegraph diagram into their internal docs, a Slack message, or a blog post should feel like they're sharing a *technical artifact*, not a *codegraph ad*. The wordmark should appear once, in a small lower-right corner attribution, not on every node.

**Diagram exports.** PNG and SVG, both with a 32px Pitch (or Vellum, depending on theme) padding around the graph and a small `codegraph` wordmark in the lower-right at 12px in `Ash`. The wordmark is removable by users who want to embed cleanly. The default *includes* the wordmark; the polite default is "credit the source."

**Marketing-page graph illustrations vs. real-output graph illustrations.** The hero illustration and product screenshots are real outputs from a real codebase (we propose codegraph's own source as the dogfood). They follow the output styling, not a marketing-styled overlay. If a query returns five highlighted nodes in production, the marketing image shows five highlighted nodes — not seven, because seven would compose better.

---

## 7. Illegal-zone — what we do not do

A brand is also a list of choices we refuse. These are the visuals that, however tempting, would either (a) blur us against a competitor or (b) drag us into a category we don't belong to.

### 7.1 Color combinations to avoid

- **Deep blue + warm orange.** Sourcegraph owns this pairing. Even a different blue + a different orange will read as Sourcegraph at a glance.
- **Electric purple on near-black, especially `#5E6AD2`-adjacent.** Linear's claim. We have to be obviously not-Linear from the homepage hero, not just on the typography page.
- **Bright cyan + bright magenta on black.** Reads as "synthwave / 2018 crypto." Aged poorly.
- **Pure neon green `#00FF00` on pure black.** Reads as "1990s Matrix terminal cosplay." Volt is chartreuse-green, not phosphor-green. The difference is real and load-bearing.
- **Hot pink + black** (Unsloth). They're great. We'd be derivative.
- **Pastel gradients** (purple to blue, blue to green). The "AI startup launching a chatbot in 2024" palette. We are adamantly not that category.

### 7.2 Typography to avoid

- **Comic Sans, obviously.** And its cousins (Patrick Hand, Kalam) — no handwritten fonts anywhere. We are not "approachable AI for everyone."
- **System default sans-serifs as headlines.** Reads as "we forgot to set a font."
- **Slab serifs** (Roboto Slab, Rockwell). They suggest editorial / news / print. We are not a magazine.
- **Display serifs at large sizes** (Playfair, Cormorant). Reads as "fintech rebrand." We are not Stripe.
- **Multiple monospaced fonts mixing** (e.g., Geist Mono headlines + JetBrains Mono code). Pick one mono per surface. The eye notices the inconsistency even if the user can't articulate it.
- **Variable font weight animation.** Tempting; aging fast. Reserve for a single deliberate moment if at all.

### 7.3 Visual motifs to avoid

- **Glowing nodes on dark.** Owned by every observability tool from Datadog to Honeycomb to whichever new tracing startup launched last month. If you find yourself reaching for a 32px-radius blur on a dot, stop.
- **3D rotating graph hero animations.** The "look at our beautiful network!" hero. It's been done; it doesn't communicate; it costs too much performance budget on first paint.
- **Brain / neural-network imagery.** We are explicitly not an LLM tool. Anything that looks like nodes-firing-in-a-brain undermines the "no LLM in the hot path" message.
- **Magnifying glass over code.** Sourcegraph's territory. Even if we use a different lens, the metaphor is rented.
- **Auto-generated codebase maps in the marketing site** (CodeSee's claim). We can render a graph for a docs page; we don't render a marketing-page hero from a real customer's repo as a screenshot. Our brand is the tool, not the output.
- **Terminal screenshots with fake `$ ` prompts containing absurd commands.** Ironic-cute terminal copy ages badly. If we show a terminal, the command must be real, runnable, and reproducible.
- **"Generated with [tool]" decorative AI imagery.** Stock-feel diffusion outputs as backgrounds. If we use illustration, it is hand-directed or generated with explicit art direction; either way, never decoratively.
- **Isometric office scenes with abstracted developers at laptops.** Stripe Press already perfected this look in 2019. We should not be following.
- **Confetti, sparkles, "AI shimmer" gradients.** None of this. Ever.

### 7.4 Vibe pitfalls to avoid

- **"BLAZINGLY FAST 🚀."** Too much energy. We are quietly fast. Speed claims must come with numbers, not adjectives.
- **Manifesto homepages** ("we believe code is..."). Show, don't manifesto. The README should open with `$ install`, not with an essay about software philosophy.
- **Self-serious enterprise mood** (lots of stock photos of glass office buildings, people pointing at monitors). We are an OSS tool. The home is the README, not a sales deck.
- **Excess claims about the "graph"** (calling it a "knowledge graph," a "code intelligence platform," etc.). It's a graph. Use the word once and move on to what it can do.
- **Dark/light theme toggle as a brand feature.** Every dev tool has it. Mention it nowhere; build it everywhere.
- **Animated-on-scroll graph constructions.** Tempting; expensive; aging. The hero illustration is static. If we want motion, it's a single deliberate transition (the Volt path appearing once on page load), not a continuous loop.

### 7.5 OSS/community vibes to *embrace* (anti-illegal-zone)

For balance — these are the things that would feel *more* on-brand the more we lean into them:

- **A real, public benchmark page.** Numbers, methodology, reproducible commands. This is the visual identity of credibility.
- **A README that opens with three lines: install, use, link to docs.** No banner, no badges-soup, no preamble.
- **Hand-written changelog entries** in mono, dated, with the version number in Volt.
- **A `/internals` page** explaining how the parser works, with diagrams that look like the textbook chapter you wished CS 350 had assigned.
- **One Easter egg** somewhere — a hidden command in the CLI, an ASCII cube in `--help`. Restraint about quantity, not quality.

---

## 8. Design tokens (recommendation, ready to ship)

For the team picking this up: here are the tokens that should land in `design/tokens.json` (or wherever the design system lives). All values reflect Direction B with the borrowed Vellum/Bearing pair from Cartographer for the docs light theme.

```
color.bg.dark.0         #0A0A0B   /* Pitch */
color.bg.dark.1         #141416   /* Slab */
color.bg.dark.2         #1F1F23   /* Rule */
color.text.dark.primary #ECEDEE   /* Bone */
color.text.dark.secondary #8A8D93 /* Ash */
color.accent.dark       #C8FF3D   /* Volt */

color.bg.light.0        #F4F1E8   /* Vellum */
color.bg.light.1        #EAE6D7   /* Vellum-2 */
color.text.light.primary #1F1F23  /* Pitch-on-light */
color.text.light.secondary #5C6F73 /* Slate-Tide */
color.accent.light      #7BAA1A   /* Volt-Dark */
color.warm.light        #E8B96A   /* Bearing — emphasis only */

color.semantic.error    #FF6B6B
color.semantic.success  #7BAA1A   /* same as accent.light, deliberate */
color.semantic.warn     #E8B96A   /* same as warm.light, deliberate */

font.heading            "Geist Mono", "JetBrains Mono", monospace
font.body               "Geist Sans", "Inter", system-ui, sans-serif
font.mono               "Berkeley Mono", "JetBrains Mono", "IBM Plex Mono", monospace

font.size.body          16px
font.lh.body            1.55
font.size.h1            64px / 56px / 40px  (desktop / tablet / mobile)
font.lh.h1              1.05
font.tracking.h1        -0.02em

space.0  4px
space.1  8px
space.2  12px
space.3  16px
space.4  24px
space.5  32px
space.6  48px
space.7  64px
space.8  96px

radius.sm  2px
radius.md  4px
radius.lg  8px
radius.full 9999px

stroke.hairline 1px
stroke.icon     1.5px
stroke.bold     2px
```

The semantic color overlap (success ≡ accent.light, warn ≡ warm.light) is intentional. Inspector commits to a small palette; reusing accent for success states keeps the brand from sprouting a half-dozen extra hues.

---

## 9. Open questions / next steps

These are explicitly *not decided* by this document, and would each merit a follow-up:

1. **Wordmark — custom letterform or off-the-shelf?** This document specifies "Geist Mono with leading `c` in Volt," which is a placeholder lockup. A custom-drawn wordmark (with subtly modified terminals on the `c`, `o`, `g`) is worth ~2–3 days of a type designer's time and would pay off forever. Decide before launch.
2. **Mark animation on first paint.** A single deliberate animation — the Volt path lighting up, or the cube rotating into position — is permitted by this doc but not specified. Pick one moment, do it once.
3. **Sticker / swag treatment.** Inspector translates beautifully to die-cut single-color stickers (just the cube + Volt dot). The wordmark needs a separate test — mono lockups can look chunky on small stickers.
4. **Light-theme docs commitment.** This doc proposes Vellum+Bearing as the docs light theme. Validate by mocking up the same docs page in (a) Pitch+Volt and (b) Vellum+Bearing and seeing which one the team actually wants to read at noon.
5. **Naming.** "codegraph" is a placeholder per the brief. If the name changes, every wordmark example here changes too — but the palette, typography, illegal-zone, and logo concepts (which lean on a generic `C` letter) all survive a one-syllable name swap.

---

*End of brand/visual-identity.md.*
