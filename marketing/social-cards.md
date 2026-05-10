# plinth — Social Cards

> Status: ship-ready copy + visual brief. Locked name: **Plinth** (per `brand/decision.md`).
> Three cards: 1200×630 OG (Open Graph / LinkedIn / Slack unfurl), 1200×675 Twitter/X large card, 800×800 Bluesky/Mastodon square.
> Brand carry-forward: `brand/visual-identity.md` Direction B "Inspector" — Pitch `#0A0A0B` background, Volt `#C8FF3D` accent, Bone `#ECEDEE` text, Geist Mono headings, Geist Sans body. No image generation in this file — visual concepts only.

---

## Shared rules across all three cards

### Type-only, no illustrations

Per `brand/visual-identity.md` §5.3: *"Resist the urge to render a graph here. Social cards are read at thumbnail size in three feeds; type-only is sharper than illustrated."* Hold the line. No graph rendering, no logo + screenshot collage, no annotated UI capture. Type and one mark.

### Color discipline

- Background: `Pitch #0A0A0B`. Solid. No gradient anywhere.
- Headline: `Bone #ECEDEE`.
- Sub-text and metadata: `Ash #8A8D93`.
- Accent: `Volt #C8FF3D`. Used for ≤5% of card area. The headline period, the leading `p` in the wordmark, and the trailing arrow — that is the Volt budget.
- One subtle anchor: a 32px dot grid in `Rule #1F1F23` at 30% opacity covers the full card. Not animated. Just-visible. Looks like graph paper rained on.

### Type stack

- Headline: Geist Mono 600, with `-0.02em` tracking.
- Wordmark: Geist Mono 600, lowercase, with the leading `p` in `Volt`.
- Body / attribution: Geist Sans 420 weight, in `Ash`.

### Illegal-zone (carry from `brand/visual-identity.md` §7)

Forbidden on every card:

- Any blue-to-purple or purple-to-pink gradient (the AI-tool palette).
- Any glow on text, dots, or borders.
- Any pseudo-3D rotation, particle effects, or "shimmer."
- Any decorative diffusion-model background.
- Any "BLAZINGLY FAST" / rocket / sparkle iconography.
- Any "Generated with Plinth" stamp on user-shareable cards (the wordmark already does that work).

### Wordmark placement is consistent

Top-left in every card, 48px inset from the edges. `plinth` lowercase Geist Mono 600 at 32px, leading `p` in `Volt`. This consistency is what makes the cards recognizable as a set when they appear in different feeds.

### Bottom-right Volt arrow (cards #1 and #2 only)

