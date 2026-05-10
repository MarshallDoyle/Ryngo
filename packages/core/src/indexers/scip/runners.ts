/**
 * SCIP indexer registry + subprocess invocation.
 *
 * One `IndexerSpec` per language/indexer; `detectIndexers` walks a repo and
 * returns the specs that apply; `runIndexer` shells out, captures
 * `index.scip`, and returns its bytes.
 *
 * We do NOT actually execute any indexer in this codepath at the moment
 * (the team is still pinning binaries) — `runIndexer` is wired up so that
 * `cli-index` can call it once that lands. The function still throws a
 * clear error if you call it without an explicitly resolved binary path,
 * so accidental invocation in CI fails loudly rather than silently
 * downloading a release.
 *
 * See research/scip.md §2.2-2.3 for the design.
 */
import { spawn } from 'node:child_process';
import { readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Languages we have first-party support for. Mirrors §1.4. */
export type ScipLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'scala'
  | 'cpp'
  | 'ruby'
  | 'csharp';

/** Maturity tier; `production` indexers are run by default. */
export type Maturity = 'production' | 'beta' | 'experimental';

/**
 * Options passed through `runIndexer` into a spec's `command` builder.
 * Indexers each have their own flags; this is the common subset we expose.
 */
export interface RunOpts {
  /** Resolved absolute path to the indexer binary. */
  readonly binPath: string;
  /** Where the indexer should write `index.scip`. Absolute path. */
  readonly outputPath: string;
  /** Project root; passed as cwd and (for some indexers) as a positional arg. */
  readonly projectRoot: string;
  /** Optional environment overrides merged on top of the parent env. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * If `true`, indexers that support a "no global cache" flag (e.g.
   * `scip-typescript --no-global-caches`) will use it. We default to `true`
   * for hermeticity.
   */
  readonly hermetic?: boolean;
}

/**
 * What `command` returns: the argv to spawn plus any per-spec env tweaks
 * and the cwd. The entry at argv[0] is the binary; argv[1..] are the args.
 */
export interface SpawnPlan {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** A `(filename) -> applicable?` test. We keep these tiny and read-only. */
export type DetectFn = (
  filenames: ReadonlySet<string>,
  repoRoot: string,
) => Promise<DetectResult | null>;

export interface DetectResult {
  /** Higher = more confident. Used to break ties when multiple specs match. */
  readonly confidence: number;
  /**
   * Project roots inside the repo where the indexer should run. Most repos
   * yield a single root (the repo root); TS/Go workspaces can yield more.
   * Paths are POSIX, repo-relative.
   */
  readonly projectRoots: readonly string[];
}

export interface IndexerSpec {
  /** Stable id. `scip-typescript`, `scip-go`, etc. */
  readonly id: string;
  /** Human-readable display name; not load-bearing. */
  readonly name: string;
  /** Languages this indexer covers. `scip-java` covers three. */
  readonly languages: readonly ScipLanguage[];
  /** Default binary name to look for on $PATH. */
  readonly defaultBin: string;
  readonly maturity: Maturity;
  /** Decides whether to run on this repo. Cheap, read-only. */
  readonly detect: DetectFn;
  /** Builds the spawn plan. Pure: same inputs -> same plan. */
  readonly command: (opts: RunOpts) => SpawnPlan;
}

// ── registry ───────────────────────────────────────────────────────────────

/**
 * The static registry of indexer specs. Keep this list small and
 * deterministic — it's what the CLI iterates to figure out what to run.
 *
 * Detection is purely filename-based: we get the set of files at the repo
 * root (one level deep), no glob. That keeps detection O(1) per repo even on
 * giant monorepos.
 */
export const INDEXER_REGISTRY: readonly IndexerSpec[] = [
  {
    id: 'scip-typescript',
    name: 'scip-typescript',
    languages: ['typescript', 'javascript'],
    defaultBin: 'scip-typescript',
    maturity: 'production',
    detect: async (filenames) => {
      const hits = ['tsconfig.json', 'package.json', 'jsconfig.json'].filter(
        (f) => filenames.has(f),
      );
      if (hits.length === 0) return null;
      return { confidence: hits.length, projectRoots: ['.'] };
    },
    command: ({ binPath, outputPath, projectRoot, hermetic }) => ({
      argv: [
        binPath,
        'index',
        '--output',
        outputPath,
        ...(hermetic ?? true ? ['--no-global-caches'] : []),
      ],
      cwd: projectRoot,
    }),
  },
  {
    id: 'scip-python',
    name: 'scip-python',
    languages: ['python'],
    defaultBin: 'scip-python',
    maturity: 'production',
    detect: async (filenames) => {
      const hits = ['pyproject.toml', 'setup.py', 'requirements.txt'].filter(
        (f) => filenames.has(f),
      );
      if (hits.length === 0) return null;
      return { confidence: hits.length, projectRoots: ['.'] };
    },
    command: ({ binPath, outputPath, projectRoot }) => ({
      argv: [
        binPath,
        'index',
        '.',
        '--project-name',
        'codegraph-project',
        '--output',
        outputPath,
      ],
      cwd: projectRoot,
    }),
  },
  {
    id: 'scip-go',
    name: 'scip-go',
    languages: ['go'],
    defaultBin: 'scip-go',
    maturity: 'production',
    detect: async (filenames) => {
      if (!filenames.has('go.mod')) return null;
      return { confidence: 2, projectRoots: ['.'] };
    },
    command: ({ binPath, outputPath, projectRoot }) => ({
      argv: [binPath, '--output', outputPath],
      cwd: projectRoot,
    }),
  },
  {
    id: 'rust-analyzer',
    name: 'rust-analyzer scip',
    languages: ['rust'],
    defaultBin: 'rust-analyzer',
    maturity: 'production',
    detect: async (filenames) => {
      if (!filenames.has('Cargo.toml')) return null;
      return { confidence: 2, projectRoots: ['.'] };
    },
    command: ({ binPath, outputPath, projectRoot }) => ({
      argv: [
        binPath,
        'scip',
        '.',
        '--output',
        outputPath,
        '--exclude-vendored-libraries',
      ],
      cwd: projectRoot,
    }),
  },
  {
    id: 'scip-java',
    name: 'scip-java',
    languages: ['java', 'kotlin', 'scala'],
    defaultBin: 'scip-java',
    maturity: 'production',
    detect: async (filenames) => {
      const buildTool = pickJvmBuildTool(filenames);
      if (!buildTool) return null;
      return { confidence: 2, projectRoots: ['.'] };
    },
    command: ({ binPath, outputPath, projectRoot }) => {
      // We pass the build tool flag explicitly; the picker is rerun here so
      // `command` stays pure (no captured state from `detect`).
      // The caller is responsible for ensuring `detect` matched first.
      const buildTool = pickJvmBuildToolSync(projectRoot);
      return {
        argv: [
          binPath,
          'index',
          ...(buildTool ? [`--build-tool=${buildTool}`] : []),
          '--output',
          outputPath,
        ],
        cwd: projectRoot,
      };
    },
  },
  {
    id: 'scip-clang',
    name: 'scip-clang',
    languages: ['cpp'],
    defaultBin: 'scip-clang',
    maturity: 'beta',
    detect: async (filenames) => {
      // scip-clang strictly requires compile_commands.json; without one we
      // skip and let tree-sitter take over.
      if (!filenames.has('compile_commands.json')) return null;
      return { confidence: 2, projectRoots: ['.'] };
    },
    command: ({ binPath, outputPath, projectRoot }) => ({
      argv: [
        binPath,
        '--compdb-path',
        'compile_commands.json',
        '-o',
        outputPath,
      ],
      cwd: projectRoot,
    }),
  },
];

// ── public API ─────────────────────────────────────────────────────────────

export interface DetectedIndexer {
  readonly spec: IndexerSpec;
  readonly result: DetectResult;
}

/**
 * Walk the repo's top-level filenames once and ask each spec whether it
 * applies. Returns specs sorted by descending confidence so the caller can
 * dispatch to them in priority order.
 */
export async function detectIndexers(
  repoRoot: string,
): Promise<readonly DetectedIndexer[]> {
  const filenames = await listTopLevel(repoRoot);
  const out: DetectedIndexer[] = [];
  for (const spec of INDEXER_REGISTRY) {
    const result = await spec.detect(filenames, repoRoot);
    if (result) out.push({ spec, result });
  }
  out.sort((a, b) => b.result.confidence - a.result.confidence);
  return out;
}

/**
 * Spawn an indexer binary and read back the produced `index.scip`. We do
 * **not** locate the binary for you — the caller must pass an absolute
 * path in `RunOpts.binPath`. The CLI handles resolution
 * (`CODEGRAPH_SCIP_<LANG>_BIN` env / pinned cache / $PATH; see §2.3).
 *
 * Output flow:
 *   - We allocate a temp file path, pass it to the spec's `command`,
 *     run the subprocess, and read the resulting bytes into a Buffer.
 *   - We always clean up the temp file, even on failure.
 *
 * Errors:
 *   - Non-zero exit: throw `ScipIndexerError` with stderr captured.
 *   - Missing output file: throw `ScipIndexerError` with the captured logs.
 *
 * We never automatically download the binary, never reach into $PATH, never
 * silently retry. The caller is responsible.
 */
export async function runIndexer(
  spec: IndexerSpec,
  repoRoot: string,
  opts: Omit<RunOpts, 'outputPath' | 'projectRoot'> & {
    /** Optional override; defaults to repo root. */
    readonly projectRoot?: string;
  },
): Promise<Buffer> {
  const projectRoot = opts.projectRoot ?? repoRoot;
  const outputPath = join(
    tmpdir(),
    `codegraph-scip-${spec.id}-${process.pid}-${Date.now()}.scip`,
  );

  const plan = spec.command({
    binPath: opts.binPath,
    outputPath,
    projectRoot,
    env: opts.env,
    hermetic: opts.hermetic,
  });

  try {
    await runSubprocess(plan, opts.env);
    // Some indexers exit 0 even when they fail to produce an output file
    // (notably scip-clang with an empty compdb). Treat a missing file as
    // a hard error so the caller sees a useful message.
    const s = await stat(outputPath).catch(() => null);
    if (!s || !s.isFile() || s.size === 0) {
      throw new ScipIndexerError(
        `${spec.id}: indexer exited 0 but did not produce a non-empty index.scip at ${outputPath}`,
      );
    }
    return await readFile(outputPath);
  } finally {
    await unlink(outputPath).catch(() => undefined);
  }
}

/** Thrown when an indexer subprocess fails or its output is missing. */
export class ScipIndexerError extends Error {
  constructor(
    message: string,
    /** Exit code, if the process started. `undefined` if the spawn itself failed. */
    public readonly exitCode?: number,
    /** Captured stderr; useful for diagnostics. May be empty. */
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'ScipIndexerError';
  }
}

// ── internals ──────────────────────────────────────────────────────────────

async function runSubprocess(
  plan: SpawnPlan,
  envOverrides: Readonly<Record<string, string>> | undefined,
): Promise<void> {
  const [bin, ...args] = plan.argv;
  if (!bin) {
    throw new ScipIndexerError('runIndexer: spec produced an empty argv');
  }

  const env = { ...process.env, ...(plan.env ?? {}), ...(envOverrides ?? {}) };

  return await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: plan.cwd,
      env,
      // No shell — we do not interpolate strings into a shell command line.
      // This avoids command-injection on user-controlled `binPath`.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      // Cap to a few KB to avoid ballooning memory on chatty indexers.
      if (stderrBuf.length > 64 * 1024) {
        stderrBuf = stderrBuf.slice(-64 * 1024);
      }
    });
    // Drain stdout so the child doesn't block on a full pipe buffer.
    child.stdout?.resume();

    child.once('error', (err) => {
      reject(
        new ScipIndexerError(
          `failed to spawn ${bin}: ${err.message}`,
          undefined,
          stderrBuf,
        ),
      );
    });

    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new ScipIndexerError(
          `${bin} exited with code ${code ?? 'null'}`,
          code ?? undefined,
          stderrBuf,
        ),
      );
    });
  });
}

async function listTopLevel(repoRoot: string): Promise<ReadonlySet<string>> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(repoRoot, { withFileTypes: true }).catch(
    () => [] as Awaited<ReturnType<typeof readdir>>,
  );
  return new Set(entries.map((e) => e.name));
}

function pickJvmBuildTool(
  filenames: ReadonlySet<string>,
): 'gradle' | 'maven' | 'sbt' | 'mill' | null {
  if (filenames.has('build.gradle') || filenames.has('build.gradle.kts'))
    return 'gradle';
  if (filenames.has('pom.xml')) return 'maven';
  if (filenames.has('build.sbt')) return 'sbt';
  if (filenames.has('build.sc')) return 'mill';
  return null;
}

/**
 * Synchronous variant for use inside `command`, which is itself synchronous.
 * Mirrors `pickJvmBuildTool` but reads the directory eagerly.
 */
function pickJvmBuildToolSync(
  projectRoot: string,
): 'gradle' | 'maven' | 'sbt' | 'mill' | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const names = new Set<string>();
  try {
    for (const entry of readdirSync(projectRoot)) names.add(entry);
  } catch {
    return null;
  }
  return pickJvmBuildTool(names);
}
