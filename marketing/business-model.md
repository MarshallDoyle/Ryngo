# codegraph: business model assessment

An honest look at how an MIT-licensed, no-hosted-backend, no-LLM static-analysis tool can sustain itself — and whether it should try to.

The TL;DR is at the bottom. The body of this document tries to be honest about each path, including the path of "nothing — keep it as a side project."

Updated 2026-05.

---

## Framing: be honest about TAM

Before evaluating any path, we need to be honest about how big this market actually is. Overestimating TAM is the most common failure mode for OSS-with-a-business-model-bolted-on stories.

**The realistic addressable population:**

- Engineering teams that *care enough about codebase structure* to install a tool that diffs the IR on every PR. That's not most teams. Most teams ship features and don't think about this until something is on fire.
- Of those teams, the subset that wants this tool *enough to pay* — i.e., the local OSS version isn't sufficient. That requires real friction: scale, multi-repo, hosting, audit, SSO, retention, support contracts.
- Of those, the subset that *will actually pay rather than build it themselves or wait for it to be free*. Engineering organizations with a culture of buying tools, not just using them.

**Rough sizing.** If you assume there are maybe 50,000 engineering organizations globally that match the first filter, ~5,000 that match the second, and ~500 that match the third, you're looking at a TAM in the low single-digit millions of dollars per year for a paid offering — and that's if you win every one of them, which you won't. Realistic capture in year 3–5 is something like 50 paying orgs at an average of $10–25k/yr ARR, or $500k–$1.25M ARR.

That's a real business. It is not a venture-scale business. This framing matters because it cuts off some of the paths below before we even get into details.

**Comparable points of reference.** Tools in the structural-analysis-of-codebases adjacent space have not, historically, been venture successes. Sourcegraph raised serious money and pivoted hard to an AI-coding-assistant motion (Cody) because pure code search was a hard sell. CodeSee raised, struggled, and was acquired by GitKraken in 2024. Bloop announced in April 2026 that they couldn't find a business model. Sourcetrail's company simply shut down operations in 2021. The graveyard for this category is not small.

That doesn't mean there's *no* business — but it does mean we should weight "stay small and sustainable" more heavily than "raise to grow" when evaluating options.

---

## Path 1: GitHub Sponsors / Open Collective

Pure donation-funded OSS. The community pays the maintainer(s) directly because they value the project.

### How it actually works

