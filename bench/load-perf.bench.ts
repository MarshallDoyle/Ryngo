/**
 * IR load + validate benchmark.
 *
 * Measures two things every codegraph run pays:
 *
 *   1. Reading an IR JSON document from disk.
 *   2. Validating it against the Zod schema (validateIR).
 *
 * The viewer pays this on every page load; the CLI pays it on every
 * `codegraph diff` invocation. Targets are not called out explicitly
 * in design/incremental.md — we set them empirically and let the
 * regression script enforce no-worse-than-baseline.
 *
 * IR sizes mirror the diff/layout suite: 1K, 10K, 100K nodes.
 * Documents are written to a temp dir during setup and read back
 * inside the timed region.
 *
 * If `@codegraph/core` does not yet export `validateIR`, the
 * validation cases are skipped (load-only cases still run).
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NODE_BUCKETS, scaleIR, startBench, type NodeBucket } from './index.js';

type IR = ReturnType<typeof scaleIR>;

interface CoreSurface {
  validateIR?: (input: unknown) => IR;
}

async function loadValidator(): Promise<CoreSurface['validateIR'] | null> {
  try {
    const mod = (await import('@codegraph/core')) as CoreSurface;
    return mod.validateIR ?? null;
  } catch {
    return null;
  }
}

const validateIR = await loadValidator();
const { mitata, runAndReport } = await startBench('load-perf.bench.ts');
const { bench, group, do_not_optimize } = mitata;

const root = mkdtempSync(join(tmpdir(), 'codegraph-load-bench-'));
process.once('beforeExit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Write the IRs to disk once. Reading is what we measure; writing is
// not in the bench's contract.
const paths: Record<NodeBucket, string> = {} as never;
for (const bucket of Object.keys(NODE_BUCKETS) as NodeBucket[]) {
  const ir = scaleIR(NODE_BUCKETS[bucket], 1);
  const path = join(root, `ir-${bucket}.json`);
  writeFileSync(path, JSON.stringify(ir));
  paths[bucket] = path;
}

for (const bucket of Object.keys(NODE_BUCKETS) as NodeBucket[]) {
  const path = paths[bucket];
  group(`load ${bucket} nodes`, () => {
    bench(`readFile + JSON.parse (${bucket})`, () => {
      const text = readFileSync(path, 'utf8');
      const parsed = JSON.parse(text) as IR;
      do_not_optimize(parsed);
    });

    if (validateIR) {
      bench(`readFile + parse + validateIR (${bucket})`, () => {
        const text = readFileSync(path, 'utf8');
        const parsed = JSON.parse(text) as unknown;
        const validated = validateIR(parsed);
        do_not_optimize(validated);
      });
    }
  });
}

if (!validateIR) {
  // eslint-disable-next-line no-console
  console.warn(
    '[load-perf] @codegraph/core does not export validateIR yet — running load-only cases.',
  );
}

await runAndReport();
