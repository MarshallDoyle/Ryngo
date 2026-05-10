/**
 * Minimal, dependency-free parser for `.env*` files.
 *
 * We deliberately do NOT depend on the `dotenv` npm package: the adapter
 * runs inside the host's worker sandbox and pulling in a runtime parser
 * would conflict with the no-network, deterministic guarantees we make at
 * the host level. The grammar we care about is tiny:
 *
 *   - Lines beginning with `#` (after optional whitespace) are comments.
 *   - Blank lines are ignored.
 *   - `KEY=VALUE` where VALUE may be unquoted, single-quoted, or
 *     double-quoted. Inside double quotes, `\n`, `\r`, `\t`, `\"`, `\\` are
 *     interpreted as escape sequences (per dotenv's expand spec).
 *   - Single quotes are literal — no escapes, no interpolation.
 *   - `export KEY=VALUE` is accepted (some `.env` files use it).
 *   - `${OTHER_VAR}` substitution is performed against keys already parsed
 *     in this same file (left-to-right). We do NOT cross-file expand —
 *     dotenv-flow's chain-of-files semantics is out of scope; recording the
 *     literal text is enough for codegraph's purposes.
 *
 * Anything we can't parse cleanly is silently skipped — this is a
 * static-analysis tool, not a runtime loader, and a malformed `.env` file
 * shouldn't poison the IR. We do not surface diagnostics from here; the
 * caller (in src/index.ts) decides whether to record one.
 */

import type { DotenvEntry } from "./types.js";

/**
 * Map a `.env*` filename to its logical environment slot. Convention follows
 * dotenv / dotenv-flow / Next.js / Create-React-App.
 *
 * `.env`            → "default"
 * `.env.local`      → "local"
 * `.env.production` → "production"
 * `.env.example`    → "example"
 *
 * Unknown suffixes pass through as-is so adapters layered on top (e.g. an
 * IaC environment-mapping adapter) can still match by string.
 */
export function environmentFromFilename(path: string): string {
  // Take only the basename — `apps/web/.env.production` → `.env.production`.
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = idx >= 0 ? path.slice(idx + 1) : path;

  // `.env` exactly.
  if (base === ".env") return "default";
  // `.env.<suffix>`.
  if (base.startsWith(".env.")) return base.slice(".env.".length);
  // `<prefix>.env` — rare but we don't want to crash on it.
  if (base.endsWith(".env")) return "default";
  return "default";
}

/**
 * Parse the raw text of one `.env*` file into a flat list of entries. Order
 * is preserved (reading order); duplicate keys produce multiple entries —
 * the caller decides how to handle them (codegraph keeps both, since one
 * declaration per file is the case that matters).
 *
 * `path` is repo-relative and stamped on every entry as provenance.
 */
