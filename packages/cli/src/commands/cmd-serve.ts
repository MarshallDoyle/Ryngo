/**
 * `codegraph serve [ir.json]` — boot a tiny static server that mounts the
 * bundled React Flow viewer and exposes the user's IR document at /ir.json.
 *
 * Design notes:
 *
 * - **Hono + @hono/node-server.** Hono is ~3 KB gzipped, has no runtime deps
 *   beyond a Web-standards Response/Request shim, and lets us keep the same
 *   handler if we ever swap to Bun/Deno/Workers for `serve --remote`. We
 *   bind it to Node's HTTP server via `@hono/node-server`'s `serve()`.
 *
 * - **Viewer is a static SPA.** No SSR, no API routes — the viewer fetches
 *   `/ir.json` on mount. So this server has exactly two responsibilities:
 *     1. serve files under `<viewer>/dist/` with the right Content-Type, and
 *     2. serve the IR JSON at `/ir.json`, kept in sync if `--watch` is on.
 *
 * - **--watch is a re-emit loop, not a hot module reload.** When source
 *   files change we re-index the cwd, write `ir.json` to the served dir,
 *   and rely on the viewer reloading on user action (or its own poll, in a
 *   later iteration). We deliberately do not push a websocket — keeping
 *   the server zero-protocol means the published bundle stays cacheable
 *   and there's no JS in the viewer that only works under `serve`.
 *
 * - **No-LLM, no telemetry, no network.** The server binds to 127.0.0.1
 *   by default and never reaches out — same constraint that applies to
 *   the indexer.
 */

