/**
 * Diff algorithm benchmark.
 *
 * Diffs IR pairs at 1K, 10K, and 100K nodes with ~5% churn. Target,
 * from design/incremental.md §11: < 2s for 100K nodes.
 *
 * The bench measures the diff call only — IR construction happens in
 * the setup phase outside the timed region. mitata's `bench(...)`
 * invokes its body repeatedly, so we capture the IR pair in a closure.
 *
 * If `@codegraph/core` doesn't yet export `diffIR`, the bench logs a
 * skip line and exits 0.
 */

import { NODE_BUCKETS, makeDiffPair, startBench, type NodeBucket } from './index.js';

type IR = ReturnType<typeof makeDiffPair>['before'];
type DiffFn = (before: IR, after: IR) => unknown;

interface CoreSurface {
  diffIR?: DiffFn;
}

async function loadDiff(): Promise<DiffFn | null> {
  try {
    const mod = (await import('@codegraph/core')) as CoreSurface;
    return mod.diffIR ?? null;
  } catch {
    return null;
  }
}

const diffIR = await loadDiff();
const { mitata, runAndReport } = await startBench('diff-perf.bench.ts');
const { bench, group, do_not_optimize } = mitata;

if (!diffIR) {
  // eslint-disable-next-line no-console
  console.warn('[diff-perf] @codegraph/core does not export diffIR yet — skipping.');
  process.exit(0);
}

// Pre-construct the pairs. Building 100K-node IRs takes a beat; doing
// it inside the bench would dwarf the diff signal.
const pairs: Record<NodeBucket, ReturnType<typeof makeDiffPair>> = {
  '1K': makeDiffPair(NODE_BUCKETS['1K'], 0.05, 1),
  '10K': makeDiffPair(NODE_BUCKETS['10K'], 0.05, 1),
  '100K': makeDiffPair(NODE_BUCKETS['100K'], 0.05, 1),
};

for (const bucket of Object.keys(NODE_BUCKETS) as NodeBucket[]) {
  const { before, after } = pairs[bucket];
  group(`diff ${bucket} nodes`, () => {
    bench(`diffIR (${bucket})`, () => {
      const result = diffIR(before, after);
      do_not_optimize(result);
    });
  });
}

// One additional case: diffing identical IRs. design/test-strategy.md
// §8 calls out `diff(a, a) ≡ ∅` as a load-bearing property — we want
// a perf number on it because the empty-diff path is the common case
// in CI (re-runs of unchanged branches) and any regression there
// hurts the warm path most.
group('diff identity', () => {
  bench('diffIR identical 10K', () => {
    const result = diffIR(pairs['10K'].before, pairs['10K'].before);
    do_not_optimize(result);
  });
});

await runAndReport();
