# Ryngo corpus harness

Tracks compiler progress across a fixed list of public repos. Every time
the analyzer or an adapter improves, this harness measures the impact:
"+423 http-route nodes after Phase 5 shipped."

## Files

- `corpus.js` — the ~50 repos under test. Each entry has `url`, `family`,
  `lang`, and a short `note`. Edit the list to track different repos.
- `classifications.js` — the ~35 categories we count: file nodes,
  function defs (with params, with return types), classes (with members),
  notebook cells, http routes (per framework), db reads/writes, env
  reads, edge resolution flavors, effect labels, etc. Add a new entry
  when you ship a new parser feature.
- `results/<ISO>.json` — full per-repo result for each run. Includes
  IR stats, classification counts, adapter list, first 5 diagnostics.
- `results/latest.md` — human-readable summary, overwritten each run.
- `results/history.json` — one row per run with totals + adapter
  coverage. The runner diffs new totals against the most recent prior
  row to surface deltas.

## Running

```bash
npm run corpus              # one sweep (~5–10 min)
npm run corpus -- --filter=fastapi    # only repos whose URL contains 'fastapi'
npm run corpus:watch        # loop every CORPUS_INTERVAL_MIN minutes (default 30)
```

Tunables (env):

- `CORPUS_CONCURRENCY` — default 3. How many clones run in parallel.
- `CORPUS_TIMEOUT_MS`  — default 90_000. Per-repo cap.
- `CORPUS_INTERVAL_MIN` — default 30. Watcher cadence.

## Reading the report

After each run, `latest.md` shows:

1. **Header** — date, ok/total, elapsed, previous-run pointer.
2. **Classification coverage** — totals by classification + Δ since last
   run. Big positive deltas are wins; large negatives are regressions.
3. **Adapter coverage** — how many repos triggered each adapter at least
   once.
4. **Per-repo** — one row per corpus entry with files, defs, classes,
   routes, db, env counts and which adapters fired.

## Adding a new classification

Add a row to `CLASSIFICATIONS` in `classifications.js`:

```js
{
  id: "my_new_thing",          // stable across runs (joined in history.json)
  group: "adapters",            // freeform — used to group rows in the table
  label: "My new thing",
  count: (ir) => byKind(ir, "my-new-thing"),
}
```

The next run will start tracking it.

## Adding a new repo

Add an entry to `CORPUS` in `corpus.js`. The runner keys results by
`url`, so historical rows for the new entry start at zero (no fake
backfill).

## Adding the runner to CI / cron

The runner exits `0` even if individual repos error (so CI doesn't fail
on a flaky GitHub clone). Wrap it in your scheduler and read
`test/results/history.json` for trend graphs.