export function parseDotenv(path: string, content: string): DotenvEntry[] {
  const entries: DotenvEntry[] = [];
  // Track keys we've parsed so far in THIS file for `${VAR}` expansion.
  // We don't expand against process.env or against other .env files — that
  // would make analysis non-deterministic.
  const localScope = new Map<string, string>();

  const lines = content.split(/\r?\n/);
  const environment = environmentFromFilename(path);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Strip leading whitespace; bail on blank lines and comments.
    const stripped = stripLeadingWs(raw);
    if (stripped === "" || stripped.startsWith("#")) continue;

    const parsed = parseLine(stripped);
    if (!parsed) continue;

    const expanded = parsed.value === undefined ? undefined : expand(parsed.value, localScope);
    if (expanded !== undefined) {
      localScope.set(parsed.name, expanded);
    }

    entries.push({
      name: parsed.name,
      value: expanded,
      file: path,
      environment,
      line: i + 1,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ParsedLine {
  readonly name: string;
  /** undefined when the line is `KEY=` with nothing on the right. */
  readonly value: string | undefined;
}

/**
 * Parse one stripped, non-comment, non-blank line.
 *
 * Grammar (informal):
 *   line       := "export "? KEY "=" VALUE? COMMENT?
 *   KEY        := [A-Za-z_][A-Za-z0-9_]*
 *   VALUE      := DQ_STRING | SQ_STRING | UNQUOTED
 *   DQ_STRING  := '"' ... '"'  (with \n \r \t \" \\ escapes)
 *   SQ_STRING  := "'" ... "'"  (literal — no escapes)
 *   UNQUOTED   := chars up to the first `#` or end-of-line, trimmed
 *
 * Returns null on a malformed line; null lines are silently skipped.
 */
function parseLine(line: string): ParsedLine | null {
  let i = 0;

  // Optional `export ` prefix.
  if (line.startsWith("export ")) i = "export ".length;

  // KEY.
  const keyStart = i;
  if (!isKeyStart(line.charCodeAt(i))) return null;
  i++;
  while (i < line.length && isKeyCont(line.charCodeAt(i))) i++;
  const name = line.slice(keyStart, i);

  // Optional whitespace, then `=`.
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  if (line[i] !== "=") return null;
  i++;

  // Optional whitespace before value.
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;

  // No value: `KEY=` (or `KEY= # trailing comment`).
  if (i >= line.length || isInlineComment(line, i)) {
    return { name, value: undefined };
  }

  const ch = line[i];
  if (ch === '"') {
    const v = readDoubleQuoted(line, i);
    return v ? { name, value: v.value } : null;
  }
  if (ch === "'") {
    const v = readSingleQuoted(line, i);
    return v ? { name, value: v.value } : null;
  }
  // Unquoted: read until first `#` (with at least one space before it, per
  // dotenv's standard) or end of line, then rtrim.
  const v = readUnquoted(line, i);
  return { name, value: v };
}

function readDoubleQuoted(line: string, start: number): { value: string; end: number } | null {
  // Caller has confirmed line[start] === '"'.
  let out = "";
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      const next = line[i + 1];
      if (next === undefined) return null; // Trailing backslash at EOL.
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        default:
          // Unknown escape: keep both chars literal. Matches dotenv's lenient
          // behavior and avoids dropping data.
          out += "\\" + next;
      }
      i += 2;
      continue;
    }
    if (c === '"') {
      return { value: out, end: i + 1 };
    }
    out += c;
    i++;
  }
  // Unterminated string: skip the line.
  return null;
}

function readSingleQuoted(line: string, start: number): { value: string; end: number } | null {
  let i = start + 1;
  const valueStart = i;
  while (i < line.length) {
    if (line[i] === "'") {
      return { value: line.slice(valueStart, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

function readUnquoted(line: string, start: number): string {
  // Read to end of line, then strip a trailing ` # comment` segment if any
  // (dotenv requires whitespace before `#` to count as inline comment; bare
  // `#` inside the value is preserved — this matches the GNU dotenv spec).
  let i = start;
  while (i < line.length) {
    if (line[i] === "#" && (i === start || line[i - 1] === " " || line[i - 1] === "\t")) break;
    i++;
  }
  return line.slice(start, i).replace(/[ \t]+$/, "");
}

/**
 * `${VAR}` substitution against `scope` only. Unmatched names expand to "".
 * `\$` escapes the dollar sign. We do not support `$VAR` (no braces) — too
 * many false positives in URL-shaped values.
 */
function expand(value: string, scope: ReadonlyMap<string, string>): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (c === "\\" && value[i + 1] === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (c === "$" && value[i + 1] === "{") {
      const end = value.indexOf("}", i + 2);
      if (end === -1) {
        out += value.slice(i);
        break;
      }
      const ref = value.slice(i + 2, end);
      out += scope.get(ref) ?? "";
      i = end + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripLeadingWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i === 0 ? s : s.slice(i);
}

function isKeyStart(code: number): boolean {
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 // _
  );
}

function isKeyCont(code: number): boolean {
  return isKeyStart(code) || (code >= 48 && code <= 57); // digits
}

function isInlineComment(line: string, i: number): boolean {
  // After leading whitespace already stripped by caller before name; here we
  // accept `#...` immediately, since `KEY=` with no value can be followed by
  // a comment.
  return line[i] === "#";
}