- Set up GitHub Sponsors (individual maintainer accounts) and an Open Collective for the project itself.
- Add tiered sponsorship: $5/mo, $25/mo, $100/mo, $500/mo, $2.5k/mo for companies.
- Promote it from the README, the CLI's `--help`, and (sparingly) at the top of release notes.
- Maybe add a `THANKS.md` or in-repo sponsors page that lists corporate sponsors. (Don't put logos in the actual tool output — that crosses a line for many users.)

### What's realistic

Looking at OSS projects of comparable size and shape:

- A widely-loved single-maintainer Python or Go tool with strong personal branding can hit $30–80k/yr in sustained sponsorship. Examples: Caleb Porzio (Livewire), Sindre Sorhus (broad ecosystem), the maintainers of curl.
- A specialty tool used by a smaller niche of teams (more analogous to codegraph) tends to land in the $5–30k/yr range, sometimes growing to $50k if the tool becomes load-bearing for a few large companies.
- Below ~$30k/yr, sponsorship cannot replace a full-time salary in any high-cost-of-living country. It can supplement an existing job and reduce guilt about "should I be working on this?" hours.

### Pros

- Aligned with project values: free, MIT, local, no upsell pressure.
- Zero infrastructure cost. No SaaS to run.
- The maintainer keeps full control of the roadmap.
- It's the path most consistent with a pure OSS philosophy.

### Cons

- Ceiling is real. Getting from $30k to $100k is much harder than 0 → $30k.
- Requires sustained promotion (talks, blog posts, conference appearances) that itself takes time away from the project.
- Income is lumpy and unpredictable. One large sponsor leaving can drop revenue 40% overnight.
- Tax/legal overhead for international sponsors is non-trivial.

### Honest assessment

For codegraph specifically, **a realistic ceiling for the first 18 months is $5–15k/yr, growing to maybe $25–40k/yr by year 3 if the tool is genuinely loved.** That is not a primary income for a US-based engineer. It is a meaningful supplement and a strong signal that the project is valued.

This path is **necessary regardless of whatever else we do.** Setting up sponsors costs nothing and the trickle of money is real. But it shouldn't be the *only* path unless the maintainer's plan is "this is a side project forever" (which is a legitimate plan — see Path 6).

---

## Path 2: Paid hosted offering for enterprise

Keep the OSS core fully free. Build a paid SaaS on top that solves problems large orgs have but solo developers don't: hosting, identity, audit, history, multi-repo.

### What the paid offering would include

A non-exhaustive list of things that are reasonable to charge for without breaking OSS goodwill:

- **Hosted graph viewer.** Run codegraph in CI for free; push the resulting IR to a hosted viewer that the whole engineering org can navigate without setting up infrastructure. Solves "where do I share this graph?" for orgs that don't want to run a static site.
- **Cross-repo / monorepo overlay.** When you have 50 services in 50 repos, codegraph by itself shows you 50 graphs. The hosted offering stitches them into one (resolving cross-service edges across repos). This is a real engineering project; charging for it is fair.
- **Single sign-on (SSO).** SAML, OIDC, SCIM. Standard enterprise gates.
- **Audit log.** Who viewed what, when. Required for SOC 2, ISO 27001, FedRAMP-adjacent buyers.
- **History and time travel.** Diff the graph between any two commits/branches/dates over the last N months. Local CLI gives you "this PR vs. main"; hosted gives you "main today vs. main 6 months ago."
- **Slack/Linear/Jira integrations.** "@codegraph what does this PR change structurally" in Slack. Linear comment posting. Jira ticket linking.
- **Org-wide search across stitched graphs.** Combined with cross-repo, this is an actual cross-service nav story.
- **Support and SLAs.** Email + Slack-shared-channel support, response-time SLAs, named CSM at higher tiers.

### Pricing tiers (initial straw-man)

These are starting points, not commitments. Expect to revise after the first 5 customer conversations.

| Tier | Price | Audience | What it includes |
|---|---|---|---|
| **OSS** | Free | Individuals, small teams | Local CLI, GitHub Action, static viewer. Forever free. MIT. |
| **Team** | $20/dev/month, min 5 seats ($100/mo entry) | 5–50 engineer teams | Hosted viewer, single repo or small repo set, Slack integration, 30 days history, email support. |
| **Business** | $40/dev/month, min 25 seats ($1k/mo entry) | 25–250 engineer orgs | Multi-repo stitching, SSO, 90 days history, audit log, Slack/Linear/Jira, business-hours support. |
| **Enterprise** | Custom (typically $25k–$150k/yr) | 250+ engineer orgs | Unlimited repos, unlimited history, dedicated environment option, named CSM, SLA, security review participation, custom adapters. |

### What stays in the OSS

This is the load-bearing question. Get it wrong and the goodwill evaporates.

**Always free, always OSS:**
- The core compiler / IR / adapter framework.
- The CLI, the local viewer, the GitHub Action.
- All adapters for popular open-source frameworks.
- The schema and any spec for the IR. Self-hostable forever.
- Any feature an individual developer would reasonably want for their own repo.

**Reasonable to be paid-only:**
- The *hosted* version of the viewer. (You can self-host the OSS viewer; we just won't run it for you for free.)
- Cross-repo stitching as a *service* (the algorithm should still be open; the hosted experience is paid).
- SSO, audit log, history retention beyond what a local install gives you.
- Anything that requires running infrastructure on our side.

The principle: **we charge for hosting and operations, not for capabilities.** A determined engineer at any company can stand up the OSS version themselves and get most of the value. They pay us when they don't want to.

### Pros

- Most consistent with the "open core" pattern that has actually worked for tools like Sentry, GitLab, PostHog, Mattermost, Plausible, Cal.com.
- Aligns incentives: we make the OSS great because that's the funnel.
- Recurring revenue is more sustainable than donations.
- Enterprise contracts can be 6-figures and significantly change the runway calculation.

### Cons

- Building hosted infrastructure is a real engineering and operations commitment. It changes what kind of project this is.
- Sales cycle to get to enterprise contracts is 3–9 months. That's real time.
- The temptation to put more things behind the paid wall grows over time. Many open-core projects have eroded their OSS over years (the recent Elastic/MongoDB/Redis license changes are extreme examples). Resisting this requires explicit governance.
- TAM for this specific niche may not support the operational overhead. If we end up with 10 paying customers at $20k each, that's $200k ARR and probably consumes the whole maintainer's time keeping the SaaS running.

### Honest assessment

This is the path with the highest ceiling and the highest risk of distorting the project. **Realistic 3-year outlook: $250k–$1M ARR if it works, $0 and a tired maintainer if it doesn't.**

The right test: spend 4 weeks talking to ~20 engineering managers at orgs with 50–500 engineers. Ask:

1. Do you currently have a way to understand what this PR changes structurally? (If most say "yes, we have a process," the gap is smaller than we think.)
2. Would you pay for hosted codegraph? At what price point? (Don't lead the witness.)
3. What would have to be true for you to *not* just run the OSS yourself?

If 5+ of those conversations end with "yes, we'd pay $X for Y," there's a business. If they all say "interesting, we'd probably just run the OSS," there isn't, and we should redirect energy to Path 6.

---

## Path 3: Paid premium adapters

Sell adapters for proprietary or niche frameworks (some homegrown internal RPC system, some closed-source ORM, etc.) as paid plugins.

### Why this is tempting

- It's incremental. Doesn't require building a SaaS.
- The customer who needs an adapter for their specific framework has unusually high willingness to pay (the alternative is "write it yourself," which is days-to-weeks of engineering).
- It naturally targets enterprise (who have weird internal frameworks) without needing a sales motion.

### Why this breaks OSS goodwill

Three risks, in increasing severity:

1. **Drift in adapter quality.** If the paid adapter for Framework X is meaningfully better than the OSS adapter for Framework Y, contributors stop sending PRs because they suspect we'll paywall their work.
2. **License confusion.** Mixing MIT and "premium" creates unclear messaging. New users have to figure out "is the thing I want free?" That friction kills adoption.
3. **Misaligned incentives over time.** Once revenue depends on adapter sales, there's pressure to keep popular frameworks' adapters thin in OSS so the paid ones look better. This is a slow-acting poison and very hard to resist.

The OSS projects that have tried this (paid plugins on top of free core) mostly *don't* do it for adapters or extensions to popular ecosystems. They do it for things that are clearly an additional layer (hosting, SSO, support). When you start charging for the basic content of the project, the project becomes "freemium with extra steps" and the OSS halo dims fast.

### When this could work narrowly

If a specific large customer commissions an adapter for their specific internal framework, charging them as a *contract* (not as a SKU) is fine. It's just consulting (Path 4) wearing a different hat. The deliverable is OSS, MIT, contributed back. They paid for our time, not for a license.

### Honest assessment

**Don't do this as a productized SKU.** It's the option with the worst risk/reward. If a customer wants an adapter built, do it as consulting and contribute the result back to the project. That keeps the OSS ecosystem honest.

---

## Path 4: Consulting / contract development

The maintainer takes paid contracts to build adapters, integrate codegraph into a customer's specific environment, write custom rules, deliver internal training, etc. Everything ships back to the OSS repo.

### How it works

- Open a `services.md` or contact form on the website: "We do paid integration and custom adapter work."
- Day rate: $1,500–$2,500/day for a senior maintainer, depending on geography. Block sells in 1–2 week chunks.
- All deliverables that are generally useful go back to the OSS. Customer-specific glue stays with the customer.

### Pros

- Highest hourly $ of any option here.
- Reinforces the OSS: every contract makes the tool better for everyone.
- Builds direct relationships with the kind of org that might later become a hosted-tier customer (free funnel for Path 2).
- Zero up-front investment. No SaaS to build.
- Easy to taper up or down based on the maintainer's other commitments.

### Cons

- Doesn't scale beyond the maintainer's hours. There is a hard cap at maybe $300–500k/yr if every working day is billable, which it won't be.
- Project velocity goes down: time spent on customer X's adapter is time not spent on roadmap items.
- Lumpy: a contract ends and the next one might be 8 weeks away.
- If the project becomes too tied to consulting, the OSS roadmap starts to look like "what the last customer asked for."

### Honest assessment

**This is the most reliable income source for a single-maintainer OSS project of this shape.** $50–150k/yr is achievable in year 1 with modest hustle. It pairs naturally with sponsorship (Path 1) and can fund the maintainer's living costs while the project matures.

The biggest risk is that it *succeeds* and pulls the maintainer away from open-roadmap work. Mitigate by setting an explicit cap (e.g., "20% of work weeks are billable, 80% is open roadmap") and writing it down somewhere visible.

---

## Path 5: Acqui-hire / VC path

Raise venture capital to grow the project into a company. End-state is either an IPO (essentially impossible at this TAM) or an acquisition by a larger player.

### What this would look like

- Pre-seed/seed round in the $1–3M range. Realistic at codegraph's stage *if* there's traction (a few thousand stars, real adoption, a few paying design-partner orgs).
- 18–24 months of runway. Hire 2–4 engineers, maybe a founding salesperson.
- Hard push on Path 2 (hosted offering). Open-core SaaS, enterprise sales motion.
- Outcome A: Series A based on $1M+ ARR within 18 months. Continues the venture treadmill.
- Outcome B: Tuck-in acquisition by GitHub, GitLab, Atlassian, JetBrains, Sourcegraph, GitKraken, or a code-quality vendor (Sonar, Snyk, Codacy). Maintainer walks away with $1–5M and a 1–2 year earn-out.
- Outcome C: Run out of money. Project either survives as OSS (best case) or is abandoned.

### Comparable outcomes in the space

- **Sourcegraph:** Raised ~$225M total. Pivoted hard to AI (Cody) when pure code search couldn't get to venture-scale numbers. Now Enterprise-only at $59/user/mo. Survived, but the original mission shifted.
- **CodeSee:** Raised seed funding, struggled, acqui-hired by GitKraken in 2024 with significant downsizing. Founders presumably did okay; the product as it existed is largely gone.
- **Bloop:** Shut down April 2026. The stated reason was inability to find a business model. Most users were free.
- **Sourcetrail:** Never raised serious capital. Founders shut it down in 2021 and went to other jobs.

The pattern: in this category, the big raises have been hard to justify, and the small projects mostly didn't try to raise at all.

### Pros (of the VC path)

- Capital lets you build the SaaS and the sales motion in parallel rather than sequentially. That's a real timing advantage.
- A successful exit can be life-changing for the maintainer.
- Validation: enterprise buyers take a funded company more seriously than a single-maintainer OSS project.

### Cons

- TAM is the central problem. VCs won't fund this unless there's a compelling story for $50M+ ARR. We don't have one.
- Even if you raise, the bar for the next round is brutal. Companies that raise seed-into-this-TAM either get acquired early (best case) or die.
- The OSS license becomes a board-room conversation. There's quiet pressure over time to relicense, dual-license, or move features behind a SSPL/BUSL/AGPL wall. (Look at the recent Elastic, MongoDB, Redis, HashiCorp stories.) The original OSS promise gets eroded.
- Maintainer's role changes from "developer" to "founder." That's a different job and not everyone wants it.
- If it fails, the project may end up in license limbo. Acquired projects often go into maintenance mode at the acquirer (CodeSee post-GitKraken is a recent example).

### Honest assessment

**Skip this path** unless one of two things is true:

1. The maintainer *wants* to be a founder and run a venture-backed company, with all the upside and stress that implies. This is a values question, not a strategy question.
2. There's an unsolicited acquisition offer from a larger player who specifically wants the codegraph IP and team. In that case, evaluate it on its own terms — it's fundamentally different from "raise venture capital and grow."

Otherwise: the TAM doesn't support this, the comparable outcomes are sobering, and the cost to the project's character is high.

---

## Path 6: Nothing — keep it as a side project

Don't try to monetize. Maintain the project on nights and weekends. Take sponsorship (Path 1) but don't set quarterly goals. Take consulting (Path 4) opportunistically. Refuse to build a hosted offering or raise money.

### Why this is a serious option, not a cop-out

- The project's *values* (MIT, local-first, no LLM, no SaaS lock-in) are easier to honor without a business model that pulls in the opposite direction.
- The maintainer keeps full control of the roadmap, the release schedule, and the time commitment.
- There's no pressure to "grow" — the project can be exactly as big as its actual user base needs it to be.
- Several of the most-loved developer tools in history were maintained this way for years before any commercial wrapper appeared (or never appeared): SQLite, jq, ripgrep, bat, htop, fzf. Some of those have funding, some don't, but none were started with a "monetize this" plan.

### What this requires

- A primary income from somewhere else (a day job, a partner's income, accumulated savings). The maintainer must not be financially dependent on the project.
- An honest understanding from the maintainer that this is the chosen path, not a fallback. The temptation to "just try a small SaaS" creeps in over time and erodes the project's character.
- Modest expectations from users. Bug fixes happen when they happen. PRs are merged when the maintainer has time.

### What this gives up

- The project will grow more slowly. Some features that would require sustained engineering effort (cross-repo stitching, hosted viewer, etc.) probably won't get built unless someone else builds them.
- The maintainer's income is whatever their day job pays. Sponsorship/consulting can supplement but won't replace.
- The competitive landscape shifts. If a well-funded competitor launches a similar OSS-with-paid-hosting product, codegraph won't be able to match their rate of feature development.

### Honest assessment

**This may be the right answer for codegraph.** The TAM analysis at the top of this document strongly suggests there isn't a venture-scale business here. There's also probably not a comfortable lifestyle business — building and operating a SaaS for a small enterprise market is harder than it looks, and the gap between "I have 30 paying customers" and "I can pay myself a salary plus benefits" is wider than most maintainers expect.

If the maintainer's underlying goals are (a) make this tool real, (b) make it useful to people who want it, and (c) keep it free and open forever, then **Path 6 honors all three goals more directly than any of Paths 1–5.** Paths 1 and 4 (sponsorship and opportunistic consulting) layer naturally on top of Path 6 without changing its character.

The only reason to choose another path over this one is if (i) the maintainer specifically wants to build a company, or (ii) the project hits a level of adoption where saying "no, I won't take your money" becomes silly. Neither is a foregone conclusion.

---

## Recommendation

A primary path with rationale, given everything above.

### Primary recommendation: Path 6 + Path 1 + opportunistic Path 4

- **Path 6 (side project) as the default mode.** Set expectations with users, contributors, and (especially) the maintainer that this project is not trying to be a company. The bar for changing this is "we have so many users that not having a sustainable model is becoming a real problem," which is a high bar and worth waiting for.

- **Path 1 (Sponsors / Open Collective) from day 1.** Cost is zero. Set up GitHub Sponsors and Open Collective. Add a "Sponsor" button to the README. Don't push it hard, but accept the trickle. Realistic outcome: $5–20k/yr after 12–18 months, growing slowly. That's not life-changing, but it's real and aligned with the project's values.

- **Path 4 (consulting) opportunistically.** When a company asks "can you build us an adapter / help us integrate / write custom rules," say yes at $1,500–$2,500/day, deliver the work, and contribute the general parts back to OSS. Cap this at maybe 4–8 weeks per year so it doesn't take over the project. Realistic outcome: $20–80k/yr depending on demand.

Combined realistic income from this stack: **$25–100k/yr by year 2, scaling slowly.** Probably enough to be a meaningful supplement to a day job, not enough to replace one in most markets.

### Re-evaluation triggers

Three signals would warrant re-opening this discussion and considering Path 2 (hosted offering):

1. **>5 unsolicited inbound asks per month** for "do you offer a hosted version / SSO / multi-repo." Right now this number is zero.
2. **A specific large customer committing to a $50k+/yr design-partner deal** for a hosted version they would help us build. That changes the calculus — we're being paid to validate the offering.
3. **A clear sign that an adjacent competitor is going to take the same niche if we don't.** If GitKraken (post-CodeSee) or Sourcegraph or some new entrant launches an open-core offering specifically for cross-service typed graphs with PR diffs, we either build something competitive or accept that we don't own this niche.

Until one of those happens, we shouldn't divert energy from making the OSS better.

### What we explicitly will not do

- **No paid premium adapters as a SKU (Path 3).** This breaks OSS goodwill and the math doesn't make it worth it.
- **No VC raise (Path 5)** unless an unsolicited acquisition offer materializes, in which case we evaluate it on its own merits. We will not seek a raise on the assumption that "TAM will appear" — it won't.
- **No telemetry or sign-in in the OSS tool, ever.** This is a values commitment. The CLI is local-first forever; we will not add phone-home behavior to drive funnel into a paid product.

---

## Closing honesty

Most OSS-with-business-model stories fail. The graveyard for code-understanding tools specifically is well-populated (Sourcetrail, CodeSee, Bloop, and that's just in the last five years). The default outcome of "I'm going to monetize my OSS project" is "I burned a year of my life and produced neither a sustainable business nor a thriving OSS project."

Path 6 sounds modest. It is. That's the point. The maintainer's life optimization is probably "have a day job that pays well, run codegraph as a side project that's important to me but doesn't have to grow on a venture timeline, take money when it's offered without designing the project around money."

The world has plenty of code-understanding companies. The world has a shortage of code-understanding tools that are demonstrably and durably free, deterministic, local-first, and well-engineered. Being the latter is more valuable to developers — and probably more valuable to the maintainer's long-term motivation — than being the former.

If this analysis is wrong, it'll be wrong in a knowable way: codegraph will get more traction than expected, more inbound than expected, and the right thing to do will become obvious. Until that happens, ship the OSS.
