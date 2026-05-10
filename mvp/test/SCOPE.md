# Corpus harness — forward scope

Detailed plan for the next iterations of the Ryngo corpus harness
(Phase 6 in the master plan). The goal: turn the harness from "we have
a baseline" into "the compiler cannot quietly regress."

This is a planning document. None of it is implemented yet beyond what
already shipped in 6.0 (51 repos × 37 classifications, runner +
watcher + JSON/MD/history outputs).

---

## Where we are (6.0 baseline)

```
51/51 repos analyzed in ~70 s (concurrency=4)
- 25,383 file nodes
- 31,813 function defs (53% with ≥1 typed param, 41% with return type)
-  9,196 class defs (81% with members)
-    737 HTTP routes (Express 583, FastAPI 75, Next.js 79)
-     18 DB models, 363 db-write edges, 122 db-read edges
-    321 env-var leaves, 704 env-read edges
-     70 adapter activations
```

The baseline already exposed two real defects:

1. **Express adapter false positives.** `axios/axios` reports 239 fake
   routes (it just happens to have lots of `app.METHOD(string, fn)`
   call sites for its tests/middleware patterns); `socket.io` 44;
   `nestjs/nest` 25. The current Express detect requires *either*
   importing `express` *or* having a route-shaped call site — too
   loose.
2. **Adapter detection is global, not file-scoped.** Once we decide a
   repo is "Express", the adapter walks every file. A monorepo with
   one Express service buried in `apps/api/` runs the express adapter
   against `apps/web/` (a Next.js app) too.

Both are fixable. The corpus is what makes them visible.

---

## Iteration 6.1 — Express adapter false-positive cleanup

### Goal

Drop axios's fake-route count from 239 → 0. Don't lose any of the
real routes on `madhums/node-express-mongoose` (currently 2),
`expressjs/cors` (10), `expressjs/multer` (7), or
`vercel/commerce` (5 via Next.js, those are correct).

### Detect tightening

Two signals must BOTH be true for a file to be considered an Express
route source:

1. The file (or any ancestor in the same package) imports the
   `express` package — checked via the resolver's `imports-package`
   edge to `pkg:express`.
2. The variable on which `.METHOD(...)` is called must trace to
   `express()` or `express.Router()` — i.e. the binding's
   originalName must include "express" OR the binding must come from
   the express import.

### Implementation sketch

`mvp/lib/adapters/express.js`:

```js
async detect(ctx) {
  // BOTH: file imports express AND has at least one app.METHOD() call
  for (const { parsed } of ctx.parsedFiles) {
    if (parsed.lang !== "ts") continue;
    const importsExpress = (parsed.imports || []).some(
      (imp) => imp.spec === "express" || imp.spec.startsWith("express/"),
    );
    if (!importsExpress) continue;
    // sanity: do we find the call shape too?
    return true;
  }
  return false;
},

async analyzeFile(pf, ctx) {
  if (pf.parsed.lang !== "ts") return null;
  // Per-file gate: only files that import express directly emit routes.
  const importsExpress = (pf.parsed.imports || []).some(
    (imp) => imp.spec === "express" || imp.spec.startsWith("express/"),
  );
  if (!importsExpress) return null;

  // Track which local bindings are from the express import — only
  // .METHOD() calls on those bindings count as route registrations.
  const expressBindings = new Set();
  for (const imp of pf.parsed.imports || []) {
    if (imp.spec === "express" || imp.spec.startsWith("express/")) {
      for (const local of Object.keys(imp.bindings || {})) {
        expressBindings.add(local);
      }
    }
  }

  // Re-walk the source for `expressBinding()` and `expressBinding.Router()`
  // assignments to find which local *router* names are valid route hosts.
  // (e.g. `const app = express()` → app is valid; `const r = Router()` → r is valid)
  const text = await ctx.readFile(pf.relPath);
  const validRouters = collectExpressApps(text, expressBindings);
  if (validRouters.size === 0) return null;

  const routeRe = new RegExp(
    `\\b(\\w+)\\.(${HTTP_METHODS.join("|")})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
    "g",
  );
  // … only emit routes when m[1] (the subject) is in validRouters.
}
```

Helper:

```js
function collectExpressApps(text, expressBindings) {
  const out = new Set();
  // const app = express()
  const re1 = /\b(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*\(/g;
  let m;
  while ((m = re1.exec(text)) !== null) {
    if (expressBindings.has(m[2])) out.add(m[1]);
  }
  // const router = express.Router()
  const re2 = /\b(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\.Router\s*\(/g;
  while ((m = re2.exec(text)) !== null) {
    if (expressBindings.has(m[2])) out.add(m[1]);
  }
  // const router = Router()  (when Router is imported separately)
  if (expressBindings.has("Router")) {
    const re3 = /\b(?:const|let|var)\s+(\w+)\s*=\s*Router\s*\(/g;
    while ((m = re3.exec(text)) !== null) out.add(m[1]);
  }
  return out;
}
```

### Verification

Re-run `npm run corpus`. Expected deltas vs baseline:

- `axios/axios` Express routes: 239 → 0 (✓)
- `socketio/socket.io` Express routes: 44 → 0 (the `app.get` calls
  there are on a stub object, not Express)
- `nestjs/nest` Express routes: 25 → 0 (Nest uses Express internally
  but exposes its own routing layer — we shouldn't claim the routes)
- `madhums/node-express-mongoose` Express routes: 2 → 2 (preserve)
- `expressjs/cors` Express routes: 10 → ≤2 (cors is middleware, the
  10 we report today come from its tests; we'd preserve only the
  real ones in the example app)
- `expressjs/multer` Express routes: 7 → ≤2 (same reasoning)
- Total Express routes corpus-wide: 583 → ~30

### Risk

The fastapi adapter has the same shape of risk; its
`tiangolo/full-stack-fastapi-template` shows 18 routes which is
plausible, and `tiangolo/sqlmodel` shows 57 which is plausible. Real
FastAPI files are obviously decorator-driven, so false positives are
much less likely there.

### Estimate

~30 minutes. Mostly tightening one regex and adding one helper.

---

## Iteration 6.2 — Anomaly detection per row

### Goal

When a single repo's classification count is wildly out of line with
its peers (same family / similar size), flag it. Catches future
regressions before they become "we shipped this and didn't notice."

### Mechanism

After the corpus runs, compute per-classification:

- median(value)
- p95(value)
- IQR

For each repo's row, flag any cell where:

- `value > 5 × median` AND `count > 20` (over-emission) → 🔴
- `value > 0` for a stub-language repo (over-emission on stubs) → 🔴
- `value === 0` for a repo where the same classification has
  always-been-positive-history → 🟡

Render as a column in `latest.md`:

```
| auth0/jsonwebtoken | js | ok | … | (no flags) |
| axios/axios        | js | ok | … | 🔴 routes (239 vs median 0) |
```

### Implementation sketch

New file `mvp/test/anomaly.js`:

```js
export function flagAnomalies(currentResults, history) {
  const flags = new Map();   // repoUrl → string[]
  for (const c of CLASSIFICATIONS) {
    const values = currentResults
      .filter((r) => r.ok)
      .map((r) => r.classifications[c.id] || 0);
    const median = quantile(values, 0.5);
    for (const r of currentResults) {
      if (!r.ok) continue;
      const v = r.classifications[c.id] || 0;
      if (median > 0 && v > 5 * median && v > 20) {
        addFlag(flags, r.url, `🔴 ${c.label}: ${v} vs median ${median}`);
      }
      // Stub-language emission check
      if (STUB_LANGS.has(r.lang) && v > 0 && c.group !== "files" && c.group !== "meta") {
        addFlag(flags, r.url, `🔴 ${c.label} on ${r.lang} stub`);
      }
    }
  }
  return flags;
}
```

Hooked into the runner so flags appear in `latest.md` and a
top-line "alerts" count appears in stdout.

### Estimate

~45 minutes.

---

## Iteration 6.3 — Per-language / per-repo expectation ranges

### Goal

Hard-coded "this repo *must* produce ≥N routes / ≥M classes / etc."
expectations. If the runner sees fewer, exit with a non-zero code so
CI can block the merge.

### Mechanism

Annotate each corpus entry with optional `expects`:

```js
{
  url: "https://github.com/tiangolo/sqlmodel",
  family: "framework", lang: "py", note: "SQLModel",
  expects: {
    fn_total: { min: 500 },
    class_total: { min: 150 },
    http_routes_fastapi: { min: 30 },
    fn_with_typed_params: { min: 100 },
  },
},
{
  url: "https://github.com/madhums/node-express-mongoose",
  family: "app", lang: "js", note: "real Express app",
  expects: {
    http_routes_express: { min: 1 },  // we know there's at least 1
  },
},
```

Runner checks `expects` against actual values; failures are reported
in the summary AND the runner's exit code becomes nonzero (so CI
blocks).

### Initial expectation set

| Repo | Classification | Min |
|---|---|---:|
| tiangolo/sqlmodel | http_routes_fastapi | 30 |
| tiangolo/sqlmodel | fn_total | 500 |
| tiangolo/full-stack-fastapi-template | http_routes_fastapi | 10 |
| tiangolo/fastapi | (after 5.1 tree-sitter ships) fn_total | 100 |
| madhums/node-express-mongoose | http_routes_express | 1 |
| expressjs/cors | http_routes_express | 1 |
| vercel/commerce | http_routes_nextjs | 3 |
| shadcn-ui/ui | http_routes_nextjs | 5 |
| prisma/prisma-examples | db_models | 1 |
| prisma/prisma-examples | db_write_edges | 5 |
| karpathy/autoresearch | cell_total | 6 |
| karpathy/nanoGPT | cell_total | 1 |
| pydantic/pydantic | class_with_members | 100 |

Each represents real production behaviour. If a parser change drops
any of these, the run fails immediately with a precise pointer at
which classification / which repo.

### Estimate

~60 minutes (includes seeding ~25 expectation rows).

---

## Iteration 6.4 — CI integration / PR blocker

### Goal

Make the corpus run a required check on every Ryngo PR. A parser
refactor that drops 50 routes anywhere can't merge until it's
explained.

### Mechanism

A GitHub Action at `.github/workflows/corpus.yml`:

```yaml
on: [pull_request]
jobs:
  corpus:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd mvp && npm ci
      - run: cd mvp && CORPUS_TIMEOUT_MS=180000 CORPUS_CONCURRENCY=4 npm run corpus
      - name: Compare to main baseline
        run: cd mvp && node scripts/corpus-compare.js
        # exits 1 if any classification dropped >5% without a tagged
        # explanation in the PR description
      - uses: actions/upload-artifact@v4
        with:
          name: corpus-report
          path: mvp/test/results/latest.md
```

Add `mvp/scripts/corpus-compare.js` that diffs against
`mvp/test/results/baseline-main.json` (committed snapshot of `main`'s
last corpus run) and exits nonzero on regression.

The PR author can opt in to an explicit "regression-allowed" tag
(`Corpus-Allow-Regression: classification1,classification2`) in the
PR description if a drop is intentional (e.g. stricter detect
removing false positives — exactly Iteration 6.1).

### Estimate

~90 minutes. Most of the effort is GitHub Actions plumbing + the
compare script; the runner already does the heavy lifting.

---

## Corpus expansion (orthogonal to 6.1–6.4)

The 51 we have today is a good start, not the right end-state. We're
under-represented in:

| Gap | Repo to add |
|---|---|
| GraphQL server | `apollographql/apollo-server` |
| WebSocket-heavy | `socketio/socket.io-client` (already have server) |
| Real-world Django | `wagtail/wagtail` or `saleor/saleor` |
| Real-world Rails app | `discourse/discourse` (caveat: huge, will truncate) |
| Real-world Spring app | `spring-projects/spring-boot-starter-* sample` |
| Modern Go web | `gin-gonic/gin` (still stubs but exercises Go path) |
| Modern Rust web | `tokio-rs/axum` |
| C-heavy | `nginx/nginx` or `redis/redis` (stubs) |
| Hugo / static-site | `gohugoio/hugo` (stub) |
| Heavy SQL (Prisma alt) | `drizzle-team/drizzle-orm` |
| Modern monorepo | `vercel/turbo` |
| Lerna monorepo | `lerna/lerna` |
| Rush monorepo | `microsoft/rushstack` |
| Backend + frontend split | `cal-com/cal.com` |
| Notebook ML | `huggingface/notebooks` |
| Notebook research | `fastai/course22` |
| ASGI + sync split | `encode/uvicorn` |
| GraphQL Python | `strawberry-graphql/strawberry` |
| Pydantic-heavy app | `Textualize/textual` |

Add 15–20 of these to bring the corpus to ~70 entries. Diversity
matters more than count beyond 70 — diminishing returns past that
point because clone time grows linearly.

### Estimate

5 min per entry to add + verify. Whole batch: ~90 min including a
clean re-baseline.

---

## Classification gaps

Categories the harness doesn't yet count:

| Group | Missing classification | Lands when |
|---|---|---|
| defs | Async functions (separate from total) | trivial; add `n.data?.async === true` once parsers tag it |
| defs | Generator functions | trivial once parsers tag them |
| defs | Decorated functions / decorated classes | need parser to attach `decorators: string[]` |
| defs | Constructors specifically | once class members distinguish ctor |
| defs | Type aliases / interfaces | extract these as their own node kind in 5.1 (real tree-sitter) |
| defs | Enums | same |
| imports | Re-exports specifically | already extracted; just don't count them as a separate class |
| calls | Method calls (`obj.foo()`) vs function calls (`foo()`) | parser change; tag call's `kind` |
| calls | Cross-package calls (file in pkg A → file in pkg B) | once we have package boundaries |
| effects | Functions transitively reaching `fs-write` | already supported, just not surfaced — quick add |
| effects | Functions transitively reaching `exec` | same |
| effects | Functions reaching multiple sinks | composite; more useful for "untrusted input → db-write" alarms |
| meta | IR byte-size after compactJson projection | for "is the LLM payload getting bigger?" alarms |
| meta | analyze ms (median, p95) | per-run perf tracking |

### Estimate

Each is 1–5 minutes of `classifications.js` additions + a re-run.
Whole batch: ~40 minutes.

---

## Trend visualization (6.5, optional)

`history.json` accumulates a row per run but you can't see the trend
without manually plotting. Optional small win:

- `mvp/scripts/corpus-trend.js` — reads history.json, generates an
  ASCII sparkline per classification across the last N runs:
  ```
  HTTP routes (any)        ▁▁▂▂▂▆▇█  583 → 612 (+29 last 7 days)
  Functions with returntype ▂▃▃▄▄▅▆▆ 12929 → 18402 (+5473 last 7 days)
  ```
- Or a static HTML page at `test/results/trend.html` that plots
  history.json with `<canvas>` + a tiny inline charting fn.

Bonus: makes Phase 5.1 (tree-sitter) ship its real value visible at a
glance.

### Estimate

~60 minutes.

---

## Suggested order

| Order | Iteration | Time | Why |
|---|---|---|---|
| 1 | 6.1 Express cleanup | 30 m | Fixes the most embarrassing baseline number |
| 2 | 6.3 Per-repo expectations | 60 m | Locks in the corpus as a real regression sentinel |
| 3 | 6.2 Anomaly flags | 45 m | Adds visibility on top of the locks |
| 4 | classification gaps | 40 m | Cheap additive coverage |
| 5 | corpus expansion (15 repos) | 90 m | Width before depth |
| 6 | 6.4 CI / PR blocker | 90 m | Fully closes the loop |
| 7 | 6.5 trend viz | 60 m | Sales / UX moment, optional |

Total to "Phase 6 complete": **~7 hours of focused work**, spread
across 2-3 ship cycles. Each iteration is independent — you can stop
after any one and the harness is more useful than before.

---

## What this doesn't do

1. **No semantic correctness checks.** The corpus measures recall
   ("did we extract a route?"), not correctness ("is the route
   correctly typed?"). Type correctness is for a future
   `corpus-types` harness — out of scope for Phase 6.
2. **No multi-language *quality* comparison.** Phase 5.4 / 5.5 / 5.8
   will land Go / Rust / Java backends; the corpus will then start
   producing real numbers for those rows. Until then, the stub-language
   rows are correctly zero (graceful degradation, by design).
3. **No comparing to other tools.** "Sourcegraph extracts X for this
   repo" is not the question — Ryngo is structural, not semantic, and
   the metrics differ.
