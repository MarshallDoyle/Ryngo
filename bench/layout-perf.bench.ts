/**
 * Layout benchmark.
 *
 * Measures the viewer's graph-layout pass at 1K, 10K, and 100K nodes.
 * Target, from design/incremental.md §11: < 500ms for 1K nodes
 * off-thread.
 *
 * "Off-thread" means the layout normally runs in a Web Worker. Here we
 * call the underlying `computeLayout(ir)` synchronously on the main
 * thread — it's the same work, just measured directly so mitata can
 * see it. The Worker overhead is small and constant; we benchmark the
 * compute kernel, not the postMessage transport.
 *
 * Layout import path: `@codegraph/viewer/layout` exports `computeLayout`
 * per the viewer team's public surface. If unavailable we skip.
 */

import { NODE_BUCKETS, scaleIR, startBench, type NodeBucket } from './index.js';

type IR = ReturnType<typeof scaleIR>;
type LayoutFn = (ir: IR, opts?: { algorithm?: string }) => unknown;

interface ViewerSurface {
  computeLayout?: LayoutFn;
}

async function loadLayout(): Promise<LayoutFn | null> {
  // Try the documented entry first, fall back to the viewer's lib path
  // (matches packages/viewer/src/lib/layout.ts).
  for (const spec of [
    '@codegraph/viewer/layout',
    '@codegraph/viewer/lib/layout',
  ]) {
    try {
      const mod = (await import(spec)) as ViewerSurface;
      if (mod.computeLayout) return mod.computeLayout;
    } catch {
      // fall through
    }
  }
  return null;
}

const computeLayout = await loadLayout();
const { mitata, runAndReport } = await startBench('layout-perf.bench.ts');
const { bench, group, do_not_optimize } = mitata;

if (!computeLayout) {
  // eslint-disable-next-line no-console
  console.warn(
    '[layout-perf] @codegraph/viewer does not expose computeLayout yet — skipping.',
  );
  process.exit(0);
}

const irs: Record<NodeBucket, IR> = {
  '1K': scaleIR(NODE_BUCKETS['1K'], 1),
  '10K': scaleIR(NODE_BUCKETS['10K'], 1),
  '100K': scaleIR(NODE_BUCKETS['100K'], 1),
};

// Default algorithm (whatever the viewer defaults to). The viewer
// supports `layered`, `force`, `radial` per .codegraph.yml.example;
// we benchmark layered explicitly because it's the production default
// and is the most expensive of the three for large graphs.
for (const bucket of Object.keys(NODE_BUCKETS) as NodeBucket[]) {
  const ir = irs[bucket];
  group(`layout ${bucket} nodes`, () => {
    bench(`layered (${bucket})`, () => {
      const result = computeLayout(ir, { algorithm: 'layered' });
      do_not_optimize(result);
    });
    // Force-directed only at 1K and 10K — at 100K it's pathologically
    // slow and not the production path; we'd rather not have its
    // variance dominate the suite's wall-clock cost.
    if (bucket !== '100K') {
      bench(`force (${bucket})`, () => {
        const result = computeLayout(ir, { algorithm: 'force' });
        do_not_optimize(result);
      });
    }
  });
}

await runAndReport();