A single Volt `→` at 32px, 48px inset. The only color in the lower half of those cards. Anchors the eye to the implied "click here." On the square card (#3) the arrow shifts to bottom-center because the right margin is too tight at 800px.

### Reduced-motion: no animation, ever

Cards are static images. No animated GIF variants. No video preview unfurls. Twitter and Bluesky both downsample motion preview cards aggressively — type-only static PNGs render sharper.

---

## Card 1 — Open Graph / LinkedIn / Slack unfurl (1200 × 630)

The default. Used for `og:image` and `og:image:secure_url`. Most common surface across the web. Renders at ~500×260 in LinkedIn feeds and ~387×203 in Slack unfurls — design for the smaller end.

### Headline (load-bearing)

```
Your codebase,
on a typed graph.
```

Two lines, Geist Mono 600, 80px, line-height 1.05. Color `Bone`. The trailing period after `graph` is in `Volt` — the only headline accent. Centered horizontally, vertically positioned at ~42% of the height (slightly above center, so the eye lands on it before the wordmark and the arrow).

### Subhead (one line, below headline)

```
Compiles your repo to a typed graph IR. Diffed every PR.
```

Geist Sans 420 weight, 22px, `Ash`. Centered. Sits 32px below the headline. Two sentences, period each. Names compiles → IR (input) and diffed → PR (output) — the verb-first, constraint-loaded shape from the marketing-inspiration brief.

### Wordmark (top-left)

`plinth` Geist Mono 600 at 32px, leading `p` in `Volt`, rest in `Bone`. 48px inset from top and left.

### Attribution (bottom-left)

`plinth.dev` Geist Sans 420 at 18px, `Ash`. 48px inset from bottom and left. No date, no author — the homepage card is timeless.

### Bottom-right anchor

Volt `→` at 32px, 48px inset.

### Background

`Pitch` solid. 32px-spaced `Rule` dot grid at 30% opacity covers the whole canvas. No gradient.

### Why this composition works

It is recognizable in a Slack unfurl (the Volt period and the Volt `p` are visible at 387×203). It tells a stranger what the product is in one sentence. It does not lean on the graph image — graphs render as fuzz at thumbnail size.

### Per-page variants of the OG card

For non-homepage shares, swap only the headline. Wordmark, subhead, attribution, and arrow stay identical so the cards read as a set.

| Page | Headline (replaces "Your codebase, / on a typed graph.") |
|---|---|
| Quickstart (`/docs/quickstart`) | `Three commands to / a typed graph.` |
| GitHub Action (`/docs/github-action`) | `Graph diff. / Posted on every PR.` |
| Adapters (`/docs/adapters`) | `One adapter, / one framework. / ~200 lines.` (3-line variant; subhead omitted on this one) |
| Compare (`/compare`) | `Plinth vs. SCIP, / CodeQL, AI search.` |
| Blog post | The post title in 56px mono on up to three lines, truncated with an ellipsis in `Volt`. Subhead becomes the post tagline if present, else the post date in Ash. |

The blog-post variant is the only one where the subhead position is repurposed; everywhere else the subhead is the same as the homepage card.

---

## Card 2 — Twitter / X large card (1200 × 675)

The Twitter `summary_large_image` aspect ratio. 16:9 with slightly more vertical space than the OG card. Renders at ~510×287 in mobile Twitter feeds.

### Headline

```
Your codebase,
on a typed graph.
```

Geist Mono 600, 88px, line-height 1.05. `Bone`. Trailing period in `Volt`. Centered, vertically at ~40%.

(8px larger than the OG card to take advantage of the extra vertical space — Twitter's mobile crop is more vertical than LinkedIn's.)

### Subhead

```
Compiles your repo to a typed graph IR. Diffed every PR.
MIT  ·  no LLM  ·  runs in CI.
```

Two lines this time. First line same as the OG card. Second line the three-pill positioning row from the landing page, rendered as plain mono text in Ash with real `·` (U+00B7) separators. Geist Sans 420 weight, 22px first line, 18px second line, both `Ash`. Centered. 32px below the headline.

The three-pill row is the Twitter-only addition because Twitter readers skim faster than LinkedIn readers; the `MIT  ·  no LLM  ·  runs in CI` row converts a glance into a category-disqualification answer.

### Wordmark, attribution, anchor arrow

Identical to Card 1. Top-left wordmark `plinth` (32px), bottom-left `plinth.dev` (18px Ash), bottom-right `→` (32px Volt).

### Background

`Pitch` solid + 32px Rule dot grid at 30% opacity. Same as Card 1.

### Twitter-specific notes

- Twitter's `twitter:image:alt` field carries the alt text. Use: *"plinth.dev landing card. Headline: 'Your codebase, on a typed graph.' Subhead: compiles your repo to a typed graph IR, diffed every PR. MIT, no LLM, runs in CI."*
- Twitter card validator rejects images with mostly-transparent backgrounds. The Pitch `#0A0A0B` solid fill is required.
- Do not use the OG image as the Twitter image. Twitter crops differently; the Twitter card is taller, so a one-image-fits-all approach loses the headline's vertical center.

### Per-tweet variants

For announcement tweets (release notes, landed adapters, benchmark updates), swap the headline only.

| Tweet shape | Headline replacement |
|---|---|
| Release announcement | `Plinth v{X.Y.Z}. / {single highlighted feature}.` |
| New adapter | `Plinth now indexes {Framework}. / One more typed edge kind.` |
| Benchmark | `{N}x faster than {Comparator} / on the {Fixture} repo.` (no period — let the comparator name carry weight) |
| HN/Reddit thread share | `On Hacker News today: / Plinth.` (sub-line: link only) |

Subhead and three-pill row stay constant across variants. The point of variants is the headline does the work; supporting copy stays identical so the brand reads coherent across many tweets.

---

## Card 3 — Bluesky / Mastodon square (800 × 800)

Bluesky and Mastodon both render link previews as squares (Bluesky exactly, Mastodon usually). The 800×800 is intentional — both networks downsample to ~512×512 for feed thumbnails, so the card needs to read at half size.

### Headline

```
Your codebase,
on a Plinth.
```

Geist Mono 600, 72px, line-height 1.05. `Bone`. Trailing period in `Volt`.

This card is the **only** surface where the headline names the product directly, and it is deliberate. The square format gives less horizontal room for the subhead to do "what the product is" work, so the headline absorbs that job. The phrasing intentionally puns the name — `on a Plinth` is both the literal tagline (a plinth is the base a structure rests on) and the name. This is the *only* sanctioned name-pun in the brand voice; do not propagate it elsewhere without checking.

The reserved fallback if the pun reads weakly in the design pass: `plinth.dev / your codebase, on a typed graph.` (two-line, wordmark-first, headline-second). Keep the pun version as the default; ship the fallback only if QA flags the pun as confusing in non-English locales.

### Subhead

```
Typed graph IR. Diffed every PR.
```

Geist Sans 420 weight, 22px, `Ash`. Centered, 32px below headline. Trimmed from the OG/Twitter version to fit the square — the full sentence reads cluttered at 800px width.

### Wordmark (top-left)

Same as cards 1 and 2: `plinth` lowercase Geist Mono 600 at 28px (smaller than the 32px on the wider cards because 800px is tighter), leading `p` in `Volt`. 36px inset from top-left.

### Attribution and arrow

The Volt `→` shifts to bottom-center on this card (32px, 48px above bottom edge) because the 800px square's bottom-right corner is too tight for both attribution and arrow. `plinth.dev` Geist Sans 420 at 18px in `Ash`, centered, sits 16px below the arrow.

### Background

`Pitch` + 32px Rule dot grid, same as cards 1 and 2.

### Why a square specifically

Bluesky and Mastodon both crop landscape images aggressively in the feed view; a 1200×630 OG card loses ~30% of the headline on Bluesky's mobile feed. The square version is designed to hit the feed and the open-card view at the same composition. The cost is 50% less horizontal headline real estate, which is why this card uses the punning two-line headline rather than the three-line "your codebase, on a typed graph" of cards 1 and 2.

### Mastodon-specific notes

- Mastodon's link preview reads `og:image` + `og:image:width` / `og:image:height`. Set `og:image:width` to 800 and `og:image:height` to 800 explicitly so Mastodon doesn't crop assuming 1200×630.
- Mastodon's image alt is set via `og:image:alt` (same as Twitter). Use: *"plinth.dev. Headline: your codebase, on a Plinth. Subhead: typed graph IR, diffed every PR."*

### Bluesky-specific notes

- Bluesky's `app.bsky.embed.external` reads the OG image at the linked URL. For Bluesky-targeted shares, use a URL fragment like `?card=square` that the build serves with the 800×800 card; for everywhere else, default to the 1200×630 OG card.

---

## Production checklist

For the engineer or designer building the cards:

1. **Render at 2x.** Output 2400×1260 / 2400×1350 / 1600×1600 PNGs at 144 DPI. Browsers and apps downsample better than they upsample.
2. **Compress with `oxipng -o 4` or `pngcrush`.** Target file size ≤200 KB per card. Twitter card validator complains above 5 MB but feed render quality drops above 250 KB.
3. **Embed sRGB profile.** macOS Preview, iOS, and Android all render assuming sRGB; not embedding the profile occasionally shifts Volt to a duller chartreuse on iOS.
4. **No transparency.** Solid `Pitch` background everywhere. PNG-32 with alpha is unnecessary and inflates file size.
5. **Test in three feeds before shipping.** LinkedIn unfurl, Slack `/share` preview, Twitter card validator. Mastodon's preview takes 24h to refresh — push first, verify next day, do not iterate live.
6. **Cache-bust on copy changes.** Every headline variant lives at a stable URL like `/og/quickstart-v1.png`. When the copy changes, increment to `-v2` so unfurls don't serve a stale image for hours.

## Variants matrix (which card to ship for which surface)

| Surface | Card | URL convention |
|---|---|---|
| Homepage `<meta og:image>` | Card 1 (1200×630) | `/og/home.png` |
| Twitter `<meta twitter:image>` | Card 2 (1200×675) | `/og/twitter-home.png` |
| Bluesky / Mastodon | Card 3 (800×800) | `/og/square-home.png` (or `?card=square` fragment) |
| Per-doc page | Card 1 with headline swap | `/og/{doc-slug}.png` |
| Release tweet | Card 2 with headline swap | `/og/twitter-release-{version}.png` |
| Blog post | Card 1 with title-as-headline | `/og/blog-{slug}.png` |
| GitHub repo social preview | Separate (1280×640, see `brand/visual-identity.md` §5.4) | uploaded to GitHub repo settings |

The GitHub repo social preview is intentionally not in this file — it's specced in `brand/visual-identity.md` §5.4 with the full wireframe-cube logo and the `>` fact-line treatment. That's a different surface (repo cover, not a feed card) and lives with the visual identity doc.

---

## Per-card final copy block (for direct hand-off to the design pass)

Three blocks below. Each block is exactly the strings to typeset. No interpolation, no placeholders, no commentary.

### Block 1 — OG card (1200 × 630)

```
WORDMARK (top-left, 32px Geist Mono 600, leading p in Volt):
  plinth

HEADLINE (centered, 80px Geist Mono 600, Bone, period in Volt):
  Your codebase,
  on a typed graph.

SUBHEAD (centered, 22px Geist Sans 420, Ash, two sentences):
  Compiles your repo to a typed graph IR. Diffed every PR.

ATTRIBUTION (bottom-left, 18px Geist Sans 420, Ash):
  plinth.dev

ANCHOR (bottom-right, 32px Volt arrow):
  →
```

### Block 2 — Twitter card (1200 × 675)

```
WORDMARK (top-left, 32px Geist Mono 600, leading p in Volt):
  plinth

HEADLINE (centered, 88px Geist Mono 600, Bone, period in Volt):
  Your codebase,
  on a typed graph.

SUBHEAD LINE 1 (centered, 22px Geist Sans 420, Ash):
  Compiles your repo to a typed graph IR. Diffed every PR.

SUBHEAD LINE 2 (centered, 18px Geist Sans 420, Ash, with U+00B7 separators):
  MIT  ·  no LLM  ·  runs in CI.

ATTRIBUTION (bottom-left, 18px Geist Sans 420, Ash):
  plinth.dev

ANCHOR (bottom-right, 32px Volt arrow):
  →
```

### Block 3 — Bluesky / Mastodon square (800 × 800)

```
WORDMARK (top-left, 28px Geist Mono 600, leading p in Volt):
  plinth

HEADLINE (centered, 72px Geist Mono 600, Bone, period in Volt):
  Your codebase,
  on a Plinth.

SUBHEAD (centered, 22px Geist Sans 420, Ash):
  Typed graph IR. Diffed every PR.

ANCHOR (bottom-center, 32px Volt arrow):
  →

ATTRIBUTION (bottom-center, 16px below the arrow, 18px Geist Sans 420, Ash):
  plinth.dev
```

---

*End of marketing/social-cards.md.*
