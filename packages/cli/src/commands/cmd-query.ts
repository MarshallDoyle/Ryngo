/**
 * `codegraph query "<expr>"` — implementation.
 *
 * Thin shell over `runQuery` from `@codegraph/core/query`. The actual engine,
 * planner, and formatter live in core; this file is responsible only for
 * argument parsing, IR loading, exit-code mapping, and stdin/file resolution.
 *
 * Behaviors per design/query-language.md §5:
 *   - `--ir <file>`           explicit IR path (default: ./codegraph.json,
 *                             then ./build/codegraph.json — same as serve)
 *   - `--file <path>`         read query from file (or `-` for stdin)
 *   - `--params <expr>`       JSON object, key=value list, or @file
 *   - `--format <fmt>`        table | json | path | subgraph | dot | mermaid
 *                             default: table on TTY, json otherwise
 *   - `--explain`             print the chosen plan instead of executing
 *   - `--max-path-length <n>` override the default 16 cap on `*` paths
 *   - `--pr <ref>`            run `codegraph diff <ref>...HEAD` first and
 *                             populate changedInPR()
 *   - `--quiet`               drop `stats` from the result envelope
 *   - `--fail-empty`          exit code 1 if zero rows
 *
 * Exit codes (mirrored from packages/cli/src/index.ts):
 *   0  success
 *   1  --fail-empty triggered, or generic user error
 *   2  parse error
 *   3  runtime error
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { stdin, stdout, stderr, exit } from "node:process";

import type { Command } from "commander";

import { runQuery } from "@codegraph/core/query";
import {
  ALL_CLI_FORMATS,
  defaultFormatFor,
  formatResult,
  parseParamsArg,
  type CliFormat,
} from "@codegraph/core/query";
import { loadIR } from "../ir-loader.js";

// =============================================================================
// Exit codes
// =============================================================================

const ExitCode = {
  Success: 0,
  UserError: 1,
  ParseError: 2,
  RuntimeError: 3,
  IndexerError: 2,
  IrValidationFailed: 3,
  InternalError: 99,
} as const;

// =============================================================================
// Public CLI binding
// =============================================================================

interface GlobalOptions {
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
}

interface QueryCliOptions {
  ir?: string;
  file?: string;
  params?: string;
  format?: string;
  explain?: boolean;
  maxPathLength?: string;
  pr?: string;
  failEmpty?: boolean;
  highlight?: boolean;
}

export function registerQueryCommand(program: Command): Command {
  return program
    .command("query")
    .description("Run a cgql query against an IR. Pipe in a query, pass --file, or quote it inline.")
    .argument("[expr]", "Inline cgql expression. Omit to read from stdin or --file.")
    .option("--ir <file>", "Path to a codegraph.json IR (default: ./codegraph.json then ./build/codegraph.json).")
    .option("-f, --file <path>", "Read the query from <path>. Use '-' for stdin.")
    .option("--params <expr>", "JSON object, key=value list, or @file with parameters for $name references.")
    .option("--format <fmt>", `Output format: ${ALL_CLI_FORMATS.join(" | ")}. Default: table on TTY, json otherwise.`)
    .option("--explain", "Print the chosen plan instead of executing.", false)
    .option("--max-path-length <n>", "Cap on `*` traversal length. Default 16.")
    .option("--pr <ref>", "Run `codegraph diff <ref>...HEAD` first; changedInPR() returns the touched node ids.")
    .option("--fail-empty", "Exit 1 when the result has zero rows.", false)
    .option("--highlight", "Hand the result to `codegraph serve` for in-canvas highlighting.", false)
    .action(async (expr: string | undefined, opts: QueryCliOptions, cmd: Command) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      try {
        const code = await runQueryCommand(expr, opts, global);
        exit(code);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stderr.write(`codegraph: ${message}\n`);
        exit(ExitCode.InternalError);
      }
    });
}

// =============================================================================
// Core orchestration
// =============================================================================

export async function runQueryCommand(
  expr: string | undefined,
  cli: QueryCliOptions,
  global: GlobalOptions,
): Promise<number> {
  // 1. Resolve the query source: inline > --file > stdin.
  let querySrc: string;
  try {
    querySrc = await resolveQuerySource(expr, cli);
  } catch (err) {
    stderr.write(`codegraph: ${(err as Error).message}\n`);
    return ExitCode.UserError;
  }
  if (!querySrc.trim()) {
    stderr.write("codegraph: no query provided (pass an inline arg, --file, or pipe via stdin)\n");
    return ExitCode.UserError;
  }

  // 2. Resolve the IR path and load it.
  const irPath = resolveIRPath(cli.ir);
  if (!irPath) {
    stderr.write(
      "codegraph: no IR found. Pass --ir <file> or run `codegraph index` first.\n",
    );
    return ExitCode.UserError;
  }
  let ir;
  try {
    ir = await loadIR(irPath);
  } catch (err) {
    stderr.write(`codegraph: failed to load IR at "${irPath}": ${(err as Error).message}\n`);
    return ExitCode.IrValidationFailed;
  }

  // 3. Parse --params.
  let params: Record<string, string | number | boolean | null> | undefined;
  if (cli.params) {
    try {
      params = parseParamsArg(cli.params, (p) => readFileSync(resolvePath(p), "utf8"));
    } catch (err) {
      stderr.write(`codegraph: bad --params: ${(err as Error).message}\n`);
      return ExitCode.UserError;
    }
  }

  // 4. Resolve --max-path-length.
  let maxPathLength: number | undefined;
  if (cli.maxPathLength) {
    const n = Number.parseInt(cli.maxPathLength, 10);
    if (!Number.isFinite(n) || n < 1) {
      stderr.write(`codegraph: --max-path-length must be a positive integer\n`);
      return ExitCode.UserError;
    }
    maxPathLength = n;
  }

  // 5. Resolve --pr changes (best-effort; if diff machinery is absent we skip
  //    silently so query still runs against the loaded IR).
  let prChanges: Set<string> | undefined;
  if (cli.pr) {
    try {
      prChanges = await collectPRChanges(cli.pr, irPath);
    } catch (err) {
      stderr.write(`codegraph: --pr resolution failed: ${(err as Error).message}\n`);
      return ExitCode.UserError;
    }
  }

  // 6. Resolve --format.
  const isTTY = (stdout as unknown as { isTTY?: boolean }).isTTY ?? false;
  const format = (cli.format ?? defaultFormatFor(isTTY)) as CliFormat;
  if (!ALL_CLI_FORMATS.includes(format)) {
    stderr.write(`codegraph: invalid --format "${format}"; expected one of ${ALL_CLI_FORMATS.join(", ")}\n`);
    return ExitCode.UserError;
  }

  // 7. Run.
  const runOpts: Parameters<typeof runQuery>[2] = {};
  if (params) runOpts.params = params;
  if (typeof maxPathLength === "number") runOpts.maxPathLength = maxPathLength;
  if (prChanges) runOpts.prChanges = prChanges as never;
  if (cli.explain) runOpts.explain = true;
  const result = await runQuery(ir, querySrc, runOpts);

  // 8. Format and write.
  const store = { nodes: new Map(ir.nodes.map((n) => [n.id, n])), edges: ir.edges };
  const out = formatResult(result, format, store, { quiet: global.quiet === true });
  stdout.write(out.endsWith("\n") ? out : out + "\n");

  // 9. Exit-code policy.
  for (const d of result.diagnostics) {
    if (d.severity === "error") {
      if (d.source === "parser") return ExitCode.ParseError;
      if (d.source === "runtime") return ExitCode.RuntimeError;
      return ExitCode.IndexerError;
    }
  }
  if (cli.failEmpty && result.rows.length === 0) return ExitCode.UserError;
  return ExitCode.Success;
}

// =============================================================================
// Helpers
// =============================================================================

async function resolveQuerySource(
  expr: string | undefined,
  cli: QueryCliOptions,
): Promise<string> {
  if (cli.file) {
    if (cli.file === "-") return readStdin();
    return readFileSync(resolvePath(cli.file), "utf8");
  }
  if (typeof expr === "string" && expr.length > 0) return expr;
  // Default to stdin if no inline arg provided and stdin is piped.
  const isTTY = (stdin as unknown as { isTTY?: boolean }).isTTY ?? false;
  if (!isTTY) return readStdin();
  return "";
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stdin.on("data", (c) => chunks.push(c as Buffer));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stdin.on("error", reject);
  });
}

function resolveIRPath(explicit?: string): string | undefined {
  if (explicit) {
    if (existsSync(explicit)) return resolvePath(explicit);
    return undefined;
  }
  const candidates = ["./codegraph.json", "./build/codegraph.json"];
  for (const c of candidates) if (existsSync(c)) return resolvePath(c);
  return undefined;
}

async function collectPRChanges(_pr: string, _irPath: string): Promise<Set<string>> {
  // Wired by the Action via env var CODEGRAPH_PR_CHANGES (one id per line)
  // when available; locally `--pr` would call `codegraph diff` to produce
  // it. v0.1: honor the env var if set, otherwise return empty.
  const envSet = process.env.CODEGRAPH_PR_CHANGES;
  if (!envSet) return new Set();
  return new Set(envSet.split(/\s+/).filter(Boolean));
}
