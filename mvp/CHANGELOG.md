# Ryngo — activity log

Per `AGENTS.md` convention: one line per ship. `date · agent · one
sentence`. Newest at top.

2026-05-10  claude  feat(viewer): focus-view layout polish — hub re-centers when only one side has satellites; collapsed-height grid; column count derived from focus-canvas aspect (55 % of window); card shadows on all typed nodes + layers; bolder hover lift; focus-graph edges thicker for legibility when 20+ lines fan out from one hub
2026-05-10  claude  feat(viewer): 1 s smooth fade between light and dark theme (`html.theming` class added on toggle, removed ~1.1 s later, scoped CSS so hover stays snappy outside the toggle window)
2026-05-10  claude  Phase 4.5.1 — landing page at `/` with how-to-use steps + MCP install instructions (Claude Code, Claude Desktop, ChatGPT Apps SDK, self-host); SPA moved to `/app`; Ryngo palette + dark via `prefers-color-scheme`
2026-05-10  claude  Move Dockerfile + `.dockerignore` to repo root with `mvp/`-scoped paths (matches the existing Cloud Build trigger; legacy Plinth corpus excluded from build context)
2026-05-10  claude  GraphQL adapter — SDL `type/input/interface/enum/union/scalar` declarations from `.graphql` files + Query/Mutation/Subscription resolver maps from JS/TS; activates on 3 corpus repos (graphql-js: 575 types, nestjs, prisma-examples)
2026-05-10  claude  fix(corpus): `--filter` runs no longer write history.json or latest.md (their tiny totals were poisoning delta math on subsequent full runs)
2026-05-10  claude  Django adapter — urls.py routes (path / re_path / url) + db-models from `models.Model` subclasses; verified 11 routes + 7 models on `wagtail/bakerydemo`
2026-05-10  claude  Phase 6.4 — corpus CI workflow at `.github/workflows/corpus.yml` (PR-blocking on hard min violations; runs on PR + push to main)
2026-05-10  claude  Phase 6.3 — per-repo `expects` blocks (corpus harness exits non-zero on hard min violations; 13 sentinel repos seeded)
