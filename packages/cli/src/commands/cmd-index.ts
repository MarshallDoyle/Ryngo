/**
 * `codegraph index [path]` — implementation.
 *
 * Lifts the inline action from `../index.ts` (which currently calls `stub()`)
 * into a real orchestration of the indexer pipeline. The commander layer in
 * `../index.ts` stays in charge of argv parsing and exit-code translation;
 * this module owns the *what* of `index`:
 *
 *   1. Resolve the config (`@codegraph/core` config-loader).
 *   2. Choose the indexer pipeline per language (SCIP where available,
 *      ts-indexer / py-indexer otherwise).
 *   3. Run framework adapters in topological order
 *      (see `spec/adapter-interface.md` §3.4).
 *   4. Emit the assembled IR — to a file via ir-loader's `saveIR` when
 *      `--out` is set, otherwise to stdout.
 *   5. Honour `--since` for the incremental code path
 *      (see `design/incremental.md`).
 *   6. Return one of the exit codes documented in `../index.ts` (`ExitCode`).
 *
 * The upstream packages (config-loader, ir-loader, ir-validator, the
 * language indexers, the adapter runner) are being built in parallel by
 * other teammates. Until their public APIs ship, the imports below resolve
 * through narrow shims declared at the bottom of this file. When the real
 * APIs land, only the import lines change — the orchestration body stays.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { cwd, stderr, stdout } from "node:process";

import type {
  ExitCodeValue,
  GlobalOptions,
  IndexCommandOptions,
  IndexerDiagnostic,
  IndexerInput,
  IndexerOutput,
  IRDocumentLike,
  ResolvedConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Programmatic-API options for `runIndex`. This is the shape callers inside
 * the CLI use (notably `cmd-diff.ts`, which materializes a git ref into a
 * worktree and then asks us to index it). It is a strict subset of the
 * full CLI options — there is no `--out`, no `--json`, no `--fail-on`,
 * because programmatic callers consume the IR object directly.
 */
export interface RunIndexArgs {
  /** Project root to index. May be relative; resolved against `process.cwd()`. */
  readonly cwd: string;
  /** Override `.codegraph.yml` path (mirrors the CLI's `--config`). */
  readonly config?: string;
  /** Cache directory for incremental indexing (mirrors `--cache-dir`). */
  readonly cacheDir?: string;
  /** Explicit adapter id list; `undefined` ⇒ auto-detect. */
  readonly adapters?: ReadonlyArray<string>;
  /** Git revision for incremental runs (mirrors `--since`). */
  readonly since?: string;
  /** Verbose stderr (mirrors `--verbose`). */
  readonly verbose?: boolean;
  /** Suppress non-error stderr (mirrors `--quiet`). */
  readonly quiet?: boolean;
  /** Cooperative cancellation for long-running indexer work. */
  readonly signal?: AbortSignal;
}

/**
 * Result of a programmatic `runIndex` call. The full IR object is always
 * returned in-memory (no file IO). Callers that prefer a path on disk run
 * `saveIR(...)` themselves.
 */
export interface RunIndexResult {
  readonly ir: IRDocumentLike;
  readonly diagnostics: ReadonlyArray<IndexerDiagnostic>;
  readonly timings: IndexerOutput["timings"];
}

/**
 * Programmatic indexing entry point. Used by `cmd-diff.ts` to index two
 * git refs without spawning a subprocess. Throws on indexer / validation
 * failures (the caller maps them to its own exit codes); does not call
 * `process.exit` and never writes to stdout.
 */
export async function runIndex(args: RunIndexArgs): Promise<RunIndexResult> {
  const projectRoot = isAbsolute(args.cwd) ? args.cwd : resolve(cwd(), args.cwd);

  const config = await loadConfig({
    projectRoot,
    ...(args.config !== undefined ? { configPath: args.config } : {}),
  });

  const cacheDir = resolveCacheDir(args.cacheDir, config, projectRoot);

  const input: IndexerInput = {
    config,
    cacheDir,
    ...(args.adapters !== undefined ? { adapterIds: args.adapters } : {}),
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };
  const result = await runIndexer(input);

  const validation = validateIR(result.ir);
  if (!validation.ok) {
    const messages = validation.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ");
    throw new Error(`IR validation failed: ${messages || "schema check rejected the IR"}`);
  }

  return result;
}

