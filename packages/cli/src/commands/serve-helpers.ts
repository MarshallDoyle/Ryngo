/**
 * Helpers for `codegraph serve`.
 *
 * Kept separate from `cmd-serve.ts` so the command file reads as a thin
 * orchestration layer (resolve -> serve -> open) and the I/O fiddly bits
 * (path resolution, mime detection, atomic writes, glob filters) sit here
 * where they can be unit-tested in isolation.
 *
 * Nothing in this file performs network I/O on import — every side effect
 * is gated behind an exported function.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Viewer dist resolution
// ---------------------------------------------------------------------------

/**
 * Result of looking up the bundled viewer's static assets.
 *
 * `kind: "ok"` carries the absolute path to a directory that contains an
 * `index.html` plus hashed JS/CSS produced by `pnpm --filter @codegraph/viewer build`.
 * `kind: "missing"` means we located the package but its `dist/` is absent
 * (the user has not run the workspace build yet) — the CLI surfaces this
 * with an actionable message rather than serving an empty 404 farm.
 */
export type ViewerDistResult =
  | { kind: "ok"; distDir: string }
  | { kind: "missing"; expectedAt: string; reason: string };

/**
 * Locate `@codegraph/viewer`'s built `dist/` directory.
 *
 * Resolution order:
 *   1. `CODEGRAPH_VIEWER_DIST` env var — escape hatch for monorepo dev /
 *      vendored installs where the published path doesn't match.
 *   2. `require.resolve("@codegraph/viewer/package.json")` from this file.
 *      We resolve the package.json (not the package main) because the viewer
 *      intentionally has no programmatic entry — there is nothing to import,
 *      we just need the on-disk location.
 *   3. Walk up from the CLI source looking for the workspace sibling. This
 *      is the path used in `pnpm dev` / `tsx` runs before tsup has emitted
 *      anything to `dist/`, where `require.resolve` can fail under ESM.
 *
 * In every case, the returned path is the directory that should be served
 * as the static root.
 */
export function resolveViewerDist(): ViewerDistResult {
  const fromEnv = process.env.CODEGRAPH_VIEWER_DIST;
  if (fromEnv && fromEnv.length > 0) {
    const abs = resolve(fromEnv);
    if (isDirWithIndexHtml(abs)) return { kind: "ok", distDir: abs };
    return {
      kind: "missing",
      expectedAt: abs,
      reason: `CODEGRAPH_VIEWER_DIST="${fromEnv}" does not point at a built viewer directory.`,
    };
  }

  // require.resolve works in both CJS (when bundled to CJS) and ESM (via createRequire).
  const here = fileURLToPath(import.meta.url);
  const requireFromHere = createRequire(here);
  let pkgJsonPath: string | undefined;
  try {
    pkgJsonPath = requireFromHere.resolve("@codegraph/viewer/package.json");
  } catch {
    pkgJsonPath = undefined;
  }

  if (pkgJsonPath) {
    const distDir = join(dirname(pkgJsonPath), "dist");
    if (isDirWithIndexHtml(distDir)) return { kind: "ok", distDir };
    return {
      kind: "missing",
      expectedAt: distDir,
      reason: `Found @codegraph/viewer at ${dirname(pkgJsonPath)} but no built bundle at dist/index.html.`,
    };
  }

  // Workspace fallback: walk up from this source file looking for
  // `packages/viewer/dist/`. Lets `tsx src/index.ts` work without an install.
  const workspaceGuess = walkUpForViewerDist(here);
  if (workspaceGuess && isDirWithIndexHtml(workspaceGuess)) {
    return { kind: "ok", distDir: workspaceGuess };
  }

  return {
    kind: "missing",
    expectedAt: workspaceGuess ?? "<unresolved>",
    reason:
      "Could not resolve @codegraph/viewer. The CLI must be installed alongside the viewer package, or the workspace must be checked out and built.",
  };
}

function isDirWithIndexHtml(dir: string): boolean {
  try {
    if (!existsSync(dir)) return false;
    if (!statSync(dir).isDirectory()) return false;
    return existsSync(join(dir, "index.html"));
  } catch {
    return false;
  }
}

