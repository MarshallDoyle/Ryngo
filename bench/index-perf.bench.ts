/**
 * Indexer pipeline benchmark.
 *
 * Builds synthetic source repos at 100, 1K, and 10K files and runs the
 * full codegraph indexer over each. Two flavors per size:
 *
 *   - cold:  no cache directory present
 *   - warm:  re-run after a cold pass populated `.codegraph/cache/`
 *
 * Targets, from design/incremental.md §11:
 *
 *   - warm 10K-file run < 30s wall-clock
 *   - cold 10K-file run < 100s wall-clock
 *
 * The bench reports both medians; the regression script enforces the
 * 20% no-regress threshold against the committed baseline.
 *
 * Indexer wiring: we import `runIndexer` from @codegraph/core (per
 * STRUCTURE.md §4.1's public-export contract). If the export isn't
 * available yet, the bench skips with a clear log line and exits 0,
 * so the suite degrades gracefully while the indexer team is still
 * landing.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  FILE_BUCKETS,
  createTempRepo,
  startBench,
  type FileBucket,
} from './index.js';

interface CoreSurface {
  runIndexer?: (opts: {
    root: string;
    cache?: { dir: string; mode?: 'read-write' | 'off' };
  }) => Promise<unknown>;
}

async function loadIndexer(): Promise<CoreSurface['runIndexer'] | null> {
  try {
    const mod = (await import('@codegraph/core')) as CoreSurface;
    return mod.runIndexer ?? null;
  } catch {
    return null;
  }
}

const runIndexer = await loadIndexer();
const { mitata, runAndReport } = await startBench('index-perf.bench.ts');
const { bench, group, do_not_optimize } = mitata;

if (!runIndexer) {
  // eslint-disable-next-line no-console
  console.warn(
    '[index-perf] @codegraph/core does not export runIndexer yet — skipping.',
  );
  process.exit(0);
}

// Pre-build the file trees once. Building them is itself non-trivial at
// 10K files (~1s of fs writes), and we don't want it inside the timed
// region. Bench harness creates them lazily per group.
const repos: Record<FileBucket, ReturnType<typeof createTempRepo>> = {} as never;
for (const bucket of Object.keys(FILE_BUCKETS) as FileBucket[]) {
  repos[bucket] = createTempRepo(FILE_BUCKETS[bucket], 1);
}

/**
 * Cold-path benches don't need to throw the cache away every iteration —
 * mitata gives us a `gc` hook between samples. We `rm -rf` the cache dir
 * there so each sample is genuinely cold.
 *
 * Warm-path benches must do the inverse: ensure the cache is populated
 * once before the timed region and untouched between samples.
 */
for (const bucket of Object.keys(FILE_BUCKETS) as FileBucket[]) {
  const repo = repos[bucket];
  const cacheDir = join(repo.root, '.codegraph', 'cache');

  group(`indexer ${bucket} files`, () => {
    bench(`cold (${bucket})`, async () => {
      rmSync(cacheDir, { recursive: true, force: true });
      const result = await runIndexer({
        root: repo.root,
        cache: { dir: cacheDir, mode: 'read-write' },
      });
      do_not_optimize(result);
    });

    bench(`warm (${bucket})`, async () => {
      // Cache is preserved across iterations; the harness pre-warmed it
      // by running cold at least once during the warmup phase that
      // mitata performs before measurement.
      const result = await runIndexer({
        root: repo.root,
        cache: { dir: cacheDir, mode: 'read-write' },
      });
      do_not_optimize(result);
    });
  });
}

await runAndReport();

// Tear down explicitly for the case where `process.exit` short-circuits
// the `beforeExit` hooks set up by createTempRepo.
for (const bucket of Object.keys(repos) as FileBucket[]) {
  repos[bucket].cleanup();
}
