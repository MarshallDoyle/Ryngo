# bench/

Performance benchmarks for codegraph. Tracks the four hot paths called
out in `design/incremental.md` §11 and gates regressions in CI.

## What's measured

| File                    | What it benchmarks                                            | Target (from design)                       |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `index-perf.bench.ts`   | Full indexer over 100 / 1K / 10K-file synthetic repos (cold + warm) | warm 10K < 30 s, cold 10K < 100 s          |
| `diff-perf.bench.ts`    | `diffIR` over IR pairs at 1K / 10K / 100K nodes               | < 2 s for 100K nodes                       |
| `layout-perf.bench.ts`  | `computeLayout` at the same node counts                       | < 500 ms for 1K nodes (off-thread)         |
| `load-perf.bench.ts`    | `readFile` + `JSON.parse` + `validateIR` for an IR document   | empirical; baselined and gated at -20%     |

All benches use [`mitata`](https://github.com/evanwashere/mitata) for
timing. Synthetic IR comes from `@codegraph/core`'s sample generator;
synthetic source trees come from `bench/index.ts::createTempRepo`.

## Running

```
pnpm bench                    # runs all four files end-to-end
pnpm bench:index              # one bench file at a time, e.g. just the indexer
pnpm bench:diff
pnpm bench:layout
pnpm bench:load

pnpm bench:gate               # runs all four with CG_BENCH_JSON=1, compares to baseline.json
pnpm bench:gate -- --update   # rewrite baseline.json
pnpm bench:gate -- --json     # emit JSON only (CI consumes this)
```

The `pnpm bench*` scripts are owned by the test-harness teammate; this
package itself only owns the bench files plus
`scripts/perf-regression.ts`.

A bench file exits 0 with a `[skip]` warning when its required
@codegraph dependency hasn't landed yet — the suite degrades
gracefully so this doesn't block other teams while the public exports
from `@codegraph/core` and `@codegraph/viewer` are still being
finalized.

## Regression gating

`scripts/perf-regression.ts` runs every `*.bench.ts` file with
`CG_BENCH_JSON=1`, captures each bench's median ns/op, and compares to
`bench/baseline.json`. The thresholds match
`design/test-strategy.md` §1.8:

- **Per-bench:** any single bench >20% slower than baseline fails the
  build (exit 1).
- **Geomean:** if the geometric mean of all ratios is >10% slower, the
  script prints a warning. Today this is informational only — promote
  to a hard fail once the suite's baseline is stable enough that 10%
  noise floors aren't a concern.

New benches without a baseline entry are reported `[new]` and don't
fail. Removed entries (present in baseline, absent from current) are
listed under "removed".

### Baseline format

`bench/baseline.json` is committed and reviewed manually:

```json
{
  "schemaVersion": 1,
  "runner": "ubuntu-22.04",
  "node": "v22.x.x",
  "createdAt": "2026-05-09T00:00:00.000Z",
  "benchmarks": {
    "diff-perf.bench.ts::diff 10K nodes::diffIR (10K)": { "ns": 12345678 }
  }
}
```

Update protocol when intentionally accepting a regression:

1. Run `pnpm bench:gate -- --update` on the same runner type as CI
   (`ubuntu-22.04`).
2. Commit the baseline change in the same PR as the change that
   justifies it.
3. Title prefix `[perf]` is required (`design/test-strategy.md` §10.3).
4. Reviewers eyeball the diff; large unexplained jumps get pushed back.

When the runner image itself changes (e.g. ubuntu-22.04 → 24.04), the
baseline is invalidated. Rebaseline with a `[bench-rebaseline]` commit
and a one-paragraph note in the PR explaining the move.

## Anti-flake

Per `design/test-strategy.md` §1.8:

- mitata default sample sizes are kept (median over many iterations).
- Benches pin to `ubuntu-22.04`, not `ubuntu-latest`.
- Per-bench threshold is 20% — empirically large enough to absorb the
  5–10% noise on shared CI without masking real regressions, which
  tend to be 30%+ when they happen.

If a single PR shows a flaky regression, re-run the workflow once
before pushing back on the author. If it persists across two runs on
the same SHA, treat it as real.

## CI wiring

Owned by the test-harness teammate. The workflow runs
`pnpm bench:gate` on every PR against `main`. Cache the
`node_modules` so we don't pay install cost on every bench run; the
synthetic file trees are regenerated each run (deterministic seed,
~1 s for 10K files — negligible).

## Adding a new bench

1. Add a new `bench/<name>-perf.bench.ts` file. Follow the shape of
   the existing four: import from `./index.js`, call `startBench()`
   for the mitata wrapper, finish with `await runAndReport()`.
2. Append the filename to `BENCH_FILES` in
   `scripts/perf-regression.ts`.
3. Run `pnpm bench:gate -- --update` to seed baseline entries.
4. Commit the new bench, the updated baseline, and a one-paragraph
   note in your PR explaining what the bench protects against.

## Conventions

- **No emoji**, in source or output (`STRUCTURE.md` §9.1).
- **Determinism.** Every bench uses fixed seeds. Same seed + same
  size = byte-identical IR = comparable timings across runs.
- **Setup outside the timed region.** Build IRs, write files, parse
  baselines etc. before the `bench(...)` call. mitata calls the body
  hundreds of times — anything inside it must be the kernel under
  test.
- **No mocking of language internals.** The indexer bench runs real
  parsers on real source. Same rule as
  `design/test-strategy.md` §7.1.

## Open questions

1. **Worker thread vs. main thread for layout.** The viewer runs
   layout off-thread; we benchmark the kernel synchronously. If
   postMessage cost becomes interesting, add a separate
   "off-thread layout RTT" bench that measures the round-trip.
2. **Memory pressure.** Today we measure wall-clock only. Adding
   peak-RSS would catch a class of regressions (e.g. a diff
   algorithm that materializes a full O(n²) matrix). Plumb through
   `process.memoryUsage()` alongside ns/op when we have a place to
   put it in the baseline format.
3. **100K-file indexer bench.** Out of scope today — the design
   targets are at 10K. Add when the incremental cache work lands and
   warm-path 10K is comfortably under 30s; until then, 10K is the
   meaningful ceiling.