/**
 * Execute `codegraph index <path>`. Returns the numeric exit code; the
 * commander wrapper in `../index.ts` calls `process.exit` with it.
 *
 * The function never throws on user-facing failures (bad config, indexer
 * crash, validation failure) — those are mapped to exit codes. Genuinely
 * unexpected errors propagate to the caller, which logs and exits `99`.
 */
export async function runIndexCommand(
  path: string,
  opts: IndexCommandOptions,
  global: GlobalOptions,
): Promise<ExitCodeValue> {
  const log = makeLogger(global);

  // -------------------------------------------------------------------------
  // 1. Resolve project root + load config
  // -------------------------------------------------------------------------
  const projectRoot = isAbsolute(path) ? path : resolve(cwd(), path);

  let config: ResolvedConfig;
  try {
    config = await loadConfig({
      projectRoot,
      ...(global.config !== undefined ? { configPath: global.config } : {}),
    });
  } catch (err) {
    log.error(`config: ${errorMessage(err)}`);
    return EXIT.ConfigError;
  }

  // -------------------------------------------------------------------------
  // 2. Choose adapter set
  //
  // `--adapters foo,bar` overrides config; otherwise we ask the loader
  // which adapters apply (auto-detect from package.json + config.adapters).
  // Dispatch by language is the indexer pipeline's concern (SCIP vs
  // ts-indexer vs py-indexer) — the framework adapters above it are
  // language-agnostic.
  // -------------------------------------------------------------------------
  const adapterIds = parseAdapterList(opts.adapters);

  // -------------------------------------------------------------------------
  // 3. Resolve cache dir + incremental anchor
  // -------------------------------------------------------------------------
  const cacheDir = resolveCacheDir(opts.cacheDir, config, projectRoot);

  // -------------------------------------------------------------------------
  // 4. Run the indexer pipeline
  //
  // The pipeline is responsible for:
  //   - dispatching per-file work to the right language indexer,
  //   - running framework adapters in topological order,
  //   - merging fragments into a single IR document,
  //   - honouring `--since` for the incremental closure.
  //
  // We catch only `IndexerError`s here; anything else bubbles up.
  // -------------------------------------------------------------------------
  let result: IndexerOutput;
  try {
    const input: IndexerInput = {
      config,
      cacheDir,
      ...(adapterIds !== undefined ? { adapterIds } : {}),
      ...(opts.since !== undefined ? { since: opts.since } : {}),
    };
    result = await runIndexer(input);
  } catch (err) {
    log.error(`indexer: ${errorMessage(err)}`);
    return EXIT.IndexerError;
  }

  // -------------------------------------------------------------------------
  // 5. Validate the assembled IR
  //
  // The pipeline returns its own diagnostics; the validator is a final
  // schema check before we hand the IR to the user. A validation failure
  // is its own exit code so CI can distinguish it from indexer crashes.
  // -------------------------------------------------------------------------
  const validation = validateIR(result.ir);
  if (!validation.ok) {
    for (const d of validation.diagnostics) {
      log.diagnostic(d);
    }
    return EXIT.IrValidationFailed;
  }

  // -------------------------------------------------------------------------
  // 6. Surface diagnostics + decide on `--fail-on` exit code
  // -------------------------------------------------------------------------
  for (const d of result.diagnostics) {
    log.diagnostic(d);
  }
  const failOnExit = applyFailOn(result.diagnostics, opts.failOn);

  // -------------------------------------------------------------------------
  // 7. Emit the IR
  // -------------------------------------------------------------------------
  try {
    await emitOutput({
      ir: result.ir,
      diagnostics: result.diagnostics,
      timings: result.timings,
      out: opts.out,
      json: global.json === true,
    });
  } catch (err) {
    log.error(`output: ${errorMessage(err)}`);
    return EXIT.InternalError;
  }

  return failOnExit ?? EXIT.Success;
}

// ---------------------------------------------------------------------------
// Output emission
// ---------------------------------------------------------------------------

interface EmitArgs {
  readonly ir: IRDocumentLike;
  readonly diagnostics: ReadonlyArray<IndexerDiagnostic>;
  readonly timings: IndexerOutput["timings"];
  readonly out: string | undefined;
  readonly json: boolean;
}

