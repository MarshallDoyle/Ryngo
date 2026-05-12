/**
 * Python parser — Tier-0 backend (regex-based).
 *
 * Same shape as ts.js — emits params, returnType, and class members so the
 * typed-port viewer and LLM projections work uniformly.
 *
 * Type display strings come straight from PEP-484 annotations as written.
 * Untyped params get `typeDisplay: null`. Class members include methods and
 * declared fields (`name: Type = default`).
 */

import { detectWarnings } from "../warnings.js";

const BACKEND = "regex";

export function parse(text /*, opts */) {
  // Python imports don't carry string-literal arguments, so for imports we
  // can use either form. Defs/calls need the strings stripped so docstrings
  // and string literals don't false-positive class/def patterns.
  const stripped = stripCommentsAndStrings(text);
  const defs = extractDefs(stripped);
  populateWarnings(stripped, defs);
  return {
    lang: "py",
    backend: BACKEND,
    imports: extractImports(stripped),
    defs,
    calls: extractCalls(stripped),
  };
}

/**
 * Mutate `defs` in place: for every function def, slice its body
 * (this def's line up to the next def's line) and run heuristic
 * warning detection. Skips classes.
 */
function populateWarnings(src, defs) {
  if (!defs.length) return;
  const lines = src.split("\n");
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    if (def.kind !== "function") continue;
    const next = defs[i + 1];
    const startLine = def.line;
    const endLine = next ? next.line - 1 : lines.length;
    const body = lines.slice(startLine - 1, endLine).join("\n");
    const w = detectWarnings(body, def.params, def.name, "py");
    if (w.length) def.warnings = w;
  }
}

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