function walkUpForViewerDist(fromFile: string): string | undefined {
  let cur = dirname(fromFile);
  // Hard cap to avoid runaway loops on weird filesystems.
  for (let i = 0; i < 12; i++) {
    const candidate = join(cur, "packages", "viewer", "dist");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

/**
 * Human-readable error shown when the viewer bundle is missing. Lives here
 * so cmd-serve.ts stays declarative and we can snapshot-test the wording.
 *
 * The message intentionally avoids emoji (project rule) and points the user
 * at the *workspace* command, since this scenario only happens during local
 * dev / a partial install — the published CLI ships its own bundle.
 */
export function viewerDistMissingMessage(missing: Extract<ViewerDistResult, { kind: "missing" }>): string {
  const lines = [
    "codegraph serve: the bundled viewer was not found.",
    `  expected at: ${missing.expectedAt}`,
    `  reason:      ${missing.reason}`,
    "",
    "If you are running from a workspace checkout, build the viewer first:",
    "  pnpm --filter @codegraph/viewer build",
    "or, from the repo root:",
    "  pnpm build",
    "",
    "If you are running an installed @codegraph/cli, please reinstall — the",
    "published package always ships the viewer bundle alongside the CLI.",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// IR resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the user-supplied IR path to an absolute path, validating that the
 * file exists and is readable as JSON. We *don't* validate the IR schema here
 * — that is `@codegraph/core`'s job and would couple the CLI to the IR shape.
 * We just confirm the bytes are well-formed JSON so a typo doesn't surface as
 * a cryptic error inside the React app.
 */
export async function resolveIrFile(rawPath: string): Promise<{ absPath: string; bytes: Buffer }> {
  const abs = resolve(rawPath);
  if (!existsSync(abs)) {
    throw new Error(`IR file not found: ${rawPath} (resolved to ${abs}).`);
  }
  if (!statSync(abs).isFile()) {
    throw new Error(`IR path is not a file: ${abs}.`);
  }
  const bytes = await readFile(abs);
  try {
    JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`IR file is not valid JSON: ${abs} (${reason}).`);
  }
  return { absPath: abs, bytes };
}

/**
 * Atomically write the IR bytes to `<servedDir>/ir.json`.
 *
 * We use a temp + rename so a watcher firing mid-write never reads a
 * truncated file: the rename is atomic on POSIX and on NTFS.
 *
 * We deliberately copy rather than symlink because Node's static-file
 * handler will happily follow a symlink across filesystem boundaries on
 * Windows, but Hono's `serveStatic` uses fs.stat (not lstat) and a stale
 * symlink races against `--watch` re-emits on macOS APFS. Copying is dumb,
 * fast (IR JSON is small — single-digit MB even on huge repos), and
 * predictable across platforms.
 */
export async function writeIrToServedRoot(servedDir: string, bytes: Buffer): Promise<string> {
  await mkdir(servedDir, { recursive: true });
  const dest = join(servedDir, "ir.json");
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  // We use renameSync via fs/promises for the same atomicity guarantee.
  const { rename } = await import("node:fs/promises");
  await rename(tmp, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

/**
 * Minimal mime map for the file extensions the viewer emits. We don't pull
 * in `mime-db` because it's ~80 KB for ~10 extensions we actually use.
 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

export function mimeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a request URL path to a file inside `rootDir`, refusing any path
 * that escapes the root. This is the only sandbox between the public HTTP
 * surface and the developer's filesystem — get this wrong and `serve`
 * becomes a directory-traversal primitive.
 *
 *   GET /            -> rootDir/index.html
 *   GET /assets/x.js -> rootDir/assets/x.js
 *   GET /../etc/foo  -> null  (rejected)
 */
export function resolveStaticPath(rootDir: string, urlPath: string): string | null {
  // Strip query/fragment defensively; Hono normalizes but we double-check.
  const noQuery = urlPath.split("?")[0]?.split("#")[0] ?? "/";
  // Decode percent-encodings; reject if decoding fails.
  let decoded: string;
  try {
    decoded = decodeURIComponent(noQuery);
  } catch {
    return null;
  }
  // Map "/" to index.html — single-page-app fallback is handled separately.
  const requested = decoded === "/" || decoded === "" ? "/index.html" : decoded;

  const absRoot = resolve(rootDir);
  const joined = normalize(join(absRoot, requested));

  // Containment check: the resolved path must remain inside the root.
  // Using path.relative avoids prefix-string bugs (e.g. /tmp/foo vs /tmp/foobar).
  const rel = relative(absRoot, joined);
  if (rel.startsWith("..") || (rel !== "" && rel.startsWith(".."))) return null;
  // On Windows, an absolute path here would also escape; relative() would
  // return the original abs path with drive letter. Reject those too.
  if (rel.length > 0 && /^[a-zA-Z]:/.test(rel)) return null;

  if (!existsSync(joined)) return null;
  if (!statSync(joined).isFile()) return null;
  return joined;
}

/**
 * Open a read stream for a resolved file path. Wraps `createReadStream` so
 * tests can stub it without monkey-patching the `fs` module.
 */
export function openFileStream(absPath: string) {
  return createReadStream(absPath);
}

/**
 * Stream a file as a Web Response with the right Content-Type and length.
 * Hono on @hono/node-server accepts a Web ReadableStream as the body, which
 * `Readable.toWeb` produces from a Node stream.
 */
export async function fileResponse(absPath: string): Promise<Response> {
  const { Readable } = await import("node:stream");
  const stat = statSync(absPath);
  const stream = createReadStream(absPath);
  // Node's Readable -> Web ReadableStream bridge.
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream;
  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": mimeFor(absPath),
      "Content-Length": String(stat.size),
      // No-cache during local dev: the user expects --watch refreshes to
      // surface immediately, and the bundle is hashed anyway.
      "Cache-Control": "no-cache",
    },
  });
}

// ---------------------------------------------------------------------------
// Browser open
// ---------------------------------------------------------------------------

/**
 * Best-effort browser open. We dynamic-import `open` so the dependency
 * stays optional: on a headless CI runner where `open` isn't installed or
 * `xdg-open` is missing, we just log the URL instead of crashing.
 *
 * Returns `true` if we attempted to open, `false` if we deliberately
 * skipped (CI / NO_OPEN / SSH session detected).
 */
export async function openInBrowser(url: string): Promise<boolean> {
  if (shouldSkipAutoOpen()) return false;
  try {
    const mod = (await import("open")) as { default: (target: string) => Promise<unknown> };
    await mod.default(url);
    return true;
  } catch {
    // open is not installed, or failed to spawn — caller already logged the URL.
    return false;
  }
}

function shouldSkipAutoOpen(): boolean {
  // Common CI/headless signals. Any of these → don't try to launch a browser.
  if (process.env.CI && process.env.CI !== "false" && process.env.CI !== "0") return true;
  if (process.env.CODEGRAPH_NO_OPEN) return true;
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Watch glob
// ---------------------------------------------------------------------------

/**
 * Returns true if the given absolute path looks like a file we should
 * re-index on. The watcher fires for *every* fs event under the cwd; we
 * cheaply filter out the noise (node_modules, .git, dist, the IR file we
 * just wrote) so we don't enter a re-emit loop.
 */
export function isWatchableSourcePath(absPath: string, projectRoot: string, irOutPath: string): boolean {
  const norm = normalize(absPath);
  if (norm === normalize(irOutPath)) return false;

  const rel = relative(projectRoot, norm);
  if (rel.startsWith("..")) return false;

  const segments = rel.split(/[\\/]/);
  const ignoredDirs = new Set([
    "node_modules",
    ".git",
    ".turbo",
    ".next",
    ".cache",
    "dist",
    "build",
    ".codegraph",
    ".codegraph-cache",
  ]);
  if (segments.some((s) => ignoredDirs.has(s))) return false;

  // Only recognise extensions adapters care about today. Adding a new
  // language adapter will need a new entry here (or a config-driven list,
  // tracked under the same TODO as the runtime adapter discovery work).
  const ext = extname(norm).toLowerCase();
  const watched = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".rb",
    ".prisma",
    ".sql",
    ".graphql",
    ".yml",
    ".yaml",
    ".json",
  ]);
  return watched.has(ext);
}
