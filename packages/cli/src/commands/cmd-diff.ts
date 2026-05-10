/**
 * `codegraph diff <baseRef> <headRef>` — implementation.
 *
 * Each positional argument is **either** a path to an IR JSON file **or** a
 * git revision. Detection is by `fs.existsSync` first; if neither argument is
 * a file we fall through to the git-ref path, which (per design/incremental.md)
 * materializes the ref into a temporary `git worktree`, runs the indexer in
 * that checkout, and feeds the resulting IR into `diffIR`.
 *
 * Emit format (`--format`):
 *   - `json`     → raw `GraphDiff` from diff-impl, JSON-stringified
 *   - `markdown` → delegated to pr-comment-impl
 *   - `text`     → compact human-readable summary written here
 *   - `mermaid`  → delegated to cli-export (per team-lead routing)
 *
 * `--exit-on-change`: when set and the diff is non-empty, exits with
 * `ExitCode.DiffChanged` (4). Public API per packages/cli/README.md.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { stdout, stderr, exit } from "node:process";

import type { Command } from "commander";

// Upstream APIs.
//
//   - diff-impl + pr-comment-impl live behind `@codegraph/core` (top-level
//     exports per STRUCTURE.md §4.1).
//   - ir-loader confirmed its surface lives at the `@codegraph/core/ir`
//     subpath: `loadIR(path)` for files, `loadIRFromJSON(value, opts)` for
//     in-memory inputs (used on the worktree branch when cli-index returns
//     a parsed IR), and `IRLoadError` for typed error mapping (validation
//     failures populate `.errors[]`).
//   - cli-index is invoked programmatically as `runIndex({...})` from a
//     sibling commands module. Final import path TBD on its reply.
import { diffIR, renderPRComment } from "@codegraph/core";
import type { DiffResult, DiffOptions } from "@codegraph/core";
import { loadIR, loadIRFromJSON, IRLoadError } from "@codegraph/core/ir";
import type { IR } from "@codegraph/core/ir";
import { runIndex } from "./cmd-index.js";
import { runExport } from "./cmd-export.js";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Exit codes (mirrored locally so this file does not import from the entry
// module and create a cycle with `index.ts`).
// ---------------------------------------------------------------------------

const ExitCode = {
  Success: 0,
  UserError: 1,
  IndexerError: 2,
  IrValidationFailed: 3,
  DiffChanged: 4,
  ConfigError: 5,
  CacheError: 6,
  ServerError: 7,
  InternalError: 99,
} as const;

// ---------------------------------------------------------------------------
// Public CLI binding
// ---------------------------------------------------------------------------

interface GlobalOptions {
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  color?: boolean;
}

interface DiffCliOptions {
  format: "json" | "summary" | "text" | "mermaid" | "markdown";
  out?: string;
  exitOnChange: boolean;
  scope?: string;
  cacheDir?: string;
  adapters?: string;
}

/**
 * Wire the `diff` subcommand onto an existing commander root. Imported by
 * `packages/cli/src/index.ts` in place of the inline stub.
 */
