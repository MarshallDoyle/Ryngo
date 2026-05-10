# Unsloth landing-page research

URL: https://unsloth.ai/
Fetched: 2026-05-10

The goal: document what Unsloth publishes on its landing page so we
know the shape of a successful ML-tools homepage, then call out
specific ideas Ryngo could borrow.

---

## 1. One-line positioning

> **"Train and Run Models Locally"**

Supporting / hero claims (rotating, not all in one place):
- "Train your own custom model in 24 hrs, not 30 days"
- "30x faster than FA2 + 30% accuracy"
- "90% less memory usage than FA2"
- "We're making AI more accessible to everyone"
- "Unsloth makes everything greener"

Five lines instead of one. The headline is short ("Train and Run Models
Locally"); the **proof** is in the surrounding claims.

---

## 2. Page sections, in order

| # | Section | What it shows |
|---|---|---|
| 1 | Header / nav | Logo · Models · Blog · Unsloth Studio · Docs |
| 2 | Hero | Studio UI screenshot; "Easily run & train models locally" |
| 3 | CTA zone | Discord link + "Start for free" button |
| 4 | Latest news | 4 dated announcements (API, Qwen3.6, Gemma 4, Studio intro) |
| 5 | Run Models Locally | Feature card + screenshot; offline on Mac/Win/Linux; GGUF + Safetensors |
| 6 | No-code Training | Auto-dataset, custom kernels, 500+ model support + observability screenshot |
| 7 | Model Arena | Side-by-side comparison UI; screenshot |
| 8 | Data Recipes | Graph-node workflow for doc→dataset (PDF / CSV / JSON) |
| 9 | Export Models | Safetensors / GGUF; llama.cpp / vLLM / Ollama compat |
| 10 | OSS pitch | "Why not try our fully free open source version?" |
| 11 | Newsletter 1 | First Substack signup |
| 12 | Performance text block | "30x faster, 90% less memory, audio/embedding/vision" |
| 13 | Mission line | "Making AI more accessible" + "everything greener" |
| 14 | Inference teaser | "Lightning-fast inference coming soon — contact us" |
| 15 | MultiGPU teaser | "Even better MultiGPU in the works" |
| 16 | Mobile teaser | Phone mockup (no caption) |
| 17 | Pricing | Three tiers — Free / Pro / Enterprise |
| 18 | Final CTA | "Ready to use Unsloth?" |
| 19 | Footer | Company / Product / Community + social icons |

Nineteen sections. **Much longer than LiteLLM.** Heavy use of
screenshots, repeated CTAs, multiple newsletter signups, and roadmap
teasers ("coming soon").

---

## 3. Every feature claim

**Speed / performance:**
- 2.5x faster training (Pro)
- 30x faster training (Enterprise vs FA2)
- 32x faster on multi-GPU (Enterprise)
- 5x faster inference (Enterprise)
- 2x faster fine-tuning (free)

**Memory / efficiency:**
- 20 % less VRAM (Pro)
- 70 % less memory (free)
- 90 % less memory vs FA2 (Enterprise)
- 30 % accuracy uplift (Enterprise)

**Training types:**
- LoRA fine-tuning
- FP8 quantization
- Full fine-tuning (FFT)
- Pre-training (Enterprise)
- 500+ supported models

**Modalities:**
- Text · Vision · Audio · Embedding

**Inference features:**
- Tool calling
- Web search
- OpenAI-compatible API
- GGUF + Safetensors support

**Training UX:**
- No-code interface
- Real-time observability
- Auto-dataset from PDF / CSV / JSON
- Graph-node "Data Recipes" workflow
- Export to multiple formats

**Deployment compat:**
- llama.cpp · vLLM · Ollama · Colab · Kaggle

**Operational:**
- 100 % offline on Mac / Windows / Linux
- Side-by-side model comparison
- Multi-file upload (images, docs, audio, code)
- Up to 8 GPUs (Pro)
- Multi-node (Enterprise)

Roughly **35 distinct feature claims** on one page. Aggressive density.

---

## 4. Products / services on offer

| Offering | Description |
|---|---|
| **Unsloth (open source)** | Free Python library on GitHub |
| **Unsloth Studio** | Desktop app (Mac / Windows), 100 % offline |
| **Unsloth API endpoint** | Cloud-hosted inference API |
| **Unsloth Pro** | Paid tier — better perf + more GPUs |
| **Unsloth Enterprise** | Premium tier — multi-node, full training, support |
| **Model Zoo** | Pre-trained models (Mistral, Gemma, Llama 1/2/3, Qwen 3.6) on Hugging Face |

Six product surfaces under one brand. Library + desktop app + cloud API
+ two paid tiers + a model zoo.

---

## 5. Pricing — three tiers, not two

### Free
- Open-source
- Supports Mistral, Gemma, Llama 1/2/3
- 4-bit + 16-bit LoRA
- MultiGPU (coming soon)
- **CTA:** GitHub

### Unsloth Pro
- 2.5x faster training than FA2
- 20 % less VRAM than OSS
- Enhanced MultiGPU
- Up to 8 GPUs
- "For any use case"
- **CTA:** Contact us

### Unsloth Enterprise
- 32x faster than FA2
- +30 % accuracy
- 5x faster inference
- Full training support
- All Pro features
- Multi-node
- Customer support
- **CTA:** Contact us

Three tiers means the Pro tier asks the visitor "are you a startup or
an enterprise?" — a less efficient question than LiteLLM's binary
free/paid split.

---

## 6. Social proof

**Zero customer logos.** Zero testimonials. No quoted users.

**No GitHub star count on the page** (though the repo is public).

**No download / usage counters.**

**Soft proof strategy:** *"Don't believe us? Why not try our fully free
open source version?"* — they push the OSS option as the trust path
rather than borrowing trust from named customers.

**What's missing is conspicuous.** A page with this much
performance-claim density and no third-party validation reads as
self-asserted. The single biggest gap on the Unsloth page.

---

## 7. Calls-to-action

Seventeen distinct buttons / links. Highlights:

| CTA | Where it sits |
|---|---|
| Join our Discord | Hero |
| Start for free | Hero |
| Learn more (Studio) | Run-models card |
| Quickstart (training) | No-code training card |
| Learn more (Model Arena) | Model arena card |
| Quickstart (Data Recipes) | Data recipes card |
| Learn more (Export) | Export card |
| Get access now | OSS pitch |
| Subscribe now | Newsletter 1 |
| Contact us | Inference teaser |
| Subscribe | Newsletter 2 |
| Get started (Free) | Pricing |
| Contact us (Pro) | Pricing |
| Contact us (Enterprise) | Pricing |
| Get started for free | Final CTA |

**Pattern:** every section ends with a "Learn more" or "Quickstart"
link straight into docs. Two separate newsletter signups (Substack).
"Contact us" repeated three times in pricing.

The CTA-per-pixel ratio is high — visitor never goes more than one
screen height without a button.

---

## 8. Code snippets

**None explicitly rendered on the landing.** Code lives in GitHub +
Colab notebooks. Same call as LiteLLM made.

---

## 9. Navigation

**Top nav (slim):**
- Unsloth logo
- Models
- Blog
- Unsloth Studio (with ✨ "new" badge)
- Docs

**Footer (four columns):**

**Company:** About · Newsletter · Privacy · Terms
**Product:** Introduction · Docker · Download · Documentation · Models
**Community:** Twitter · Reddit · Hugging Face · Discord · LinkedIn
**Contact:** Email + Discord

The "new" badge on the Studio nav item is a small touch that draws
the eye to the latest product.

---

## 10. Highlighted integrations

**Models:** Mistral · Gemma (incl. Gemma 4) · Llama 1/2/3 · Qwen 3.6
**Inference frameworks:** llama.cpp · vLLM · Ollama
**Notebook platforms:** Google Colab · Kaggle Notebooks
**Formats:** GGUF · Safetensors
**Model hub:** Hugging Face

Integrations are listed inline in feature descriptions, not in a
dedicated logo wall.

---

## 11. Developer-experience hooks

- Main docs (`unsloth.ai/docs`)
- Per-feature doc sections (Studio, API, MultiGPU)
- Blog
- GitHub
- Substack newsletter (two signup CTAs!)
- Discord
- Hugging Face
- Reddit (/r/unsloth)
- LinkedIn, Twitter

Two newsletter signups on one page is unusual — they're betting on
email capture as a primary conversion goal.

---

## 12. Brand impression

- **Mascot:** sloth character. Appears in multiple page images ("sloth
  with PC", "sloth with magnifying glass", "sloth on phone"). The
  brand is the mascot.
- **Color palette:** green primary, purple accents.
- **Aesthetic:** polished SaaS landing, NOT research-paper. Big
  screenshots, big typography, playful mascot integration.
- **Visual hierarchy:** screenshot-driven (7+ product images). Each
  feature card pairs a one-line claim with a UI screenshot.
- **Tone:** approachable, accessible — "we're making AI more
  accessible" repeated. The sloth is the embodiment.

---

## 13. Numbers / benchmarks on the page

| Claim | Tier | Comparison baseline |
|---|---|---|
| 30x faster | Enterprise | vs FA2 |
| 30 % accuracy uplift | Enterprise | (baseline implied) |
| 90 % less memory | Enterprise | vs FA2 |
| 2x faster | Free | (baseline unclear) |
| 70 % less memory | Free | (baseline unclear) |
| 2.5x faster | Pro | vs FA2 |
| 20 % less VRAM | Pro | vs OSS |
| 32x faster | Enterprise | vs FA2 (multi-GPU) |
| 5x faster inference | Enterprise | (baseline implied) |
| 500+ models | All | supported |
| Up to 8 GPUs | Pro | hardware limit |
| 24 h vs 30 days | All | "train a custom model" |

Twelve numerical claims, every one a multiplier. **Zero charts. Zero
graphs.** Numbers are presented as text — which is striking given how
chart-heavy ML-research culture is.

---

## 14. Page artifacts worth noting

- **Latest news section** with 4 dated bullets — keeps the page feeling
  alive without a separate blog click.
- **"Coming soon" features** explicitly listed (lightning-fast
  inference, better MultiGPU) — sets expectations + signals momentum.
- **Phone mockup image** with no caption — purpose unclear (mobile
  app? mobile inference? hard to tell).
- **Future-dated news** (May 5 2026 etc.) — likely placeholder content
  from when the page was scaffolded.

---

## What Ryngo could borrow

**Aggressive performance multipliers in the hero.** Unsloth says "30x faster, 90 % less memory" and the reader knows the math without reading another word. Ryngo's actual benchmark numbers (topology = 0.12 % of raw source → 850× compression for planning agents; signature = 0.006 % → 16,000× for symbol-level queries; subgraph = 0.28 % → 350× for change work) are *better* multipliers than Unsloth's, and we're burying them in `tokens-summary.json`. Put **"100× less context, same code map"** in the hero.

**Latest-news / dated-announcement section.** Unsloth has 4 dated bullets sitting between hero and features. Cheap, easy to update, signals momentum. We just shipped Phase 11 (Ryngo.md), Phase 10 (compiler warnings), Phase 6 (corpus harness) — each is one bulleted dated line on the landing.

**"Coming soon" teaser blocks.** "Even better multi-GPU in the works!" works because it tells visitors the team is building. Ryngo has plenty: Go via `go list`, tree-sitter swap, MCP-on-tools-call autocomplete, multi-repo aggregation. One small "next up" card.

**Mascot energy.** The sloth is the brand. Ryngo's `R` is a placeholder — once a real mark is chosen from the logo lab, lean into it. A character / illustration on the landing page is the single biggest personality move in the Unsloth set.

**Screenshot-per-feature.** Every Unsloth feature card pairs a one-line claim with a real UI screenshot. Ryngo's landing has a live demo iframe at the top (better than screenshots!) but the **rest of the page** explains features in prose. Adding small static screenshots of: typed-port nodes, the warning panel, the Ryngo.md inspector, the diff overlay — would make the feature-by-feature scroll feel like product, not docs.

**Per-section "Learn more" → docs.** Unsloth ends every feature card with a doc link. Ryngo's landing today has a few "Open the app" CTAs but doesn't push docs hard. Each section should end with "Read the docs" so a curious visitor has a deeper path immediately.

**Newsletter signup.** Unsloth has two on one page (overkill — one is fine). Ryngo currently has none. A simple "Get a weekly diff of what shipped" Substack/Buttondown signup converts curious-but-not-ready visitors into a recurring audience.

**Discord + Slack + community links in the footer.** Unsloth and LiteLLM both have rich community footers. Ryngo's footer is one link to marshall-doyle.com + GitHub. We don't have a Discord yet — that's the gap.

**What to NOT borrow.** Three pricing tiers (Free / Pro / Enterprise) creates a decision point in the middle that loses conversions. LiteLLM's binary (Free / Enterprise) is cleaner — Ryngo should match LiteLLM here. Also: don't ship the page with no testimonials like Unsloth did. Even one named user beats none.

**Bigger meta-lesson.** Unsloth ships numbers, screenshots, and CTAs at high density and skips social proof. LiteLLM ships fewer features but heavier social proof. **Ryngo should ship both** — we have real corpus numbers AND a live working demo AND named users coming online. The combined position is stronger than either competitor's.
