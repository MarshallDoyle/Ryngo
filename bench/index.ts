/**
 * codegraph perf benchmark harness.
 *
 * Shared helpers used by the four bench files in this directory:
 *
 *   - index-perf.bench.ts  — full-pipeline indexing on synthetic repos
 *   - diff-perf.bench.ts   — diff over IR pairs at increasing node counts
 *   - layout-perf.bench.ts — graph layout over the same node counts
 *   - load-perf.bench.ts   — IR JSON load + schema validate from disk
 *
 * Conventions:
 *
 *   - All benches use `mitata` (https://github.com/evanwashere/mitata) for
 *     timing. We import `bench`, `group`, `run`, and `barplot` from it.
 *   - Each bench file ends with a top-level `await run()` so it can be
 *     executed directly with `node --import tsx bench/<file>.ts` or piped
 *     into the regression harness (see scripts/perf-regression.ts).
 *   - Bench results are JSON-serialized to stdout when CG_BENCH_JSON=1, so
 *     the regression script can capture them without screen-scraping
 *     mitata's TTY output.
 *   - Synthetic IR comes from @codegraph/core's sample generator. The four
 *     "size buckets" the design mandates (100 / 1K / 10K / 100K) are
 *     produced by composing the generator's small/medium/large modes and
 *     scaling factors — see scaleIR() below.
 *   - File-tree synthesis (for the indexer benchmark) goes through
 *     emitFileTree(), which writes deterministic source files into a
 *     temp directory the bench owns and tears down on exit.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateSampleIR,
  type GenerateOptions,
  type Size,
} from '@codegraph/core/sample/generator';

// Re-exports so bench files import from this module rather than depending
// on @codegraph/core's deep paths.
export { generateSampleIR };
export type { GenerateOptions, Size };

// ---------- size targets ----------

/**
 * The node-count ladder used across the suite. Aligned with the targets
 * called out in design/incremental.md §11 (diff < 2s for 100K nodes,
 * layout < 500ms for 1K nodes off-thread).
 *
 * The generator ships small=50, medium=500, large=5000. To reach 10K and
 * 100K nodes we replicate generated IRs and renamespace IDs — see
 * scaleIR() for the exact procedure.
 */
export const NODE_BUCKETS = {
  '1K': 1_000,
  '10K': 10_000,
  '100K': 100_000,
} as const;

export const FILE_BUCKETS = {
  '100': 100,
  '1K': 1_000,
  '10K': 10_000,
} as const;

export type NodeBucket = keyof typeof NODE_BUCKETS;
export type FileBucket = keyof typeof FILE_BUCKETS;

// ---------- IR scaling ----------

type IRLike = ReturnType<typeof generateSampleIR>;

/**
 * Build an IR with at least `targetNodes` nodes by replicating the
 * generator's `large` output until the count is hit, then truncating.
 * IDs are renamespaced per replica so downstream code doesn't dedupe.
 *
 * Determinism: replication order is by replica index, all renames use a
 * fixed prefix scheme. Two calls with the same target produce the same
 * IR.
 */
export function scaleIR(targetNodes: number, seed = 1): IRLike {
  // Pick the smallest base size that minimizes replicas.
  const baseSize: Size =
    targetNodes <= 50 ? 'small' : targetNodes <= 500 ? 'medium' : 'large';
  const base = generateSampleIR({ size: baseSize, seed });
  if (base.nodes.length >= targetNodes) {
    return truncateIR(base, targetNodes);
  }

  const replicas = Math.ceil(targetNodes / base.nodes.length);
  const nodes: IRLike['nodes'] = [];
  const edges: IRLike['edges'] = [];
  for (let r = 0; r < replicas; r++) {
    const ns = `r${r}/`;
    for (const n of base.nodes) {
      nodes.push({
        ...n,
        id: ns + n.id,
        ...(n.parentId !== undefined ? { parentId: ns + n.parentId } : {}),
      });
    }
    for (const e of base.edges) {
      edges.push({
        ...e,
        id: `${ns}${e.id}`,
        source: ns + e.source,
        target: ns + e.target,
      });
    }
  }

  const scaled: IRLike = {
    ...base,
    nodes,
    edges,
    meta: {
      ...base.meta,
      generator: {
        ...((base.meta as { generator?: Record<string, unknown> }).generator ??
          {}),
        scaledTo: targetNodes,
        replicas,
        nodeCount: nodes.length,
        edgeCount: edges.length,
      },
    } as IRLike['meta'],
  };
  return truncateIR(scaled, targetNodes);
}

