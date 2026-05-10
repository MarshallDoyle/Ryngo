# LiteLLM landing-page research

URL: https://www.litellm.ai/
Fetched: 2026-05-10

The goal: document what LiteLLM publishes on its landing page so we know
the shape of a successful infra-dev-tool homepage, then call out specific
ideas Ryngo could borrow.

---

## 1. One-line positioning

> **"LLM Gateway (OpenAI Proxy) to manage authentication, loadbalancing,
> and spend tracking across 100+ LLMs. All in the OpenAI format."**

Supporting line:
> "simplifies model access, spend tracking and fallbacks across 100+ LLMs"

The tagline is dense. It names the **product category** (LLM Gateway),
the **mental model** (OpenAI Proxy), the **three biggest features**
(auth, load balancing, spend), and the **integration surface** (100+
LLMs, OpenAI format) in one sentence. No slogan, no metaphor.

---

## 2. Page sections, in order

| # | Section | What it shows |
|---|---|---|
| 1 | Header / hero | Y Combinator backing badge; "Give Developers" with an access list (Azure, Gemini, Bedrock, OpenAI, Anthropic) |
| 2 | Value-prop bullets | cost tracking · batches API · guardrails · model access · budgets · observability · rate limiting · prompt management · S3 logging |
| 3 | Stats banner | 240M+ Docker pulls · 1B+ requests served · 80 % uptime · 1,005+ contributors |
| 4 | "What is LiteLLM?" | Plain-language explainer + video demo link (not embedded) |
| 5 | Feature deep dive | 4 hero capabilities — spend tracking, budgets & rate limits, OpenAI compatibility, fallbacks |
| 6 | Spend-tracking sub-features | 5 linked sub-features with doc references |
| 7 | Pricing | Two-tier table — Open Source / Enterprise |
| 8 | Customer testimonials | Netflix + Lemonade, with named-engineer attribution |
| 9 | Footer / nav | 20+ links to docs, GitHub, careers, support |

Nine sections. Hero is short — the page leans on bullets + stats + a
prominent pricing table, not long copy.

---

## 3. Every feature claim

**Core gateway:**
- Supports 100+ LLM providers
- OpenAI-compatible request/response format
- Load balancing across models
- Automatic fallback between providers
- LLM guardrails
- Virtual keys, team and org management

**Governance:**
- Spend tracking by key / user / team / org
- Budget caps
- RPM / TPM rate limits
- JWT auth, SSO, audit logs (enterprise)

**Operability:**
- S3 + GCS logging
- Prompt formatting for Hugging Face models
- Prompt management

---

## 4. Products / services on offer

| Form | Tier |
|---|---|
| **LiteLLM Python SDK** (library) | Open source |
| **LiteLLM Gateway / Proxy** (self-hosted, Docker) | Open source + Enterprise |
| **LiteLLM AI Gateway** (cloud or self-hosted) | Enterprise |
| **Managed LiteLLM Proxy** | Enterprise |

Four flavors of the same product. Same name brand stretched across SDK,
self-hosted, and managed-cloud.

---

## 5. Pricing

| Tier | Price | What you get | CTA |
|---|---|---|---|
| **Open Source** | $0 | 100+ LLM integrations, Langfuse/Arize Phoenix/Langsmith/OTEL logging, virtual keys, budgets, teams, load balancing, RPM/TPM limits, guardrails | "Get Started" → GitHub |
| **Enterprise** | Custom | Everything in OSS + enterprise support, custom SLAs, JWT auth, SSO, audit logs | "Request Pricing & 30-day Trial" → `/enterprise` |

Two tiers. Binary. The free tier is the on-ramp; enterprise is the
revenue. No "Pro" middle tier.

---

## 6. Social proof

**Quantitative (the stats banner):**
- 240M+ Docker pulls
- 1B+ requests served
- 80 % uptime
- 1,005+ GitHub contributors
- 40K GitHub stars (in nav)

**Brand badges:** Y Combinator (top of hero).

**Named customer testimonials:**

> *"LiteLLM has let my team provide the latest LLM models to our users
> usually within a day of them being released."*
> — David Leen, Staff Software Engineer, **Netflix**

> *"LiteLLM streamlines the complexities of managing multiple LLM models."*
> — Mark Koltnuk, Principal Architect (GenAI Platform), **Lemonade**

Two testimonials. Each names a recognizable company AND a named engineer
with their title. That's the standard.

---

## 7. Calls-to-action

| CTA | Destination | Where it sits |
|---|---|---|
| "Request Pricing" | `/enterprise` | Hero |
| "Deploy LiteLLM On-Prem" | docs quick-start | Hero |
| "Get Started" | GitHub (BerriAI/litellm) | Open Source price tile |
| "Request Pricing & 30d Trial" | `/enterprise` | Enterprise price tile |
| "Schedule call with Founders" | Calendly | Footer |
| "Slack / Discord" | `/support` | Footer |

Two CTAs per pricing tile, one CTA per hero, one founder Calendly link
in the footer. Notable: the founder calendar is treated as a footer
utility, not a hero hook.

