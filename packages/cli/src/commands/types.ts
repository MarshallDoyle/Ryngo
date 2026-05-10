/**
 * Shared command types.
 *
 * Each `codegraph <subcommand>` lives in its own `cmd-*.ts` file under
 * `packages/cli/src/commands/`. The commander action handlers in
 * `packages/cli/src/index.ts` are intentionally thin: they parse argv into
 * the typed shapes declared here, then dispatch to a `runFooCommand(...)`
 * exported from the matching `cmd-foo.ts`.
 *
 * Keeping the types in one file gives every command the same vocabulary for
 * global flags (`--config`, `--json`, `--verbose`, ...) and the same exit-code
 * contract (mirrored from `../index.ts`'s `ExitCode` constant).
 */

// ---------------------------------------------------------------------------
// Global flags (mirrors the program-level options in src/index.ts)
// ---------------------------------------------------------------------------

/**
 * Global options resolved from `program.optsWithGlobals<GlobalOptions>()`.
 *
 * Commander coerces the `--no-color` flag into the boolean `color`: `true`
 * when color is allowed, `false` when the user passed `--no-color`. We
 * preserve that shape so call sites never have to reason about negation.
 */
export interface GlobalOptions {
  /** `-c, --config <path>` — path to `.codegraph.yml`. */
  readonly config?: string;
  /** `-v, --verbose` — verbose diagnostics on stderr. */
  readonly verbose?: boolean;
  /** `-q, --quiet` — suppress non-error stderr output. */
  readonly quiet?: boolean;
  /** `--json` — wrap stdout in a single JSON envelope. */
  readonly json?: boolean;
  /** `--no-color` → `color: false`; default → `color: true`. */
  readonly color?: boolean;
}

// ---------------------------------------------------------------------------
// Exit-code contract (re-export of src/index.ts ExitCode values)
// ---------------------------------------------------------------------------

/**
 * Numeric exit code returned by every `runFooCommand`. Stays in lockstep with
 * the `ExitCode` constant in `../index.ts`; we keep the literal union here so
 * commands can return a code without importing the parent module (which
 * would create a cycle once `../index.ts` imports them).
 */
export type ExitCodeValue = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 99;

// ---------------------------------------------------------------------------
// `codegraph index` — typed options
// ---------------------------------------------------------------------------

/** `--fail-on <level>` — diagnostic severity that flips the exit code. */
export type FailOnLevel = "error" | "warning" | "info";

/**
 * The shape produced by commander for `codegraph index [path] --opts...`.
 * `path` is the positional argument (defaults to `"."`); all other fields
 * map 1:1 to the flags declared in `src/index.ts`.
 *
 * `out` and `cacheDir` are absent when the user did not pass the flag and
 * no env-var default applied; `--out` writes IR JSON to the file, otherwise
 * we write to stdout.
 */
export interface IndexCommandOptions {
  /** `-o, --out <file>`. */
  readonly out?: string;
  /** `--cache-dir <dir>` (or `$CODEGRAPH_CACHE`). */
  readonly cacheDir?: string;
  /** `-a, --adapters <list>` — comma-separated adapter ids. */
  readonly adapters?: string;
  /** `--since <git-rev>` — incremental run anchor. */
  readonly since?: string;
  /** `--fail-on <level>`. */
  readonly failOn: FailOnLevel;
}

// ---------------------------------------------------------------------------
// Forward-declared upstream shapes
// ---------------------------------------------------------------------------
//
// The packages this CLI orchestrates (config-loader, ir-loader, ir-validator,
// the indexer pipeline) are still being built by other teammates. Until their
// public APIs land in `@codegraph/core`, we describe the shapes we need here
// so that the orchestration code in `cmd-index.ts` typechecks against a
// stable contract. When the real types ship, these declarations get deleted
// and the command imports them from `@codegraph/core` directly.

/**
 * The fully-resolved config the indexer needs. Mirrors the shape documented
 * in `spec/config-schema.md`. Only the fields the index command consumes are
 * listed; everything else is a passthrough that the loader hands to adapters.
 */
export interface ResolvedConfig {
  readonly schemaVersion: 1;
  /** Absolute path to the analysis root (after resolving `root:` against config dir). */
  readonly root: string;
  readonly project: { readonly name: string; readonly description?: string };
  readonly boundaries: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly ignore: ReadonlyArray<string>;
  /** Adapter id → adapter-specific options blob. `null` disables an adapter. */
  readonly adapters: Readonly<Record<string, Readonly<Record<string, unknown>> | null>>;
  /** Where to put the IR JSON when `--out` is omitted. */
  readonly output: { readonly ir: string; readonly cacheDir: string };
}

/**
 * Minimum subset of the IR document the index command needs to handle. The
 * full type lives in `spec/ir.types.ts` and will be imported from
 * `@codegraph/core` once `ir-types` lands.
 */
export interface IRDocumentLike {
  readonly schemaVersion: string;
  readonly ir: {
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly nodes: ReadonlyArray<unknown>;
    readonly edges: ReadonlyArray<unknown>;
    readonly diagnostics?: ReadonlyArray<IndexerDiagnostic>;
  };
}

/**
 * Diagnostic emitted by an indexer or adapter. The severity strings match the
 * adapter-interface spec; `"unresolved-edge"` is downgraded to `"warning"`
 * for `--fail-on` purposes (it has its own placeholder edge in the IR).
 */
export interface IndexerDiagnostic {
  readonly severity: "info" | "warning" | "error" | "unresolved-edge";
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly source?: string;
}

/**
 * Inputs the indexer pipeline accepts. `since` triggers the incremental
 * code path described in `design/incremental.md`; `cacheDir` is honored
 * regardless (warm cache is reused even on full runs).
 */
export interface IndexerInput {
  readonly config: ResolvedConfig;
  readonly cacheDir: string;
  /** Subset of adapter ids to run; if omitted the loader auto-detects. */
  readonly adapterIds?: ReadonlyArray<string>;
  /** Git revision for `--since`; absent ⇒ full run. */
  readonly since?: string;
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
}

/** What the indexer pipeline returns. */
export interface IndexerOutput {
  readonly ir: IRDocumentLike;
  readonly diagnostics: ReadonlyArray<IndexerDiagnostic>;
  /** Per-stage timings (ms). Stable shape so the `--json` envelope is typed. */
  readonly timings: { readonly totalMs: number; readonly stages: Readonly<Record<string, number>> };
}