function extractImports(src) {
  const out = [];

  const importRe = /(?:^|[\n;])\s*import\s+([^\n#;]+)/g;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const items = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const item of items) {
      const parts = item.split(/\s+as\s+/);
      const spec = parts[0]?.trim();
      const alias = parts[1]?.trim();
      if (!spec) continue;
      const local = alias || spec.split(".")[0];
      out.push({
        spec,
        bindings: { [local]: spec },
        isRelative: false,
      });
    }
  }

  const fromRe =
    /(?:^|[\n;])\s*from\s+(\.+|\.+?\w[\w.]*|\w[\w.]*)\s+import\s+(?:\(([^)]+)\)|([^\n#;]+))/g;
  while ((m = fromRe.exec(src)) !== null) {
    const spec = m[1];
    const itemsStr = m[2] || m[3] || "";
    const items = itemsStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const bindings = {};
    for (const item of items) {
      if (item === "*") continue;
      const parts = item.split(/\s+as\s+/);
      const orig = parts[0]?.trim();
      const local = parts[1]?.trim() || orig;
      if (orig && local) bindings[local] = orig;
    }
    out.push({
      spec,
      bindings,
      isRelative: spec.startsWith("."),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// defs (functions + classes) with params, return type, members
// ---------------------------------------------------------------------------

/**
 * Walk top-level lines (column 0) extracting function and class headers.
 * For each, capture the full signature header (which may span multiple lines
 * for long type-hinted parameter lists).
 */
function extractDefs(src) {
  const lines = src.split("\n");
  const defs = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s/.test(line)) continue; // not column 0
    if (line.startsWith("@")) continue; // decorator

    if (/^(?:async\s+)?def\s+\w+\s*\(/.test(line)) {
      const { header, endLine } = readSignatureBlock(lines, i, "def");
      const m = header.match(
        /^(?:async\s+)?def\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:->\s*([\s\S]+?))?\s*:/,
      );
      if (m) {
        const name = m[1];
        if (!seen.has(name)) {
          defs.push({
            name,
            kind: "function",
            line: i + 1,
            params: parseParamList(m[2]),
            returnType: m[3] ? { display: m[3].trim() } : null,
          });
          seen.add(name);
        }
      }
      i = endLine;
      continue;
    }

    if (/^class\s+\w+/.test(line)) {
      const { header, endLine } = readSignatureBlock(lines, i, "class");
      const m = header.match(/^class\s+(\w+)\s*(?:\(([\s\S]*?)\))?\s*:/);
      if (m) {
        const name = m[1];
        if (!seen.has(name)) {
          const baseClasses = parseBaseClasses(m[2] || "");
          const body = readClassBody(lines, endLine + 1);
          defs.push({
            name,
            kind: "class",
            line: i + 1,
            members: extractClassMembers(body, endLine + 2),
            baseClasses,
          });
          seen.add(name);
        }
      }
      i = endLine;
      continue;
    }
  }

  return defs.sort((a, b) => a.line - b.line);
}

/**
 * Read a possibly-multiline `def` or `class` signature, terminated by a
 * top-level `:`. Returns the full header text (newlines collapsed to spaces)
 * plus the index of the last line consumed.
 */
function readSignatureBlock(lines, startIdx, kind) {
  let depth = 0;
  let header = "";
  for (let j = startIdx; j < lines.length; j++) {
    const ln = lines[j];
    header += (header ? " " : "") + ln.trim();
    for (const c of ln) {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
    }
    if (depth <= 0 && /:\s*(?:#.*)?$/.test(ln)) {
      return { header, endLine: j };
    }
    if (depth <= 0 && /:\s*\S/.test(ln) && j > startIdx) {
      return { header, endLine: j };
    }
  }
  return { header, endLine: lines.length - 1 };
}

// Exported so the tree-sitter Python extractor (Phase 5.1.2) can
// reuse the same parsing logic for parity with the regex extractor.
export function parseBaseClasses(s) {
  if (!s.trim()) return [];
  return splitTopLevel(s, ",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.replace(/=.*$/, "").trim()) // drop kw= metaclass=...
    .filter(Boolean);
}

/**
 * Slurp the indented block following a `class` header. Returns the joined
 * body text (preserving original line structure for member regex). We track
 * the indent of the first non-empty body line and stop when we hit a line at
 * column 0.
 */
function readClassBody(lines, startIdx) {
  if (startIdx >= lines.length) return "";
  let bodyIndent = -1;
  const bodyLines = [];
  for (let j = startIdx; j < lines.length; j++) {
    const ln = lines[j];
    if (!ln.trim()) {
      bodyLines.push(ln);
      continue;
    }
    const indent = ln.match(/^[ \t]*/)[0].length;
    if (bodyIndent < 0) bodyIndent = indent;
    if (indent < bodyIndent) break;
    bodyLines.push(ln);
  }
  return bodyLines.join("\n");
}

export function extractClassMembers(body, firstLine = 1) {
  const methods = [];
  const fields = [];
  const seenMethods = new Set();

  if (!body) return { methods, fields, baseClasses: [] };

  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("@")) continue;

    const defMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
    if (defMatch) {
      const { header, endLine } = readSignatureBlock(lines, i, "def");
      const sm = header.match(
        /^(?:async\s+)?def\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:->\s*([\s\S]+?))?\s*:/,
      );
      if (sm && !seenMethods.has(sm[1])) {
        seenMethods.add(sm[1]);
        methods.push({
          name: sm[1],
          params: parseParamList(sm[2]),
          returnType: sm[3] ? { display: sm[3].trim() } : null,
          line: firstLine + i,
        });
      }
      i = endLine;
      continue;
    }

    // Class field: `name: Type` or `name: Type = default`
    const fieldMatch = trimmed.match(
      /^(\w+)\s*:\s*([^=\n]+?)(?:=\s*(.+))?$/,
    );
    if (fieldMatch && !seenMethods.has(fieldMatch[1])) {
      fields.push({
        name: fieldMatch[1],
        typeDisplay: fieldMatch[2].trim() || null,
        default: fieldMatch[3]?.trim() || null,
        line: firstLine + i,
      });
    }
  }

  return { methods, fields, baseClasses: [] };
}

// ---------------------------------------------------------------------------
// param parsing — Python flavor
// ---------------------------------------------------------------------------

export function parseParamList(raw) {
  if (!raw || !raw.trim()) return [];
  const params = [];
  for (const chunk of splitTopLevel(raw, ",")) {
    const t = chunk.trim();
    if (!t) continue;
    if (t === "/" || t === "*") continue; // positional-only / keyword-only markers
    let rest = false;
    let body = t;
    if (body.startsWith("**")) {
      rest = "kwargs";
      body = body.slice(2).trim();
    } else if (body.startsWith("*")) {
      rest = "args";
      body = body.slice(1).trim();
    }
    const m = body.match(
      /^(\w+)\s*(?::\s*([\s\S]+?))?\s*(?:=\s*([\s\S]+))?$/,
    );
    if (!m) {
      params.push({ name: body, rest });
      continue;
    }
    params.push({
      name: m[1],
      typeDisplay: m[2]?.trim() || null,
      optional: m[3] != null,
      default: m[3]?.trim() || null,
      rest,
    });
  }
  // Drop the implicit `self` / `cls` for cleaner display, but keep them in
  // the underlying list for fidelity. The viewer can hide them.
  return params;
}

function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts;
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

function extractCalls(src) {
  const lines = src.split("\n");
  const defs = extractDefs(src);
  if (defs.length === 0) return [];

  const calls = [];
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const next = defs[i + 1];
    const startLine = def.line;
    const endLine = next ? next.line - 1 : lines.length;
    const bodyLines = lines
      .slice(startLine, endLine)
      .filter((l) => /^\s+\S/.test(l));
    const body = bodyLines.join("\n");

    const callRe = /(?:^|[^a-zA-Z0-9_])(\w+(?:\.\w+)*)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(body)) !== null) {
      const target = cm[1];
      const head = target.split(".")[0];
      if (PY_BUILTINS.has(head)) continue;
      if (head === def.name) continue;
      calls.push({ from: def.name, to: head, fullTarget: target });
    }
  }
  return calls;
}