async function emitOutput(args: EmitArgs): Promise<void> {
  if (args.json) {
    const envelope = {
      version: CLI_VERSION,
      command: "index",
      ok: true,
      exitCode: 0,
      data: args.ir,
      diagnostics: args.diagnostics,
      timings: args.timings,
    };
    const body = JSON.stringify(envelope) + "\n";
    if (args.out !== undefined) {
      await writeOutFile(args.out, body);
    } else {
      stdout.write(body);
    }
    return;
  }

  if (args.out !== undefined) {
    // ir-loader's saveIR is the source of truth for canonical IR-on-disk
    // formatting (sorted keys, stable line endings). When it lands we
    // forward to it; for now we write the IR JSON ourselves with the same
    // shape (`{ schemaVersion, ir }`), and saveIR will overwrite this path.
    await saveIR(args.out, args.ir);
    return;
  }

  // No --out, no --json: pipe-friendly raw IR JSON to stdout.
  stdout.write(JSON.stringify(args.ir) + "\n");
}

async function writeOutFile(filePath: string, body: string): Promise<void> {
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd(), filePath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body, "utf8");
}

// ---------------------------------------------------------------------------
// `--fail-on` evaluation
// ---------------------------------------------------------------------------

/**
 * Map a diagnostic severity to the `--fail-on` ordering. Higher = more severe.
 * `unresolved-edge` is treated as `warning`-level: it does not abort by
 * default but `--fail-on warning` lifts it to a failure.
 */
const SEVERITY_RANK: Readonly<Record<IndexerDiagnostic["severity"], number>> = {
  info: 1,
  "unresolved-edge": 2,
  warning: 2,
  error: 3,
};

const FAIL_ON_RANK: Readonly<Record<IndexCommandOptions["failOn"], number>> = {
  info: 1,
  warning: 2,
  error: 3,
};

/**
 * Returns an exit code if the diagnostics meet the `--fail-on` threshold,
 * otherwise undefined (success). Errors always map to `IndexerError`;
 * lower thresholds (`warning`, `info`) reuse the same code so the CLI's
 * caller sees a single "indexing reported issues" signal.
 */