import type { Command } from "commander";
import { stderr, stdout, exit, cwd } from "node:process";
import { resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import {
  fileResponse,
  isWatchableSourcePath,
  openInBrowser,
  resolveIrFile,
  resolveStaticPath,
  resolveViewerDist,
  viewerDistMissingMessage,
  writeIrToServedRoot,
} from "./serve-helpers.js";

// ---------------------------------------------------------------------------
// Public exit-code shape (mirrors ExitCode in src/index.ts; we duplicate the
// two values we need rather than importing to keep this file decoupled from
// the parser layer — useful for the unit tests that drive runServe directly).
// ---------------------------------------------------------------------------

const EXIT_USER_ERROR = 1;
const EXIT_SERVER_ERROR = 7;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ServeOptions {
  /** Path to an IR JSON file. When omitted, --watch is required. */
  ir?: string;
  /** Bind port. Default 4115 (matches packages/cli/README.md). */
  port: number;
  /** Bind host. Default 127.0.0.1. */
  host: string;
  /** When true (default), pop a browser tab on startup. Mapped from --no-open. */
  open: boolean;
  /** When true, re-emit the IR when source files change under cwd. */
  watch: boolean;
  /** Project root to index when --watch fires. Defaults to process.cwd(). */
  projectRoot?: string;
}

/**
 * Adapter for Commander's `.action()` callback. Commander passes options
 * with `--no-open` mapped to `opts.open === false`, and `--port` as a
 * string we coerce here so the public `ServeOptions` is strongly typed.
 */
export async function serveAction(
  ir: string | undefined,
  opts: { port?: string | number; host?: string; open?: boolean; watch?: boolean },
  _cmd: Command,
): Promise<void> {
  const port = typeof opts.port === "string" ? Number.parseInt(opts.port, 10) : opts.port ?? 4115;
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    stderr.write(`codegraph serve: --port must be an integer in 0..65535, got "${opts.port}".\n`);
    exit(EXIT_USER_ERROR);
    return;
  }
  await runServe({
    ir,
    port,
    host: opts.host ?? "127.0.0.1",
    // Commander's --no-open inverts to `open: false`; default true.
    open: opts.open !== false,
    watch: opts.watch === true,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point that does the work. Exported so tests and the future
 * programmatic API (`codegraph.serve()`) can call it without going
 * through commander.
 *
 * Returns when the server has bound and (optionally) the browser was
 * launched. The server keeps the event loop alive until the process is
 * signalled.
 */
export async function runServe(options: ServeOptions): Promise<void> {
  // ---- 1. Resolve viewer dist ---------------------------------------------
  const dist = resolveViewerDist();
  if (dist.kind === "missing") {
    stderr.write(viewerDistMissingMessage(dist) + "\n");
    exit(EXIT_USER_ERROR);
    return;
  }

  // ---- 2. Stage a writable served directory -------------------------------
  // The viewer's dist/ is read-only on disk (it lives under node_modules in
  // a real install). We need to drop ir.json *next to* its assets so the
  // viewer can `fetch('/ir.json')` without CORS. Two strategies:
  //
  //   a) overlay: serve ir.json from a temp dir, fall through to dist for
  //      everything else. Zero copies, but two roots to manage.
  //   b) copy dist/ to a temp dir and write ir.json there. Simpler, but
  //      O(N) copy per `serve` invocation.
  //
  // We pick (a). The static handler tries the IR overlay first (which only
  // ever contains ir.json), then the viewer's dist.
  const overlayDir = mkdtempSync(join(tmpdir(), "codegraph-serve-"));

  // ---- 3. Materialise the IR ----------------------------------------------
  let irOutPath: string | undefined;
  if (options.ir) {
    try {
      const { bytes } = await resolveIrFile(options.ir);
      irOutPath = await writeIrToServedRoot(overlayDir, bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`codegraph serve: ${msg}\n`);
      exit(EXIT_USER_ERROR);
      return;
    }
  } else if (!options.watch) {
    // Spec says: if `[ir]` is omitted, we either index on the fly (--watch)
    // or refuse. The "index cwd on the fly" path will land when the indexer
    // is wired in via @codegraph/core; for now, require an explicit IR.
    stderr.write(
      "codegraph serve: no IR file given. Pass an IR path (e.g. `codegraph serve ir.json`)\n" +
        "or run `codegraph index . --out ir.json` first.\n",
    );
    exit(EXIT_USER_ERROR);
    return;
  }

  // ---- 4. Build the Hono app ---------------------------------------------
  // Imports are dynamic so users who don't run `serve` never pay the parse
  // cost for Hono / @hono/node-server, and so a missing optional dep
  // surfaces as a clear startup error rather than a top-of-file crash.
  let HonoCtor: typeof import("hono").Hono;
  let serveNode: typeof import("@hono/node-server").serve;
  try {
    ({ Hono: HonoCtor } = await import("hono"));
    ({ serve: serveNode } = await import("@hono/node-server"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(
      `codegraph serve: failed to load the HTTP server runtime (${msg}).\n` +
        "Install the CLI's dependencies (\`pnpm install\` at the workspace root).\n",
    );
    exit(EXIT_SERVER_ERROR);
    return;
  }

  const app = new HonoCtor();

  // Health probe — handy for tests and for `wait-on http://...` in scripts.
  app.get("/__codegraph/health", (c) => c.json({ ok: true, version: "serve/0.1" }));

  // Static handler: try overlay (ir.json), then the viewer's dist.
  // SPA fallback: any 404 that isn't a file extension we know about returns
  // index.html so the viewer's client router can take over.
  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // 1. Overlay (ir.json + future dynamic files).
    const overlayHit = resolveStaticPath(overlayDir, pathname);
    if (overlayHit) return fileResponse(overlayHit);

    // 2. Viewer dist.
    const viewerHit = resolveStaticPath(dist.distDir, pathname);
    if (viewerHit) return fileResponse(viewerHit);

    // 3. SPA fallback for routes the client owns.
    if (!hasFileExtension(pathname)) {
      const indexHit = resolveStaticPath(dist.distDir, "/index.html");
      if (indexHit) return fileResponse(indexHit);
    }

    return c.text("Not found", 404);
  });

  // ---- 5. Bind ------------------------------------------------------------
  // We wrap serveNode in a Promise so we can detect EADDRINUSE and report
  // it cleanly rather than letting the unhandled error escape with a stack.
  await new Promise<void>((resolveBind, rejectBind) => {
    try {
      const server = serveNode(
        {
          fetch: app.fetch,
          port: options.port,
          hostname: options.host,
        },
        () => resolveBind(),
      );
      // @hono/node-server returns the underlying http.Server; surface bind
      // errors via its 'error' event.
      const maybeServer = server as unknown as { on?: (ev: string, cb: (e: Error) => void) => void };
      if (typeof maybeServer.on === "function") {
        maybeServer.on("error", (err: Error) => rejectBind(err));
      }
    } catch (err) {
      rejectBind(err instanceof Error ? err : new Error(String(err)));
    }
  }).catch((err: Error) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      stderr.write(
        `codegraph serve: port ${options.port} is already in use. Pass --port <n> to bind a different port.\n`,
      );
    } else {
      stderr.write(`codegraph serve: failed to bind: ${err.message}\n`);
    }
    exit(EXIT_SERVER_ERROR);
  });

  const url = formatUrl(options.host, options.port);
  stdout.write(`codegraph viewer ready at ${url}\n`);
  if (irOutPath) {
    stderr.write(`  IR:     ${irOutPath}\n`);
  }
  stderr.write(`  viewer: ${dist.distDir}\n`);

  // ---- 6. Auto-open the browser ------------------------------------------
  if (options.open) {
    const opened = await openInBrowser(url);
    if (!opened) {
      stderr.write("  (browser auto-open skipped — open the URL above manually)\n");
    }
  }

  // ---- 7. Watch mode ------------------------------------------------------
  if (options.watch) {
    await startWatcher({
      projectRoot: resolvePath(options.projectRoot ?? cwd()),
      overlayDir,
      irSourcePath: options.ir,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers (small enough to live here; anything reused by other commands
// belongs in serve-helpers.ts).
// ---------------------------------------------------------------------------

function hasFileExtension(pathname: string): boolean {
  const last = pathname.split("/").pop() ?? "";
  return /\.[a-zA-Z0-9]{1,8}$/.test(last);
}

function formatUrl(host: string, port: number): string {
  // Pretty-print the URL the user copies into their browser. We swap
  // 0.0.0.0 (which is bind-all and not a destination) for localhost.
  const display = host === "0.0.0.0" ? "localhost" : host;
  // IPv6 literal needs square brackets in URLs.
  const isV6 = display.includes(":") && !/^\[.*\]$/.test(display);
  const wrapped = isV6 ? `[${display}]` : display;
  return `http://${wrapped}:${port}`;
}

interface WatcherOptions {
  projectRoot: string;
  overlayDir: string;
  irSourcePath: string | undefined;
}

/**
 * Re-emit the IR when source files under `projectRoot` change.
 *
 * The actual re-index step is a TODO marker until the indexer is wired
 * in: today, when the user passes `--watch` together with an explicit IR
 * path, we just re-copy that file (so editing the IR by hand and saving
 * also picks up). When the indexer lands, this is the seam where we will
 * call `runIndexer({ root: projectRoot })` and write its result.
 *
 * We use Node's built-in `fs.watch` rather than chokidar to keep the CLI
 * dependency-light. This means recursive watching is best-effort on
 * Linux (watch fires on the first segment of large trees but not deeply);
 * the simplify path is to require chokidar later if real users hit that.
 */
async function startWatcher(opts: WatcherOptions): Promise<void> {
  const { watch } = await import("node:fs/promises");

  // Debounce — editors save in bursts (rename .swp, write, chmod, etc.).
  let pending: NodeJS.Timeout | undefined;
  const irOutPath = join(opts.overlayDir, "ir.json");

  const reEmit = async () => {
    try {
      if (opts.irSourcePath) {
        // Static IR file: re-read and re-publish.
        const { bytes } = await resolveIrFile(opts.irSourcePath);
        await writeIrToServedRoot(opts.overlayDir, bytes);
        stderr.write(`codegraph serve: IR refreshed from ${opts.irSourcePath}\n`);
      } else {
        // No source IR + --watch = "index on the fly". Indexer not yet
        // wired in; emit a clear breadcrumb instead of silently no-op'ing.
        stderr.write(
          "codegraph serve: --watch without an IR path requires the indexer (not yet wired). " +
            "Pass `codegraph serve ir.json --watch` for now.\n",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`codegraph serve: re-emit failed: ${msg}\n`);
    }
  };

  stderr.write(`  watch:  ${opts.projectRoot}\n`);

  // fs.watch (promise form) returns an AsyncIterable of change events.
  // Wrap in an immediately-invoked async function so we don't block the
  // caller waiting for the first event.
  void (async () => {
    try {
      const watcher = watch(opts.projectRoot, { recursive: true });
      for await (const evt of watcher) {
        if (!evt.filename) continue;
        const abs = resolvePath(opts.projectRoot, evt.filename);
        if (!isWatchableSourcePath(abs, opts.projectRoot, irOutPath)) continue;

        if (pending) clearTimeout(pending);
        pending = setTimeout(reEmit, 150);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`codegraph serve: watcher stopped: ${msg}\n`);
    }
  })();
}