export const PY_BUILTINS = new Set([
  "print", "len", "range", "enumerate", "zip", "map", "filter", "sum", "min",
  "max", "abs", "round", "sorted", "reversed",
  "list", "dict", "set", "tuple", "str", "int", "float", "bool", "bytes",
  "bytearray", "frozenset", "complex",
  "isinstance", "issubclass", "hasattr", "getattr", "setattr", "delattr",
  "type", "callable", "vars", "dir", "id", "repr", "hash", "ord", "chr",
  "open", "input", "iter", "next", "all", "any", "format",
  "super", "self", "cls", "object",
  "if", "else", "elif", "for", "while", "return", "yield", "raise", "pass",
  "try", "except", "finally", "with", "as", "in", "is", "not", "and", "or",
  "import", "from", "lambda", "global", "nonlocal", "assert", "del",
  "True", "False", "None",
]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stripCommentsAndStrings(src) {
  const out = [];
  const len = src.length;
  let i = 0;
  while (i < len) {
    const c = src[i];
    if (c === "#") {
      while (i < len && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      if (src[i + 1] === c && src[i + 2] === c) {
        const triple = c + c + c;
        out.push(triple);
        i += 3;
        while (i < len) {
          if (src[i] === c && src[i + 1] === c && src[i + 2] === c) {
            out.push(triple);
            i += 3;
            break;
          }
          out.push(src[i] === "\n" ? "\n" : " ");
          i++;
        }
        continue;
      }
      const quote = c;
      out.push(c);
      i++;
      while (i < len) {
        const ci = src[i];
        if (ci === "\\") {
          out.push("  ");
          i += 2;
          continue;
        }
        if (ci === quote) {
          out.push(ci);
          i++;
          break;
        }
        if (ci === "\n") {
          out.push("\n");
          i++;
          break;
        }
        out.push(" ");
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}