---

## 8. Code snippets

**None on the landing itself.** Code lives in docs / GitHub. The
homepage stays prose + bullets + stats.

That's a deliberate trade — code on a homepage forces visitors to scroll
past it. LiteLLM bets on docs being a quick second click.

---

## 9. Navigation

**Top nav (sparse):**
- Hiring (Ashby jobs link)
- AI Gateway
- Pricing

**Footer nav (twenty-plus links):**
- Docs hubs: Getting Started, Providers, Logging, Prometheus, Virtual Keys
- Resources: Changelog, Blog, GitHub, Python SDK docs, Gateway docs, AI Gateway
- Company: Careers, Legal / Security / Compliance FAQ
- Support: Slack/Discord, "Schedule call with founders"
- Why Enterprise?

The top nav is intentionally tiny (3 items). All the depth is in the
footer.

---

## 10. Highlighted integrations

**LLM providers:** OpenAI · Azure OpenAI · Google Gemini · AWS Bedrock ·
Anthropic · Hugging Face · GCP / Vertex AI (implied by GCS logging).

**Observability / logging:** Langfuse · Arize Phoenix · Langsmith ·
OpenTelemetry · Prometheus metrics · S3 / GCS buckets.

Integrations are the product — listing them by name builds credibility.

---

## 11. Developer-experience hooks

- Video demo (linked, not embedded)
- docs.litellm.ai with extensive provider matrix
- GitHub repo (40K stars)
- Docstring / API reference (in docs)
- Blog
- Changelog
- Docker quick-start
- Calendly to founders
- 30-day enterprise trial

Multiple low-friction on-ramps. The "GitHub" link is the conversion
point for the developer; "Calendly" is the conversion point for
enterprise.

---

## 12. Brand impression

- **Tone:** technical, dev-first. GitHub stars + Docker pulls prominent.
- **Audience:** platform engineers, DevOps, backend teams.
- **Y Combinator** affiliation visible — startup-credibility signal.
- **Metrics-heavy** copy — 240M pulls, 1B requests, 80 % uptime — built
  for engineers evaluating scale.
- **Enterprise badges** (Netflix, Lemonade) position for mid-market.
- **Minimalist** layout: bullets, testimonials, CTAs. No visual flourish.
- **OSS + paid tier** model typical of infra tools — free tier as moat,
  enterprise as revenue.

---

## What Ryngo could borrow

**Quantified-scale block.** LiteLLM puts "240M Docker pulls · 1B requests · 1,005 contributors" front and center. We have **real corpus numbers** (54 repos analyzed · 58M tokens compressed · 113 s end-to-end · 0.12 % topology ratio · 0.006 % single-symbol ratio) and we're hiding them. A stats banner under the hero would land hard.

**Named-engineer testimonials.** Two quotes is the minimum, and each names a real company + a real engineer. We have zero today. As soon as we get one Cursor / Claude Code / Aider user shipping with Ryngo, ask them for a one-line + their title + their company. Don't ship the page with placeholder "engineer at startup" — Netflix-and-Lemonade specificity is the value.

**Tagline density.** LiteLLM's tagline names the category, the mental model, three features, and the integration surface in 23 words. Ryngo's current tagline ("The map your coding agent is missing") is poetic but doesn't name **what it is** (a code analyzer? a viewer? a graph format?), **who it competes with** (Sourcegraph? GitHub Copilot? Cursor?), or **how it integrates** (MCP? CLI? Library?). Consider a 1-2 sentence companion that fills in those gaps without softening the poetic line.

**Y-Combinator-style trust badge.** We don't have YC, but we do have something like a "Anthropic Claude / OpenAI Codex / Cursor compatible" badge row that would land in the same visual slot.

**Binary pricing tiles.** LiteLLM ships Free / Enterprise — no middle tier. Cleaner than Unsloth's three-way split. If/when Ryngo gets to pricing, copy this shape: free open-source + enterprise call-us, skip the middle. (Mid-tier is where pricing pages go to die.)

**Founder Calendly in the footer.** Low-friction, no enterprise gating. Worth adding to our footer — `marshall-doyle.com` is there, but a direct "book 15 minutes with the founder" link converts higher than "click my personal site → find a contact form."

**Logo / integration roll.** LiteLLM lists OpenAI, Azure, Gemini, Bedrock, Anthropic, Hugging Face inline. Ryngo's equivalent is the **LLM-harness roll** (Claude Code, Cursor, Aider, Continue, Codex, ChatGPT MCP) plus the **language roll** (TS, JS, Py, Go, Rust, Java, Ruby, C#, HCL — already in our corpus). Both belong on the page.

**Twenty-plus footer link sprawl.** The footer is where a mature product lives. We have ~6 links today. Worth adding: changelog, blog, careers (even if placeholder), legal / security / compliance, multiple doc entry points, integration-specific docs.

**What to NOT borrow.** LiteLLM has no code on the landing. Ryngo's product IS a visual graph + LLM context — keep the embedded live demo (we have it; LiteLLM would kill for this). The product is the demo. Don't shrink it.