function truncateIR(ir: IRLike, targetNodes: number): IRLike {
  if (ir.nodes.length <= targetNodes) return ir;
  const keptIds = new Set<string>();
  const nodes: IRLike['nodes'] = [];
  for (const n of ir.nodes) {
    if (nodes.length >= targetNodes) break;
    // Skip a node whose parent we haven't kept — preserves tree validity.
    if (n.parentId !== undefined && !keptIds.has(n.parentId)) {
      // Top-level nodes (services) have no parent; always kept.
      // Otherwise, skip until parent is in.
      // We don't reorder, so this only drops orphaned tails.
      continue;
    }
    nodes.push(n);
    keptIds.add(n.id);
  }
  const edges = ir.edges.filter(
    (e) => keptIds.has(e.source) && keptIds.has(e.target),
  );
  return { ...ir, nodes, edges };
}

/**
 * Produce a "before/after" IR pair for diff benchmarking. The `after` IR
 * is the `before` with ~churnPct of nodes renamed and ~churnPct of edges
 * rewired — large enough to exercise the diff algorithm, small enough
 * that the diff result is bounded.
 */
export function makeDiffPair(
  targetNodes: number,
  churnPct = 0.05,
  seed = 1,
): { before: IRLike; after: IRLike } {
  const before = scaleIR(targetNodes, seed);
  const after = mutateIR(before, churnPct, seed + 0x9e3779b1);
  return { before, after };
}

function mutateIR(ir: IRLike, churnPct: number, seed: number): IRLike {
  const rng = mulberry32(seed);
  const nodeChurn = Math.floor(ir.nodes.length * churnPct);
  const idRemap = new Map<string, string>();

  const nodes = ir.nodes.map((n, i) => {
    if (i < nodeChurn && rng() < 0.5) {
      const newId = n.id + '#m';
      idRemap.set(n.id, newId);
      return { ...n, id: newId, name: n.name + '_v2' };
    }
    return n;
  });

  // Update parent references that landed on remapped ids.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.parentId !== undefined && idRemap.has(n.parentId)) {
      nodes[i] = { ...n, parentId: idRemap.get(n.parentId)! };
    }
  }

  const edges = ir.edges.map((e) => ({
    ...e,
    source: idRemap.get(e.source) ?? e.source,
    target: idRemap.get(e.target) ?? e.target,
  }));

  return { ...ir, nodes, edges };
}

// ---------- file-tree synthesis ----------

/**
 * Materialize a synthetic source tree on disk for the indexer benchmark.
 *
 * Strategy:
 *
 *   - Each "service" in the synthetic IR maps to a directory under
 *     `apps/<service>/src/<module>/<fn>.ts`.
 *   - Each function node becomes a tiny TypeScript file containing a
 *     plausible export and a couple of imports of sibling functions.
 *   - The output is deterministic given (fileCount, seed): same inputs
 *     produce byte-identical files. This is necessary for the cache
 *     paths in design/incremental.md §3 to be testable here.
 *
 * Returns the temp root and a cleanup function. The caller MUST invoke
 * cleanup() — bench files do this in a `process.on('beforeExit')` hook
 * registered by createTempRepo().
 */
export interface TempRepo {
  root: string;
  files: string[];
  cleanup: () => void;
}

export function createTempRepo(fileCount: number, seed = 1): TempRepo {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-bench-'));
  const files: string[] = [];
  const rng = mulberry32(seed);

  // Spread files across 8 "services" each with ~12 modules. For 10K
  // files that's roughly 100 files per module — realistic monorepo
  // shape.
  const services = ['web', 'api', 'worker', 'admin', 'gateway', 'jobs', 'shared', 'tools'];
  const modules = [
    'routes', 'services', 'repos', 'models', 'utils', 'middleware',
    'auth', 'config', 'logger', 'errors', 'validators', 'queue',
  ];

  let idx = 0;
  outer: for (const svc of services) {
    for (const mod of modules) {
      const dir = join(root, 'apps', svc, 'src', mod);
      mkdirSync(dir, { recursive: true });
      // Distribute the remaining files across remaining (svc,mod) cells.
      const cellsLeft =
        (services.length * modules.length) -
        (services.indexOf(svc) * modules.length + modules.indexOf(mod));
      const filesLeft = fileCount - idx;
      const here = Math.max(1, Math.ceil(filesLeft / cellsLeft));
      for (let i = 0; i < here && idx < fileCount; i++, idx++) {
        const name = `${mod}_${i}.ts`;
        const file = join(dir, name);
        writeFileSync(file, sourceFor(svc, mod, i, rng));
        files.push(file);
      }
      if (idx >= fileCount) break outer;
    }
  }

  // Root-level config files the indexer typically reads.
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'bench-fixture', private: true }, null, 2),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify(
      { compilerOptions: { target: 'es2022', module: 'esnext', strict: true } },
      null,
      2,
    ),
  );

  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
  process.once('beforeExit', cleanup);

  return { root, files, cleanup };
}