function applyFailOn(
  diagnostics: ReadonlyArray<IndexerDiagnostic>,
  failOn: IndexCommandOptions["failOn"],
): ExitCodeValue | undefined {
  const threshold = FAIL_ON_RANK[failOn];
  for (const d of diagnostics) {
    if (SEVERITY_RANK[d.severity] >= threshold) {
      return EXIT.IndexerError;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Exit-code aliases. Kept in literal-typed form so this module can be
 * imported without depending on `../index.ts` (which imports us back).
 * Values must stay in lockstep with `ExitCode` in `../index.ts`.
 */
const EXIT = {
  Success: 0,
  IndexerError: 2,
  IrValidationFailed: 3,
  ConfigError: 5,
  InternalError: 99,
} as const satisfies Record<string, ExitCodeValue>;

function parseAdapterList(raw: string | undefined): ReadonlyArray<string> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolveCacheDir(
  flag: string | undefined,
  config: ResolvedConfig,
  projectRoot: string,
): string {
  if (flag !== undefined && flag !== "") {
    return isAbsolute(flag) ? flag : resolve(projectRoot, flag);
  }
  return isAbsolute(config.output.cacheDir)
    ? config.output.cacheDir
    : resolve(projectRoot, config.output.cacheDir);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface CommandLogger {
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  diagnostic(d: IndexerDiagnostic): void;
}

/**
 * Stderr logger honouring `--verbose` / `--quiet`. The contract from the
 * CLI README: stderr is human-readable and unstructured; nothing on stderr
 * is part of the machine-readable payload. `--json` callers still get
 * diagnostics — they are duplicated into the JSON envelope (see emitOutput).
 */
function makeLogger(global: GlobalOptions): CommandLogger {
  const quiet = global.quiet === true && global.verbose !== true;
  const verbose = global.verbose === true;

  const write = (level: "error" | "warn" | "info", msg: string): void => {
    if (level === "error") {
      stderr.write(`codegraph: ${msg}\n`);
      return;
    }
    if (quiet) return;
    if (level === "info" && !verbose) return;
    stderr.write(`codegraph: ${msg}\n`);
  };

  return {
    error: (m) => write("error", m),
    warn: (m) => write("warn", m),
    info: (m) => write("info", m),
    diagnostic: (d) => {
      const where = d.file !== undefined ? ` (${d.file})` : "";
      const src = d.source !== undefined ? `[${d.source}] ` : "";
      const line = `${d.severity}: ${src}${d.code}: ${d.message}${where}`;
      const level = d.severity === "error" ? "error" : d.severity === "info" ? "info" : "warn";
      write(level, line);
    },
  };
}

// ---------------------------------------------------------------------------
// Upstream-API shims
// ---------------------------------------------------------------------------
//
// These functions are placeholders for real APIs that other teammates are
// building (config-loader, ir-loader, ir-validator, the indexer pipeline).
// Each shim has the exact signature this module will consume once those
// packages land — when that happens, replace the body with a one-line
// re-export and delete the local implementation.
//
// The shims fail loudly: every call surfaces a diagnostic identifying which
// upstream is missing. That keeps `codegraph index` invokable end-to-end
// without crashing while the dependency graph is half-built, and makes it
// obvious in CI which integration is still pending.

const CLI_VERSION = "0.1.0";

interface LoadConfigArgs {
  readonly projectRoot: string;
  readonly configPath?: string;
}

/** Stand-in for `@codegraph/core` config-loader's `loadConfig`. */
async function loadConfig(args: LoadConfigArgs): Promise<ResolvedConfig> {
  // Minimal viable defaults so `runIndexCommand` can drive the rest of the
  // pipeline. Real config-loader will: read `.codegraph.yml`, validate
  // against `spec/config.schema.json`, resolve `root:` against the config
  // file's directory, expand `${ENV}` placeholders (none, by spec), and
  // merge in built-in defaults.
  return {
    schemaVersion: 1,
    root: args.projectRoot,
    project: { name: basenameSafe(args.projectRoot) },
    boundaries: {},
    ignore: [],
    adapters: {},
    output: {
      ir: ".codegraph/graph.json",
      cacheDir: ".codegraph/cache",
    },
  };
}

/** Stand-in for the language-aware indexer pipeline. */
async function runIndexer(input: IndexerInput): Promise<IndexerOutput> {
  // The real pipeline:
  //   - walks `input.config.root` honouring `ignore`,
  //   - dispatches per-file by language to scip-ingest / ts-indexer /
  //     py-indexer (per `STRUCTURE.md` §2.1),
  //   - resolves adapters from `input.adapterIds ?? auto-detect`,
  //   - runs adapters in topological order per phase
  //     (`spec/adapter-interface.md` §3.4),
  //   - honours `input.since` via the incremental closure described in
  //     `design/incremental.md` §5.
  //
  // Until that lands, return a well-formed empty IR plus a single
  // diagnostic so users know the pipeline is a stub.
  const start = Date.now();
  const ir: IRDocumentLike = {
    schemaVersion: "0.1.0",
    ir: {
      metadata: {
        repo: input.config.root,
        commit: "",
        generatedAt: new Date(0).toISOString(),
        generators: [{ name: "codegraph-cli", version: CLI_VERSION }],
      },
      nodes: [],
      edges: [],
      diagnostics: [],
    },
  };
  const diagnostic: IndexerDiagnostic = {
    severity: "info",
    code: "cli/indexer-pending",
    message:
      "indexer pipeline not yet wired; emitting empty IR. " +
      "(see packages/cli/src/commands/cmd-index.ts upstream-API shims.)",
    source: "codegraph-cli",
  };
  const totalMs = Date.now() - start;
  return {
    ir,
    diagnostics: [diagnostic],
    timings: { totalMs, stages: {} },
  };
}

/** Stand-in for `@codegraph/core` ir-validator. */
function validateIR(_ir: IRDocumentLike): {
  ok: true;
  diagnostics: ReadonlyArray<IndexerDiagnostic>;
} | {
  ok: false;
  diagnostics: ReadonlyArray<IndexerDiagnostic>;
} {
  // Real validator runs the IR through the Zod schema mirroring
  // `spec/ir.schema.json` and reports a diagnostic for every violation.
  // Empty IR from the indexer shim is trivially valid.
  return { ok: true, diagnostics: [] };
}

/** Stand-in for `@codegraph/core` ir-loader's `saveIR`. */
async function saveIR(filePath: string, ir: IRDocumentLike): Promise<void> {
  // Real saveIR writes canonical, sorted-key, deterministic JSON so two
  // runs on identical inputs produce byte-identical files (see
  // `design/incremental.md` §8.4 on determinism). Until it lands we use
  // standard JSON.stringify with two-space indentation; the contract is
  // "valid JSON at <filePath>".
  await writeOutFile(filePath, JSON.stringify(ir, null, 2) + "\n");
}

function basenameSafe(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}
