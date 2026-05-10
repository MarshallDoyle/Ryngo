#!/usr/bin/env tsx
/**
 * Double-build determinism check (design/test-strategy.md §4.2).
 *
 * Runs `codegraph index` twice on every fixture in `test-fixtures/` (and
 * `e2e-fixtures/` when `--include-e2e` is passed), then byte-compares the
 * two output trees. Any difference is a determinism bug — never a flake,
 * never an "update the baseline" situation.
 *
 * Usage:
 *   tsx scripts/check-determinism.ts                    # all test-fixtures/*
 *   tsx scripts/check-determinism.ts <fixture-path>     # one fixture
 *   tsx scripts/check-determinism.ts --include-e2e      # also e2e-fixtures/*
 *   tsx scripts/check-determinism.ts --keep             # keep the temp dirs
 *   tsx scripts/check-determinism.ts --cli <path>       # override CLI entry
 *
 * Exit codes:
 *   0   every fixture is byte-identical across two runs.
 *   1   at least one fixture diverged.
 *   2   misuse / setup error (no CLI binary, no fixtures, etc.).
 *
 * The script is intentionally dependency-free (Node + tsx): it must run on
 * every CI runner image without a pnpm install first.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// CLI argument parsing (kept dependency-free)
// ---------------------------------------------------------------------------

interface Args {
  positional: string[];
  includeE2E: boolean;
  keep: boolean;
  cliPath?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], includeE2E: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--include-e2e') args.includeE2E = true;
    else if (a === '--keep') args.keep = true;
    else if (a === '--cli') {
      const next = argv[++i];
      if (!next) fail(2, '--cli requires a path argument');
      args.cliPath = next;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a && a.startsWith('--')) {
      fail(2, `unknown flag: ${a}`);
    } else if (a) {
      args.positional.push(a);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      'check-determinism — double-build IR equality (test-strategy §4.2)',
      '',
      'Usage:',
      '  tsx scripts/check-determinism.ts [<fixture>...] [options]',
      '',
      'Options:',
      '  --include-e2e   also run against e2e-fixtures/* (requires `pnpm e2e:fetch`)',
      '  --keep          keep tmp output dirs for inspection on failure',
      '  --cli <path>    override the codegraph CLI entry resolved from cwd',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listFixtureDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => join(root, e.name))
    .sort();
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

function hashFile(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

function resolveCli(override?: string): string {
  if (override) {
    const abs = resolve(override);
    if (!existsSync(abs)) fail(2, `--cli path does not exist: ${abs}`);
    return abs;
  }
  // Prefer the locally built CLI; fall back to the repo bin shim if pnpm
  // hasn't been run yet.
  const candidates = [
    join(REPO_ROOT, 'packages', 'cli', 'bin', 'codegraph.mjs'),
    join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js'),
    join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  fail(
    2,
    [
      'no codegraph CLI found. Build the CLI first (`pnpm --filter @codegraph/cli build`)',
      'or pass --cli <path>. Looked in:',
      ...candidates.map((c) => `  - ${relative(REPO_ROOT, c)}`),
    ].join('\n'),
  );
}

function runIndex(cli: string, fixtureDir: string, outDir: string): void {
  // Stage the fixture in a tmp working copy so the CLI's writes don't
  // pollute the source tree on disk. Output goes to outDir.
  const stage = mkdtempSync(join(tmpdir(), 'codegraph-det-stage-'));
  try {
    cpSync(fixtureDir, stage, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [cli, 'index', stage, '--out', outDir],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          // §4.1: ban Date.now/Math.random in IR producers; we can't enforce
          // that from here, but pinning TZ + LANG kills two common sources
          // of incidental locale-driven divergence in error formatting.
          TZ: 'UTC',
          LC_ALL: 'C.UTF-8',
          LANG: 'C.UTF-8',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (result.status !== 0) {
      const stderr = result.stderr || '';
      const stdout = result.stdout || '';
      fail(
        1,
        [
          `\`codegraph index\` exited ${result.status} on fixture: ${fixtureDir}`,
          stdout && `--- stdout ---\n${stdout}`,
          stderr && `--- stderr ---\n${stderr}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

interface Divergence {
  path: string;
  kind: 'missing-in-second' | 'missing-in-first' | 'bytes-differ';
  detail?: string;
}

function compareTrees(a: string, b: string): Divergence[] {
  const aFiles = new Map(walkFiles(a).map((f) => [relative(a, f), f]));
  const bFiles = new Map(walkFiles(b).map((f) => [relative(b, f), f]));

  const divs: Divergence[] = [];
  const allRel = new Set<string>([...aFiles.keys(), ...bFiles.keys()]);
  const sortedRel = [...allRel].sort();

  for (const rel of sortedRel) {
    const af = aFiles.get(rel);
    const bf = bFiles.get(rel);
    if (af && !bf) divs.push({ path: rel, kind: 'missing-in-second' });
    else if (!af && bf) divs.push({ path: rel, kind: 'missing-in-first' });
    else if (af && bf) {
      const ah = hashFile(af);
      const bh = hashFile(bf);
      if (ah !== bh) {
        divs.push({
          path: rel,
          kind: 'bytes-differ',
          detail: `sha256 a=${ah.slice(0, 12)}  b=${bh.slice(0, 12)}`,
        });
      }
    }
  }
  return divs;
}

function printDivergences(fixture: string, divs: Divergence[]): void {
  process.stderr.write(
    `\nDETERMINISM FAILURE — fixture: ${relative(REPO_ROOT, fixture)}\n`,
  );
  process.stderr.write(
    'Two runs of `codegraph index` on the same input produced different output.\n',
  );
  process.stderr.write(
    'This is always a producer bug (see design/test-strategy.md §4).\n\n',
  );
  for (const d of divs.slice(0, 20)) {
    process.stderr.write(`  [${d.kind}] ${d.path}`);
    if (d.detail) process.stderr.write(`  ${d.detail}`);
    process.stderr.write('\n');
  }
  if (divs.length > 20) {
    process.stderr.write(`  …and ${divs.length - 20} more.\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function fail(code: number, msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cli = resolveCli(args.cliPath);

  const fixtureDirs = args.positional.length
    ? args.positional.map((p) => resolve(p))
    : [
        ...listFixtureDirs(join(REPO_ROOT, 'test-fixtures')),
        ...(args.includeE2E
          ? listFixtureDirs(join(REPO_ROOT, 'e2e-fixtures'))
          : []),
      ];

  if (fixtureDirs.length === 0) {
    fail(
      2,
      'no fixtures found. Add a directory under test-fixtures/ or pass one as an argument.',
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), 'codegraph-determinism-'));
  let failed = 0;
  try {
    for (const fixture of fixtureDirs) {
      if (!existsSync(fixture) || !statSync(fixture).isDirectory()) {
        process.stderr.write(`  [skip] not a directory: ${fixture}\n`);
        continue;
      }
      const name = relative(REPO_ROOT, fixture).replace(/[/\\]/g, '_');
      const outA = join(tmp, `${name}__a`);
      const outB = join(tmp, `${name}__b`);
      process.stdout.write(`  [run-1] ${relative(REPO_ROOT, fixture)}\n`);
      runIndex(cli, fixture, outA);
      process.stdout.write(`  [run-2] ${relative(REPO_ROOT, fixture)}\n`);
      runIndex(cli, fixture, outB);
      const divs = compareTrees(outA, outB);
      if (divs.length > 0) {
        printDivergences(fixture, divs);
        failed++;
      } else {
        process.stdout.write(
          `  [ok]    ${relative(REPO_ROOT, fixture)} — byte-identical\n`,
        );
      }
    }
  } finally {
    if (!args.keep) rmSync(tmp, { recursive: true, force: true });
    else process.stdout.write(`\nKept tmp output dir: ${tmp}\n`);
  }

  if (failed > 0) {
    process.stderr.write(
      `\nDeterminism check FAILED on ${failed}/${fixtureDirs.length} fixture(s).\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `\nDeterminism check passed: ${fixtureDirs.length} fixture(s) byte-identical across two runs.\n`,
  );
}

main();
