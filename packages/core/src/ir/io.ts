/**
 * IR file I/O.
 *
 *   - `loadIR`         — read JSON from disk, migrate, validate, return a
 *                        typed `IRDocument` (the `{schemaVersion, ir}` root).
 *   - `loadIRFromJSON` — same pipeline starting from an already-parsed value
 *                        (or a JSON string) — for callers that already have
 *                        the document in memory (e.g. `codegraph diff` after
 *                        running `codegraph index` in-process per worktree).
 *   - `saveIR`         — atomic write (tmp + rename) with a deterministic,
 *                        stable key order. The deterministic serialization
 *                        is load-bearing: the diff algorithm
 *                        (design/diff-algorithm.md §8) demands byte-identical
 *                        output for `(base, head, opts)`.
 *
 * On-disk shape follows `IRDocument`: `schemaVersion` lives at the document
 * root; `metadata`, `nodes`, `edges`, and `diagnostics` are nested under
 * `ir`. Callers that want only the graph drill into `.ir`.
 *
 * No fancy streaming — IRs are at most a few hundred MB in the absolute
 * worst case (5M nodes), and `JSON.parse`/`stringify` handle that fine on
 * Node 20.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { IRDocument } from './types.js';
import { migrateToCurrent, MigrationError, type MigrationRegistry } from './migrations.js';
import { validateIR } from './validate.js';

export interface LoadIROptions {
  /** Override the migration registry (tests). */
  registry?: MigrationRegistry;
}

export interface LoadIRFromJSONOptions extends LoadIROptions {
  /**
   * Label used in error messages when the input did not come from a file
   * (e.g. "stdin", a URL, a worktree name). Defaults to "<input>".
   */
  sourceLabel?: string;
}

/**
 * Structural shape of `ir-validator`'s `ValidationError`. Mirrored here so
 * `io.ts` doesn't take a hard import dependency on the validator's exported
 * type — the loader only needs to surface the errors to callers.
 */
export interface IRValidationIssue {
  /** JSON-pointer path to the offending field. */
  path: string;
  /** Human-readable message. */
  message: string;
}

export interface SaveIROptions {
  /**
   * Pretty-print indent. Defaults to 2 — matching the format the diff
   * fixtures and the action's artifact upload have committed to.
   */
  indent?: number;
  /**
   * fsync the temp file before rename, so a crash mid-write cannot leave a
   * truncated file behind. Defaults to true. Tests disable for speed.
   */
  fsync?: boolean;
}

/** Read, migrate, validate, return. */
export async function loadIR(
  filePath: string,
  opts: LoadIROptions = {},
): Promise<IRDocument> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new IRLoadError(`IR file not found: ${filePath}`, { cause: err });
    }
    throw new IRLoadError(
      `failed to read IR file at ${filePath}: ${describe(err)}`,
      { cause: err },
    );
  }
  return loadIRFromJSON(raw, { ...opts, sourceLabel: filePath });
}

/**
 * Migrate + validate an in-memory document. Accepts either:
 *   - a JSON string (will be parsed), or
 *   - an already-parsed value of any shape (typically `unknown`).
 *
 * Throws `IRLoadError` on parse, migration, or validation failure. Validation
 * failures populate `error.errors` with the structured `ValidationError[]`
 * from ir-validator so callers can map them to a domain-specific exit code.
 */
export function loadIRFromJSON(
  input: unknown,
  opts: LoadIRFromJSONOptions = {},
): IRDocument {
  const label = opts.sourceLabel ?? '<input>';

  let parsed: unknown;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (err) {
      throw new IRLoadError(
        `IR at ${label} is not valid JSON: ${describe(err)}`,
        { cause: err },
      );
    }
  } else {
    parsed = input;
  }

  let migrated: unknown;
  try {
    migrated = migrateToCurrent(parsed, opts.registry);
  } catch (err) {
    if (err instanceof MigrationError) {
      throw new IRLoadError(
        `failed to migrate IR at ${label}: ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }

  const result = validateIR(migrated);
  if (!result.ok) {
    const summary = result.errors
      .slice(0, 5)
      .map((e) => `  - ${e.path}: ${e.message}`)
      .join('\n');
    const more =
      result.errors.length > 5
        ? `\n  …and ${result.errors.length - 5} more`
        : '';
    throw new IRLoadError(
      `IR at ${label} failed validation:\n${summary}${more}`,
      { errors: result.errors },
    );
  }

  return result.ir;
}

/**
 * Write `ir` to `filePath` atomically. Steps:
 *   1. canonicalize keys recursively (deterministic ordering — §8 of the
 *      diff design)
 *   2. JSON.stringify with 2-space indent + trailing newline
 *   3. write to a sibling tmp file in the same directory (so rename is
 *      a same-filesystem syscall)
 *   4. fsync (unless disabled)
 *   5. rename onto the target
 *
 * If any step throws, the tmp file is best-effort cleaned up.
 */
export async function saveIR(
  filePath: string,
  doc: IRDocument,
  opts: SaveIROptions = {},
): Promise<void> {
  const indent = opts.indent ?? 2;
  const fsyncEnabled = opts.fsync ?? true;
  const json = serializeIR(doc, indent);

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  // Co-locate the tmp file so the rename is on the same FS. Include pid + a
  // monotonic counter to make concurrent saves to the same path safe.
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${nextTmpSeq()}.tmp`);

  await fs.mkdir(dir, { recursive: true });

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(tmpPath, 'w');
    await handle.writeFile(json, 'utf8');
    if (fsyncEnabled) {
      await handle.sync();
    }
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // best-effort
      }
    }
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort — tmp may not exist
    }
    throw new IRSaveError(
      `failed to save IR to ${filePath}: ${describe(err)}`,
      { cause: err },
    );
  }
}

/**
 * Serialize an IR document to a deterministic JSON string. Public so
 * callers (e.g. the diff snapshot harness) can produce the same bytes
 * without going through the filesystem.
 *
 * Key order is alphabetical at every level. Arrays are NOT reordered —
 * the producer is responsible for emitting nodes/edges in their
 * canonical order (the IR spec mandates sorted-by-id; saveIR doesn't
 * second-guess it).
 */
export function serializeIR(doc: IRDocument, indent = 2): string {
  return JSON.stringify(canonicalize(doc as unknown), null, indent) + '\n';
}

/**
 * Recursively rewrite an object so `JSON.stringify` emits keys in
 * lexicographic order. Arrays are preserved in input order. `undefined`
 * values are dropped (JSON.stringify drops them anyway, but doing it
 * here keeps the canonical form purely a function of the input).
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    out[k] = canonicalize(v);
  }
  return out;
}

let tmpSeq = 0;
function nextTmpSeq(): number {
  tmpSeq = (tmpSeq + 1) >>> 0;
  return tmpSeq;
}

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e;
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export class IRLoadError extends Error {
  /**
   * Populated when the failure was IR validation. Empty for I/O, parse, or
   * migration failures. Callers (e.g. the CLI) can branch on
   * `error.errors.length > 0` to distinguish validation from other failures
   * — useful for exit codes (e.g. ExitCode.IrValidationFailed).
   */
  readonly errors: readonly IRValidationIssue[];

  constructor(
    message: string,
    options?: { cause?: unknown; errors?: readonly IRValidationIssue[] },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'IRLoadError';
    this.errors = options?.errors ?? [];
  }
}

export class IRSaveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IRSaveError';
  }
}
