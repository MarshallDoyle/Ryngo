# Domain Availability — Top 5 Candidates

**Caveat:** I cannot run actual WHOIS or DNS lookups. The estimates below are based on (a) known products at those names, (b) priors about which short, common English words tend to be squatted, and (c) what surfaced in collision searches. Verify everything by hand before you commit.

Legend:
- **Likely available** — short coined / obscure word, no known product hit
- **Possibly available** — word is used elsewhere but not for a dev tool; squatters may still hold it
- **Likely squatted** — common English word, will be parked even if no real product exists
- **Taken** — confirmed live product / company at that domain or a strong adjacent one

---

## Top 5 Domain Table

| Rank | Name    | `.dev`             | `.io`              | `.com`             | `.app`             |
|------|---------|--------------------|--------------------|--------------------|--------------------|
| 1    | Plumb   | Possibly available | Likely squatted    | Likely squatted (Plumb.com is real estate / lighting brands historically) | Possibly available |
| 2    | Sextant | Likely available   | Possibly available | Likely squatted (common navigation/marine word) | Likely available |
| 3    | Querra  | Likely available   | Likely available   | Possibly available | Likely available |
| 4    | Strath  | Likely available   | Possibly available | Likely squatted (Strathclyde, Scottish geography aggregator squatters) | Likely available |
| 5    | Cartrix | Likely available   | Likely available   | Likely available   | Likely available |

---

## Per-Name Notes

### Plumb
- `plumb.dev` — already used by a small low-code workflow site (saw in research). Verify whether it's active or parked; if abandoned, may be acquirable. **Worth paid acquisition consideration.**
- `plumb.io` — short, dictionary words at .io are almost always parked. Expect a four- to five-figure squatter price.
- `plumb.com` — old domain, almost certainly held; "Plumb" was historically used by lighting/plumbing companies. Premium price if obtainable at all.
- `plumb.app` — most likely available outright or for low cost; `.app` is a Google TLD with stricter registration and less squatting.
- **Realistic path:** Launch on `plumb.dev` if the existing user is dormant, or `plumb.app`. Consider `plumbcli.dev` or `getplumb.dev` as fallbacks; these are common patterns for OSS CLIs (e.g., `getfider`, `gettailwind`).

### Sextant
- `sextant.dev` — coined-feeling, niche enough that it's likely free.
- `sextant.io` — possibly available; specialty word but `.io` is hot.
- `sextant.com` — premium domain, probably held by a maritime/navigation brand or a parking page. Five-figure expectation.
- `sextant.app` — almost certainly free.
- **Realistic path:** `sextant.dev` and `sextant.app` are both plausible primary domains. `.com` is aspirational only.

### Querra
- All four TLDs likely available — coined word with no surfaced collisions. **The cheapest option to lock down end-to-end.**
- Risk: if your seed round depends on the name being recognizable on first read, Querra trades cost-of-domain for cost-of-marketing.

### Strath
- `strath.dev` / `strath.app` — short and uncommon, likely free.
- `strath.io` — short word at .io, expect a registration squatter.
- `strath.com` — Scottish geographic resonance (Strathclyde, Strathmore) means this is probably a dictionary-squatter or a Scottish site. Premium.
- **Realistic path:** `strath.dev` is the move.

### Cartrix
- All four likely available — coined word, no major use found.
- Slight risk: `Cartrix` echoes `cartrix` shopping-cart / ecommerce SaaS naming; double-check Trademark databases (USPTO TESS) before commit.

---

## Practical Domain Strategy

1. **Lock all four TLDs you want at once** for whichever name wins; the price delta to grab `.dev`, `.io`, and `.app` together is small relative to brand cost.
2. **Skip `.com` for `Plumb` and `Strath`** unless the budget exists to negotiate — they're both century-old English words. Devs accept `.dev` as primary now (e.g., `bun.sh`, `astro.build`, `vite.dev`, `turbo.build`).
3. **For `Plumb`, also grab `getplumb.*` and `plumb-cli.*`** as defensive registrations even on the primary domain.
4. **Run a USPTO TESS search** for the final pick before launch — important for the OSS-but-trademarked pattern Sourcegraph/Linear use.
5. **Fallback ranking** if `Plumb` is unworkable: `Sextant` → `Querra` → `Cartrix` → `Strath`. (Querra above Cartrix on uniqueness; Cartrix above Strath on instant comprehension.)

---

## TL;DR

- **`Plumb`** is the strongest brand but the hardest to register cleanly. Likely realistic primary: `plumb.dev` or `plumb.app`.
- **`Sextant`** is the safest second choice with better domain economics.
- **`Querra`** wins outright if domain coverage matters more than first-read comprehension.