function sourceFor(
  svc: string,
  mod: string,
  i: number,
  rng: () => number,
): string {
  const verbs = ['get', 'list', 'create', 'update', 'sync', 'render'];
  const nouns = ['User', 'Order', 'Invoice', 'Session', 'Job', 'Event'];
  const verb = verbs[i % verbs.length]!;
  const noun = nouns[Math.floor(rng() * nouns.length)]!;
  // A self-contained source file with a couple of imports and exports.
  // The shape mirrors what the TS indexer is expected to surface as
  // function nodes + imports edges in the IR.
  return [
    `// generated by bench/index.ts — service=${svc} module=${mod} idx=${i}`,
    `import type { ${noun} } from '../models/models_0';`,
    `import { helper } from '../utils/utils_0';`,
    ``,
    `export function ${verb}${noun}(input: ${noun}): ${noun} {`,
    `  return helper(input);`,
    `}`,
    ``,
    `export const ${verb}${noun}Async = async (input: ${noun}): Promise<${noun}> => {`,
    `  return helper(input);`,
    `};`,
    ``,
  ].join('\n');
}

// ---------- mitata wrapper ----------

/**
 * Lazily import mitata. We do this dynamically so bench files don't
 * crash at import time when mitata isn't installed yet (the bench
 * dependencies live in the bench/ package.json which the
 * test-harness teammate is responsible for wiring up).
 */
export async function loadMitata(): Promise<typeof import('mitata')> {
  return await import('mitata');
}

/**
 * Common pre-amble for every bench file. Returns the mitata namespace
 * plus a JSON-emitter that the regression script consumes.
 *
 * When CG_BENCH_JSON=1, the runner additionally writes a structured
 * record of `{ name, group, stats }` per bench so we don't have to
 * re-parse mitata's pretty output.
 */
export async function startBench(file: string) {
  const mitata = await loadMitata();
  const records: BenchRecord[] = [];

  const runAndReport = async () => {
    // mitata's `run` returns a structured result we can inspect.
    const results = await mitata.run({ format: 'mitata' });
    if (process.env['CG_BENCH_JSON'] === '1') {
      const captured = capture(results, records, file);
      process.stdout.write(JSON.stringify(captured) + '\n');
    }
  };

  return { mitata, runAndReport };
}

export interface BenchRecord {
  file: string;
  group: string | null;
  name: string;
  /** Median nanoseconds per op. */
  ns: number;
  /** Min nanoseconds per op. */
  min: number;
  /** Max nanoseconds per op. */
  max: number;
  /** Sample count. */
  samples: number;
}

/**
 * Walk mitata's results into a flat list of BenchRecord. mitata's
 * shape has shifted between versions — this normalizes whatever it
 * gives us and is forgiving of missing fields. The regression script
 * only relies on `name`, `group`, and `ns`.
 */
function capture(
  results: unknown,
  out: BenchRecord[],
  file: string,
): { file: string; benchmarks: BenchRecord[] } {
  // The mitata result shape is `{ benchmarks: [{ name, group, runs, stats: { avg, min, max, p50, p99, samples } }] }`.
  // We tolerate either `stats.p50` or `stats.avg` as the headline metric.
  const r = results as {
    benchmarks?: Array<{
      name?: string;
      group?: string | null;
      stats?: {
        avg?: number;
        min?: number;
        max?: number;
        p50?: number;
        samples?: number[] | number;
      };
    }>;
  };

  for (const b of r.benchmarks ?? []) {
    const stats = b.stats ?? {};
    const ns = stats.p50 ?? stats.avg ?? 0;
    const samples = Array.isArray(stats.samples)
      ? stats.samples.length
      : (stats.samples ?? 0);
    out.push({
      file,
      group: b.group ?? null,
      name: b.name ?? '<anonymous>',
      ns,
      min: stats.min ?? 0,
      max: stats.max ?? 0,
      samples,
    });
  }
  return { file, benchmarks: out };
}

// ---------- tiny seeded RNG ----------
// Mulberry32 — same one the sample generator uses. Kept inline so the
// bench harness has no runtime imports beyond mitata + node builtins.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