export function registerDiffCommand(program: Command): Command {
  return program
    .command("diff")
    .description(
      "Diff two IRs. Arguments may be IR JSON files OR git revisions; in the latter case codegraph builds an IR for each ref.",
    )
    .argument("<baseRef>", "Base IR file or git revision.")
    .argument("<headRef>", "Head IR file or git revision.")
    .option(
      "-f, --format <fmt>",
      "Output format: json | summary | text | mermaid | markdown.",
      "summary",
    )
    .option("-o, --out <file>", "Write diff to <file> (default: stdout).")
    .option(
      "--exit-on-change",
      "Exit with code 4 if the diff is non-empty (useful for CI gates).",
      false,
    )
    .option(
      "--scope <selector>",
      "Restrict diff to a subgraph (comma-separated, e.g. `pkg:web,path:src/server/**`).",
    )
    .option("--cache-dir <dir>", "Cache directory passed through to the indexer when refs are given.")
    .option("-a, --adapters <list>", "Adapter ids passed through to the indexer when refs are given.")
    .action(
      async (
        baseRef: string,
        headRef: string,
        opts: Partial<DiffCliOptions>,
        cmd: Command,
      ) => {
        const global = cmd.optsWithGlobals<GlobalOptions>();
        try {
          const code = await runDiff(baseRef, headRef, opts, global);
          exit(code);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          stderr.write(`codegraph: ${message}\n`);
          exit(ExitCode.InternalError);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

/**
 * Programmatic entry-point. Returns the exit code so `action-impl` can wrap us
 * without spawning a subprocess.
 */
export async function runDiff(
  baseRef: string,
  headRef: string,
  cli: Partial<DiffCliOptions>,
  global: GlobalOptions,
): Promise<number> {
  const format = cli.format ?? "summary";
  if (!isValidFormat(format)) {
    stderr.write(
      `codegraph: invalid --format "${format}"; expected one of json|summary|text|mermaid|markdown\n`,
    );
    return ExitCode.UserError;
  }

  // 1. Resolve each argument to an IR.
  let base: IR;
  let head: IR;
  const cleanups: Array<() => void> = [];
  try {
    [base, head] = await Promise.all([
      resolveArgToIR(baseRef, "base", cli, global, cleanups),
      resolveArgToIR(headRef, "head", cli, global, cleanups),
    ]);
  } catch (err) {
    runCleanups(cleanups);
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`codegraph: ${message}\n`);
    // Loader / indexer surface their own typed errors; default-bucket here.
    if (err instanceof DiffUserError) return err.code;
    return ExitCode.IndexerError;
  }

  // 2. Run the diff.
  let result: DiffResult;
  try {
    const opts = buildDiffOptions(cli);
    result = await Promise.resolve(diffIR(base, head, opts));
  } catch (err) {
    runCleanups(cleanups);
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`codegraph: diff failed: ${message}\n`);
    return ExitCode.IrValidationFailed;
  }

  // 3. Render per --format.
  let payload: string;
  try {
    payload = await renderDiff(result, format, base, head, cli, global);
  } catch (err) {
    runCleanups(cleanups);
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`codegraph: render failed: ${message}\n`);
    return ExitCode.InternalError;
  }

  // 4. Write to --out or stdout.
  if (cli.out) {
    writeFileSync(cli.out, payload.endsWith("\n") ? payload : payload + "\n");
  } else {
    stdout.write(payload.endsWith("\n") ? payload : payload + "\n");
  }

  // 5. Cleanup any worktrees we created.
  runCleanups(cleanups);

  // 6. --exit-on-change.
  if (cli.exitOnChange && isNonEmpty(result)) {
    return ExitCode.DiffChanged;
  }
  return ExitCode.Success;
}

// ---------------------------------------------------------------------------
// Argument resolution: path | git ref → IR
// ---------------------------------------------------------------------------

class DiffUserError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

async function resolveArgToIR(
  arg: string,
  side: "base" | "head",
  cli: Partial<DiffCliOptions>,
  global: GlobalOptions,
  cleanups: Array<() => void>,
): Promise<IR> {
  if (existsSync(arg)) {
    try {
      return await loadIR(arg);
    } catch (err) {
      throw classifyLoadError(err, side, arg);
    }
  }
  // Treat as a git revision — materialize a worktree, run the indexer there,
  // and load its IR back. The cleanup closure removes the worktree.
  return await indexAtRef(arg, side, cli, global, cleanups);
}

/**
 * Map an `IRLoadError` to the right CLI exit code.
 *
 * Per ir-loader: `errors[].length > 0` ⇒ schema validation failure
 * (ExitCode.IrValidationFailed). Anything else (file-not-found, parse error,
 * migration failure) is a UserError — the file path was wrong or the bytes
 * were not a recognizable IR document.
 */
function classifyLoadError(err: unknown, side: "base" | "head", source: string): DiffUserError {
  if (err instanceof IRLoadError && err.errors.length > 0) {
    for (const issue of err.errors) {
      stderr.write(`  ${issue.path}: ${issue.message}\n`);
    }
    return new DiffUserError(
      `${side} IR at "${source}" failed schema validation`,
      ExitCode.IrValidationFailed,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new DiffUserError(
    `${side} IR at "${source}" failed to load: ${message}`,
    ExitCode.UserError,
  );
}

async function indexAtRef(
  ref: string,
  side: "base" | "head",
  cli: Partial<DiffCliOptions>,
  global: GlobalOptions,
  cleanups: Array<() => void>,
): Promise<IR> {
  // Validate the ref before paying for a worktree. `git rev-parse --verify`
  // returns the SHA on success, non-zero on bad ref.
  try {
    await execFile("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    throw new DiffUserError(
      `"${ref}" is neither an existing file nor a valid git revision`,
      ExitCode.UserError,
    );
  }

  const worktreeDir = mkdtempSync(join(tmpdir(), `codegraph-diff-${side}-`));
  cleanups.push(() => removeWorktree(worktreeDir));

  try {
    // `--detach` avoids creating a branch; `--quiet` keeps stderr clean unless
    // the user passed --verbose, in which case the indexer will print its own.
    const args = ["worktree", "add", "--detach", "--quiet", worktreeDir, ref];
    await execFile("git", args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DiffUserError(
      `failed to create git worktree for "${ref}": ${message}`,
      ExitCode.UserError,
    );
  }

  // Hand off to cli-index. We accept whichever return shape it produces:
  //   - `{ ir }`     → already-parsed IR; revalidate via loadIRFromJSON so
  //                    any version-mismatch / shape error surfaces with the
  //                    same `IRLoadError` semantics as the file branch.
  //   - `{ irPath }` → an IR file written to disk; load + validate from it.
  let ir: IR;
  try {
    const indexed = await runIndex({
      cwd: worktreeDir,
      config: global.config,
      cacheDir: cli.cacheDir,
      adapters: cli.adapters ? splitList(cli.adapters) : undefined,
      verbose: global.verbose,
      quiet: global.quiet,
    });
    if ("ir" in indexed) {
      ir = loadIRFromJSON(indexed.ir, { sourceLabel: `${side}@${ref}` });
    } else {
      ir = await loadIR(indexed.irPath);
    }
  } catch (err) {
    if (err instanceof IRLoadError) {
      throw classifyLoadError(err, side, `${ref} (worktree)`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new DiffUserError(
      `indexing ref "${ref}" failed: ${message}`,
      ExitCode.IndexerError,
    );
  }
  return ir;
}

function removeWorktree(path: string): void {
  // Best-effort. `git worktree remove` is the right call when the worktree was
  // registered; `rm -rf` is the fallback if the directory was never linked.
  try {
    execFileCb("git", ["worktree", "remove", "--force", path], () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // swallow — the user can `git worktree prune` later
      }
    });
  } catch {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function runCleanups(cleanups: Array<() => void>): void {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Diff options + output rendering
// ---------------------------------------------------------------------------

function buildDiffOptions(cli: Partial<DiffCliOptions>): DiffOptions | undefined {
  if (!cli.scope) return undefined;
  return { scope: splitList(cli.scope) };
}

async function renderDiff(
  result: DiffResult,
  format: DiffCliOptions["format"],
  base: IR,
  head: IR,
  cli: Partial<DiffCliOptions>,
  global: GlobalOptions,
): Promise<string> {
  switch (format) {
    case "json":
      return JSON.stringify(result, null, 2);
    case "markdown":
      return renderPRComment(result, {
        // For plain CLI use we have no PR title / viewer URL; pr-comment-impl
        // is expected to fall back to the commit shas in `result.base`/`.head`.
        baseSha: result.base?.commit,
        headSha: result.head?.commit,
      });
    case "mermaid":
      // Delegated to cli-export per team-lead routing. We pass the diff in via
      // a shared in-memory handoff; runExport returns the rendered string.
      return await runExport({
        format: "mermaid",
        diff: result,
      });
    case "text":
    case "summary":
    default:
      return renderText(result);
  }
}

/**
 * Compact human-readable summary. Single line per non-empty bucket, then a
 * leading severity rollup if the diff carries one.
 */
function renderText(result: DiffResult): string {
  const lines: string[] = [];
  const counts = result.summary?.counts ?? deriveCounts(result);
  const total = sumCounts(counts);

  if (total === 0) {
    return "No graph changes detected.";
  }

  lines.push(
    `${total} change${total === 1 ? "" : "s"} between ${shortSha(result.base?.commit)} and ${shortSha(result.head?.commit)}:`,
  );
  if (counts.addedNodes) lines.push(`  + ${counts.addedNodes} node${plural(counts.addedNodes)} added`);
  if (counts.removedNodes) lines.push(`  - ${counts.removedNodes} node${plural(counts.removedNodes)} removed`);
  if (counts.changedNodes) lines.push(`  ~ ${counts.changedNodes} node${plural(counts.changedNodes)} changed`);
  if (counts.addedEdges) lines.push(`  + ${counts.addedEdges} edge${plural(counts.addedEdges)} added`);
  if (counts.removedEdges) lines.push(`  - ${counts.removedEdges} edge${plural(counts.removedEdges)} removed`);
  if (counts.changedEdges) lines.push(`  ~ ${counts.changedEdges} edge${plural(counts.changedEdges)} changed`);
  if (counts.renameHints) lines.push(`  ? ${counts.renameHints} rename hint${plural(counts.renameHints)}`);

  // Top items if the diff carries them — useful for fail-fast triage on stdout.
  const top = result.summary?.topItems ?? [];
  if (top.length > 0) {
    lines.push("");
    lines.push(`Top ${Math.min(top.length, 5)} by severity:`);
    for (const item of top.slice(0, 5)) {
      lines.push(`  [${item.severity}] ${item.ref} (score ${item.score})`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidFormat(f: string): f is DiffCliOptions["format"] {
  return f === "json" || f === "summary" || f === "text" || f === "mermaid" || f === "markdown";
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface DiffCounts {
  addedNodes: number;
  removedNodes: number;
  changedNodes: number;
  addedEdges: number;
  removedEdges: number;
  changedEdges: number;
  renameHints: number;
}

function deriveCounts(result: DiffResult): DiffCounts {
  return {
    addedNodes: result.addedNodes?.length ?? 0,
    removedNodes: result.removedNodes?.length ?? 0,
    changedNodes: result.changedNodes?.length ?? 0,
    addedEdges: result.addedEdges?.length ?? 0,
    removedEdges: result.removedEdges?.length ?? 0,
    changedEdges: result.changedEdges?.length ?? 0,
    renameHints: result.renameHints?.length ?? 0,
  };
}

function sumCounts(c: DiffCounts | Record<string, number>): number {
  let n = 0;
  for (const v of Object.values(c)) n += typeof v === "number" ? v : 0;
  return n;
}

function isNonEmpty(result: DiffResult): boolean {
  // RenameHints alone do not count — they're advisory and always pair with an
  // add+remove that already counts. summary.counts excludes hint-only deltas
  // in design §1.2, so we use the explicit non-hint sum.
  return (
    (result.addedNodes?.length ?? 0) +
      (result.removedNodes?.length ?? 0) +
      (result.changedNodes?.length ?? 0) +
      (result.addedEdges?.length ?? 0) +
      (result.removedEdges?.length ?? 0) +
      (result.changedEdges?.length ?? 0) >
    0
  );
}

function shortSha(sha: string | undefined): string {
  if (!sha) return "<unknown>";
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

// Re-export for tests / programmatic callers.
export { ExitCode };
