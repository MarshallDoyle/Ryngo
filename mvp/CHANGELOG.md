# Ryngo — activity log

Per `AGENTS.md` convention: one line per ship. `date · agent · one
sentence`. Newest at top.

2026-05-10  claude  GraphQL adapter — SDL `type/input/interface/enum/union/scalar` declarations from `.graphql` files + Query/Mutation/Subscription resolver maps from JS/TS; activates on 3 corpus repos (graphql-js: 575 types, nestjs, prisma-examples)
2026-05-10  claude  fix(corpus): `--filter` runs no longer write history.json or latest.md (their tiny totals were poisoning delta math on subsequent full runs)
2026-05-10  claude  Django adapter — urls.py routes (path / re_path / url) + db-models from `models.Model` subclasses; verified 11 routes + 7 models on `wagtail/bakerydemo`
2026-05-10  claude  Phase 6.4 — corpus CI workflow at `.github/workflows/corpus.yml` (PR-blocking on hard min violations; runs on PR + push to main)
2026-05-10  claude  Phase 6.3 — per-repo `expects` blocks (corpus harness exits non-zero on hard min violations; 13 sentinel repos seeded)
