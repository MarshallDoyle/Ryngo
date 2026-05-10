#!/usr/bin/env node
/**
 * codegraph — deterministic, no-LLM static-analysis CLI.
 *
 * Commander was chosen as the parser:
 *   - Mature (10y+), stable API, ~60 KB install, zero runtime deps.
 *   - First-class subcommand + sub-subcommand support (needed for `adapter list|add|remove`).
 *   - Built-in `--help` / `--version` and typed option metadata that survives `tsc --strict`.
 *   - Smaller and more predictable than oclif (multi-package framework, overkill for a single binary)
 *     and better TS ergonomics than yargs for nested commands.
 *
 * Exit codes are centralised in `ExitCode` below and mirrored in README.md.
 * Commands are intentionally stubs: real work lives in `@codegraph/core` and is wired in later.
 */

import { Command, Option } from "commander";
import { stderr, stdout, env, exit, argv } from "node:process";

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * CLI version. In a release build this is replaced at bundle time by the value
 * in package.json; the literal here is a fallback for `tsx`/dev runs.
 */
const CLI_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/**
 * Stable exit-code contract. Anything that consumes the CLI in CI (notably the
 * GitHub Action in `packages/action`) MUST treat these as a public API.
 */
export const ExitCode = {
  /** Successful run. */
  Success: 0,
  /** User error: bad flags, missing args, unknown command, missing file. */
  UserError: 1,
  /** Indexer / adapter crashed while building IR. */
  IndexerError: 2,
  /** IR failed schema or invariant validation. */
  IrValidationFailed: 3,
  /** Diff produced changes (only emitted in `--exit-on-change` mode). */
  DiffChanged: 4,
  /** Config file (`.codegraph.yml`) is missing or unparsable. */
  ConfigError: 5,
  /** Cache directory unreadable / unwritable. */
  CacheError: 6,
  /** Local viewer server failed to bind / shut down uncleanly. */
  ServerError: 7,
  /** Unexpected/internal error — last resort. */
  InternalError: 99,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

/**
 * stdout / stderr split. Honoured everywhere — including `--json` mode, which
 * guarantees stdout is a single JSON document and stderr carries any diagnostics.
 *
 *   stdout : machine-readable payload   (IR JSON, diff JSON, export text, --json envelopes)
 *   stderr : human-readable diagnostics  (progress, warnings, errors, --verbose traces)
 *
 * `NO_COLOR` (and `--no-color`) disables ANSI on both streams.
 */
interface GlobalOptions {
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
  color?: boolean;
}

/** Resolve effective env defaults once, so `--config` etc. can override. */
function resolveEnv() {
  return {
    config: env.CODEGRAPH_CONFIG,
    cacheDir: env.CODEGRAPH_CACHE,
    noColor: env.NO_COLOR !== undefined && env.NO_COLOR !== "",
  };
}

/** Print a stub "not yet implemented" notice to stderr and exit 0 in stub mode. */
function stub(commandName: string, opts: Record<string, unknown>): never {
  const payload = {
    command: commandName,
    status: "stub",
    message: `\`codegraph ${commandName}\` is not implemented in this build.`,
    options: opts,
  };
  // In --json mode the parent program copies the envelope to stdout; otherwise
  // a one-liner goes to stderr. Both keep stdout clean for downstream tools.
  const json = (opts.json ?? false) === true;
  if (json) {
    stdout.write(JSON.stringify(payload) + "\n");
  } else {
    stderr.write(`codegraph: ${payload.message}\n`);
  }
  return exit(ExitCode.Success) as never;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

/**
 * Build the root program. Exported so tests can construct it without invoking
 * `process.exit`.
 */
export function buildProgram(): Command {
  const envDefaults = resolveEnv();

  const program = new Command();

  program
    .name("codegraph")
    .description(
      "Deterministic static-analysis tool: compile a codebase to a typed graph IR, view it, diff it, export it.",
    )
    .version(CLI_VERSION, "-V, --version", "Print the codegraph CLI version and exit.")
    .helpOption("-h, --help", "Show help for a command.")
    .option(
      "-c, --config <path>",
      "Path to .codegraph.yml (overrides $CODEGRAPH_CONFIG).",
      envDefaults.config,
    )
    .option("-v, --verbose", "Verbose diagnostics on stderr.", false)
    .option("-q, --quiet", "Suppress non-error stderr output.", false)
    .option("--json", "Machine-readable JSON output on stdout.", false)
    .option("--no-color", "Disable ANSI color (also: $NO_COLOR).")
    .showHelpAfterError("(run `codegraph --help` for usage)")
    .configureOutput({
      writeOut: (s) => stdout.write(s),
      writeErr: (s) => stderr.write(s),
    })
    .exitOverride((err) => {
      // Translate commander parse errors to our exit-code contract.
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        exit(ExitCode.Success);
      }
      exit(ExitCode.UserError);
    });

  // -------------------------------------------------------------------------
  // codegraph index [path]
  // -------------------------------------------------------------------------
  program
    .command("index")
    .description("Build the typed graph IR for a repository.")
    .argument("[path]", "Repository root to index (defaults to cwd).", ".")
    .option("-o, --out <file>", "Write IR JSON to <file> (default: stdout).")
    .option(
      "--cache-dir <dir>",
      "Cache directory for incremental indexing (overrides $CODEGRAPH_CACHE).",
      envDefaults.cacheDir,
    )
    .option(
      "-a, --adapters <list>",
      "Comma-separated adapter ids to run (default: auto-detect from config).",
    )
    .option(
      "--since <git-rev>",
      "Incremental: only re-index files changed since <git-rev>; merge with cached IR.",
    )
    .addOption(
      new Option("--fail-on <level>", "Exit non-zero when diagnostics reach <level>.")
        .choices(["error", "warning", "info"])
        .default("error"),
    )
    .action((path: string, opts: Record<string, unknown>, cmd: Command) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      stub("index", { path, ...opts, ...global });
    });

  // -------------------------------------------------------------------------
  // codegraph diff <baseRef> <headRef>
  // -------------------------------------------------------------------------
  program
    .command("diff")
    .description(
      "Diff two IRs. Arguments may be IR JSON files OR git revisions; in the latter case codegraph builds an IR for each ref.",
    )
    .argument("<baseRef>", "Base IR file or git revision.")
    .argument("<headRef>", "Head IR file or git revision.")
    .option(
      "-f, --format <fmt>",
      "Output format: json | summary | mermaid | markdown.",
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
      "Restrict diff to a subgraph (e.g. `pkg:web`, `path:src/server/**`).",
    )
    .action(
      (
        baseRef: string,
        headRef: string,
        opts: Record<string, unknown>,
        cmd: Command,
      ) => {
        const global = cmd.optsWithGlobals<GlobalOptions>();
        stub("diff", { baseRef, headRef, ...opts, ...global });
      },
    );

  // -------------------------------------------------------------------------
  // codegraph serve [ir.json]
  // -------------------------------------------------------------------------
  program
    .command("serve")
    .description(
      "Start the local React Flow viewer, bundling the IR. If [ir.json] is omitted, indexes the cwd first.",
    )
    .argument("[ir]", "Path to an IR JSON file (default: index cwd on the fly).")
    .option("-p, --port <n>", "Port to bind (default: 4115).", "4115")
    .option("--host <h>", "Host to bind (default: 127.0.0.1).", "127.0.0.1")
    .option("--no-open", "Do not auto-open the browser.")
    .option("--watch", "Re-index on filesystem changes.", false)
    .action((ir: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      stub("serve", { ir, ...opts, ...global });
    });

  // -------------------------------------------------------------------------
  // codegraph export <format> [ir.json]
  // -------------------------------------------------------------------------
  program
    .command("export")
    .description("Render an IR to Mermaid, D2, or Graphviz DOT.")
    .addArgument(
      new (require("commander").Argument)(
        "<format>",
        "Target format.",
      ).choices(["mermaid", "d2", "dot", "graphviz"]),
    )
    .argument("[ir]", "Path to an IR JSON file (default: stdin).")
    .option("-o, --out <file>", "Write output to <file> (default: stdout).")
    .option(
      "--include <selector>",
      "Subgraph selector to include (repeatable).",
      collect,
      [] as string[],
    )
    .option(
      "--exclude <selector>",
      "Subgraph selector to exclude (repeatable).",
      collect,
      [] as string[],
    )
    .option(
      "--depth <n>",
      "Max edge-traversal depth from each seed node.",
      parsePositiveInt,
    )
    .option("--collapse <kind>", "Collapse nodes of the given kind into one (repeatable).", collect, [] as string[])
    .action(
      (
        format: string,
        ir: string | undefined,
        opts: Record<string, unknown>,
        cmd: Command,
      ) => {
        const global = cmd.optsWithGlobals<GlobalOptions>();
        stub("export", { format, ir, ...opts, ...global });
      },
    );

  // -------------------------------------------------------------------------
  // codegraph init
  // -------------------------------------------------------------------------
  program
    .command("init")
    .description("Write a starter `.codegraph.yml` in the current directory.")
    .option("-f, --force", "Overwrite an existing config file.", false)
    .option(
      "--template <name>",
      "Template: minimal | typescript | python | polyglot.",
      "minimal",
    )
    .action((opts: Record<string, unknown>, cmd: Command) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      stub("init", { ...opts, ...global });
    });

  // -------------------------------------------------------------------------
  // codegraph adapter list|add|remove
  // -------------------------------------------------------------------------
  const adapter = program
    .command("adapter")
    .description("Manage language/runtime adapters.");

  adapter
    .command("list")
    .description("List installed adapters and their versions.")
    .action((opts: Record<string, unknown>, cmd: Command) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      stub("adapter list", { ...opts, ...global });
    });

  adapter
    .command("add")
    .description("Install an adapter by id (e.g. `@codegraph/adapter-typescript`).")
    .argument("<id>", "Adapter package id.")
    .option("--version <range>", "npm version range (default: latest).")
    .action((id: string, opts: Record<string, unknown>, cmd: Command) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      stub("adapter add", { id, ...opts, ...global });
    });

  adapter
    .command("remove")
    .description("Uninstall an adapter by id.")
    .argument("<id>", "Adapter package id.")
    .action((id: string, opts: Record<string, unknown>, cmd: Command) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      stub("adapter remove", { id, ...opts, ...global });
    });

  return program;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Commander accumulator for repeatable string flags. */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Commander coercion for `--depth <n>` etc. */
function parsePositiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new (require("commander").InvalidArgumentError)(
      `Expected a non-negative integer, got "${value}".`,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/* istanbul ignore next */
async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`codegraph: ${message}\n`);
    exit(ExitCode.InternalError);
  }
}

// Only run when invoked as a binary (not when imported by tests).
const invokedAsBin =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (require as any).main === module;

if (invokedAsBin) {
  void main();
}
