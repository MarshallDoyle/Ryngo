/**
 * Perf regression gate.
 *
 * Runs every `bench/*.bench.ts` file with CG_BENCH_JSON=1, captures
 * each bench's median ns/op, and compares to the baseline at
 * `bench/baseline.json`. Fails (exit 1) if any single bench regresses
 * >20% against its baseline entry. New benches without a baseline
 * entry are reported but do not fail.
 *
 * Usage:
 *
 *   pnpm tsx scripts/perf-regression.ts            # gate against baseline
 *   pnpm tsx scripts/perf-regression.ts --update   # rewrite baseline
 *   pnpm tsx scripts/perf-regression.ts --json     # emit JSON only
 *
 * The 20% threshold mirrors design/test-strategy.md §1.8 ("Fails the
 * build if any single bench regresses >20%"). The geomean check (10%)
 * is also implemented but only a warning today; promote it to a hard
 * fail once the suite is stable enough that 10% noise floors aren't a
 * concern.
 *
 * Baseline format (bench/baseline.json):
 *
 *   {
 *     "schemaVersion": 1,
 *     "runner": "ubuntu-22.04",
 *     "node": "22.x",
 *     "createdAt": "2026-05-09T...",
 *     "benchmarks": {
 *       "<file>::<group>::<name>": { "ns": 12345.6 }
 *     }
 *   }
 *
 * Key shape: `<file>::<group||"_">::<name>` — stable across renames of
 * surrounding code as long as the bench name + group don't change. If
 * either changes, the old entry is treated as "removed" and the new
 * entry is treated as "added"; the regression script reports both.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BENCH_DIR = join(REPO_ROOT, 'bench');
const BASELINE_PATH = join(BENCH_DIR, 'baseline.json');

const PER_BENCH_THRESHOLD = 0.2; // 20%
const GEOMEAN_THRESHOLD = 0.1;   // 10% (warn, do not fail)

const BENCH_FILES = [
  'index-perf.bench.ts',
  'diff-perf.bench.ts',
  'layout-perf.bench.ts',
  'load-perf.bench.ts',
];

interface BenchRecord {
  file: string;
  group: string | null;
  name: string;
  ns: number;
  min: number;
  max: number;
  samples: number;
}

interface BaselineFile {
  schemaVersion: 1;
  runner: string | null;
  node: string;
  createdAt: string;
  benchmarks: Record<string, { ns: number }>;
}

function key(r: Pick<BenchRecord, 'file' | 'group' | 'name'>): string {
  return `${r.file}::${r.group ?? '_'}::${r.name}`;
}

async function runBench(file: string): Promise<BenchRecord[]> {
  return new Promise((resolveP, rejectP) => {
    // Use `node --import tsx` to run the .ts files directly. tsx is
    // already a dev dependency of the repo (vitest needs it). The
    // test-harness teammate is responsible for ensuring tsx is
    // available in CI.
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(BENCH_DIR, file)],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, CG_BENCH_JSON: '1', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectP(new Error(`bench ${file} exited with code ${code}`));
        return;
      }
      const records: BenchRecord[] = [];
      // The bench harness emits one JSON line per `runAndReport()`
      // call. Tolerate other stdout noise around it.
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed) as {
            file: string;
            benchmarks: BenchRecord[];
          };
          if (Array.isArray(parsed.benchmarks)) {
            records.push(...parsed.benchmarks);
          }
        } catch {
          // ignore non-bench JSON lines
        }
      }
      resolveP(records);
    });
  });
}

function loadBaseline(): BaselineFile | null {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BaselineFile;
  } catch (err) {
    throw new Error(
      `failed to parse ${BASELINE_PATH}: ${(err as Error).message}`,
    );
  }
}

function writeBaseline(records: BenchRecord[]): void {
  const benchmarks: BaselineFile['benchmarks'] = {};
  for (const r of records) {
    benchmarks[key(r)] = { ns: r.ns };
  }
  const baseline: BaselineFile = {
    schemaVersion: 1,
    runner: process.env['RUNNER_OS'] ?? null,
    node: process.version,
    createdAt: new Date().toISOString(),
    benchmarks,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
}

interface Comparison {
  key: string;
  current: number;
  baseline: number | null;
  ratio: number | null; // current / baseline
}

function compare(current: BenchRecord[], baseline: BaselineFile | null): {
  rows: Comparison[];
  failures: Comparison[];
  added: Comparison[];
  removed: string[];
  geomean: number;
} {
  const rows: Comparison[] = [];
  const added: Comparison[] = [];
  const failures: Comparison[] = [];

  const seen = new Set<string>();
  for (const r of current) {
    const k = key(r);
    seen.add(k);
    const base = baseline?.benchmarks[k]?.ns ?? null;
    const ratio = base === null || base === 0 ? null : r.ns / base;
    const row: Comparison = { key: k, current: r.ns, baseline: base, ratio };
    rows.push(row);
    if (base === null) {
      added.push(row);
    } else if (ratio !== null && ratio - 1 > PER_BENCH_THRESHOLD) {
      failures.push(row);
    }
  }

  const removed: string[] = [];
  if (baseline) {
    for (const k of Object.keys(baseline.benchmarks)) {
      if (!seen.has(k)) removed.push(k);
    }
  }

  // Geomean of ratios (only over benches with a baseline match).
  const ratios = rows
    .map((r) => r.ratio)
    .filter((x): x is number => x !== null && x > 0);
  const geomean =
    ratios.length === 0
      ? 1
      : Math.exp(
          ratios.reduce((acc, r) => acc + Math.log(r), 0) / ratios.length,
        );

  return { rows, failures, added, removed, geomean };
}

function fmtNs(ns: number): string {
  if (ns < 1_000) return `${ns.toFixed(1)} ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} µs`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  return `${(ns / 1_000_000_000).toFixed(2)} s`;
}

function fmtRatio(ratio: number | null): string {
  if (ratio === null) return '—';
  const pct = (ratio - 1) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${ratio.toFixed(3)}x (${sign}${pct.toFixed(1)}%)`;
}

function report(
  current: BenchRecord[],
  comparison: ReturnType<typeof compare>,
  jsonOnly: boolean,
): void {
  if (jsonOnly) {
    process.stdout.write(
      JSON.stringify(
        {
          rows: comparison.rows,
          failures: comparison.failures.map((r) => r.key),
          added: comparison.added.map((r) => r.key),
          removed: comparison.removed,
          geomean: comparison.geomean,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`\nperf-regression — ${current.length} benchmarks measured\n`);
  for (const row of comparison.rows) {
    const status =
      row.baseline === null
        ? '[new]'
        : row.ratio !== null && row.ratio - 1 > PER_BENCH_THRESHOLD
          ? '[FAIL]'
          : '[ok]';
    // eslint-disable-next-line no-console
    console.log(
      `  ${status.padEnd(7)} ${row.key.padEnd(60)}  ${fmtNs(row.current).padStart(10)}  vs  ${row.baseline === null ? '   —     ' : fmtNs(row.baseline).padStart(10)}  ${fmtRatio(row.ratio)}`,
    );
  }
  if (comparison.removed.length > 0) {
    // eslint-disable-next-line no-console
    console.log('\nremoved (in baseline, not in current):');
    for (const r of comparison.removed) {
      // eslint-disable-next-line no-console
      console.log(`  - ${r}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\ngeomean ratio: ${fmtRatio(comparison.geomean)}`);
  if (comparison.geomean - 1 > GEOMEAN_THRESHOLD) {
    // eslint-disable-next-line no-console
    console.warn(
      `  WARNING: geomean exceeds ${(GEOMEAN_THRESHOLD * 100).toFixed(0)}% — death-by-a-thousand-paper-cuts territory.`,
    );
  }
  if (comparison.failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\n${comparison.failures.length} bench(es) regressed >${(PER_BENCH_THRESHOLD * 100).toFixed(0)}% — failing build.`,
    );
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const update = args.has('--update');
  const jsonOnly = args.has('--json');

  const all: BenchRecord[] = [];
  for (const file of BENCH_FILES) {
    if (!existsSync(join(BENCH_DIR, file))) continue;
    const records = await runBench(file);
    all.push(...records);
  }

  if (update) {
    writeBaseline(all);
    if (!jsonOnly) {
      // eslint-disable-next-line no-console
      console.log(
        `wrote baseline with ${all.length} benchmarks to ${BASELINE_PATH}`,
      );
    }
    return;
  }

  const baseline = loadBaseline();
  if (!baseline && !jsonOnly) {
    // eslint-disable-next-line no-console
    console.warn(
      `no baseline at ${BASELINE_PATH} — run with --update to create one. Reporting current numbers only.`,
    );
  }

  const comparison = compare(all, baseline);
  report(all, comparison, jsonOnly);
  if (comparison.failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(2);
});
