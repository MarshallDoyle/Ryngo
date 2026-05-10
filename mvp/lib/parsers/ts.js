/**
 * TypeScript / JavaScript parser — Tier-0 backend (regex-based).
 *
 * Produces full ParsedFile with params, returnType and class members so the
 * downstream typed-port viewer (Phase 4.2) and LLM projections (Phase 5.6)
 * have what they need.
 *
 * This is the regex floor. Swappable for a tree-sitter or TS-compiler-API
 * backend later without changing the IR shape — the registry resolves backend
 * per language.
 */

import { detectWarnings } from "../warnings.js";

const BACKEND = "regex";

export function parse(text /*, opts */) {
  // Comments-only strip preserves string literals so import specs survive.
  // Full strip (comments + strings) is what defs / calls need so string
  // contents containing the word `function` etc. don't false-positive.
  const commentsStripped = stripCommentsOnly(text);
  const fullyStripped = stripStringsToo(commentsStripped);
  const defs = extractDefs(fullyStripped);
  populateWarnings(fullyStripped, defs);
  return {
    lang: "ts",
    backend: BACKEND,
    imports: extractImports(commentsStripped),
    defs,
    calls: extractCalls(fullyStripped),
  };
}

/**
 * Mutate `defs` in place: for every function def, slice its body
 * (this def's line up to the next def's line) and run heuristic
 * warning detection. Skips classes — interface bodies aren't
 * algorithmic.
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
    const w = detectWarnings(body, def.params, def.name, "ts");
    if (w.length) def.warnings = w;
  }
}

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

function extractImports(src) {
  const out = [];

  const importRe =
    /(?:^|[\n;])\s*import\s+(?:([^'";]+?)\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const clause = m[1];
    const spec = m[2];
    out.push({
      spec,
      bindings: parseBindings(clause),
      isRelative: spec.startsWith(".") || spec.startsWith("/"),
    });
  }

  const reexportRe =
    /(?:^|[\n;])\s*export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = reexportRe.exec(src)) !== null) {
    out.push({
      spec: m[2],
      bindings: parseBindings(`{${m[1]}}`),
      isRelative: m[2].startsWith(".") || m[2].startsWith("/"),
    });
  }

  const reexportStarRe =
    /(?:^|[\n;])\s*export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = reexportStarRe.exec(src)) !== null) {
    out.push({
      spec: m[1],
      bindings: {},
      isRelative: m[1].startsWith(".") || m[1].startsWith("/"),
    });
  }

  // CommonJS with binding: `var X = require('spec')` / `const X = require('spec')`
  // / multi-declarator `var X = require('a'), Y = require('b')` / bare
  // reassignment `app = require('express')`. Negative lookbehind excludes
  // member access (`obj.app = require(...)` would match `app` otherwise).
  const cjsBindRe =
    /(?<![.\w$])(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = cjsBindRe.exec(src)) !== null) {
    out.push({
      spec: m[2],
      bindings: { [m[1]]: "default" },
      isRelative: m[2].startsWith(".") || m[2].startsWith("/"),
    });
  }

  // CommonJS destructured: `const { a, b: c } = require('spec')`
  const cjsDestructRe =
    /\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = cjsDestructRe.exec(src)) !== null) {
    const bindings = {};
    for (const item of m[1].split(",")) {
      const t = item.trim();
      if (!t) continue;
      const parts = t.split(/\s*:\s*/);
      const orig = parts[0]?.trim();
      const local = (parts[1] || parts[0])?.trim();
      if (orig && local) bindings[local] = orig;
    }
    out.push({
      spec: m[2],
      bindings,
      isRelative: m[2].startsWith(".") || m[2].startsWith("/"),
    });
  }

  // Bare require, including side-effect requires and inline expressions —
  // emits the package edge but no local binding (which is correct for sites
  // like `app.use(require('cors')())`).
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRe.exec(src)) !== null) {
    out.push({
      spec: m[1],
      bindings: {},
      isRelative: m[1].startsWith(".") || m[1].startsWith("/"),
    });
  }

  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(src)) !== null) {
    out.push({
      spec: m[1],
      bindings: {},
      isRelative: m[1].startsWith(".") || m[1].startsWith("/"),
    });
  }

  return out;
}

function parseBindings(clause) {
  if (!clause) return {};
  const bindings = {};
  let cleaned = clause.replace(/^\s*type\s+/, "").trim();

  const def = cleaned.match(/^(\w+)/);
  if (def) bindings[def[1]] = "default";

  const ns = cleaned.match(/\*\s+as\s+(\w+)/);
  if (ns) bindings[ns[1]] = "*";

  const named = cleaned.match(/\{([^}]+)\}/);
  if (named) {
    for (const item of named[1].split(",")) {
      const t = item.trim().replace(/^type\s+/, "");
      if (!t) continue;
      const parts = t.split(/\s+as\s+/);
      const orig = parts[0]?.trim();
      const local = (parts[1] || parts[0])?.trim();
      if (orig && local) bindings[local] = orig;
    }
  }

  return bindings;
}

// ---------------------------------------------------------------------------
// defs (functions + classes) with params, return type, class members
// ---------------------------------------------------------------------------

/**
 * Match each function-shaped declaration with capture groups for:
 *   1. name
 *   2. params (raw text inside the outermost () )
 *   3. returnType (raw text after `:` and before `=>`/`{` if present)
 *
 * NOTE: The `params` group is only the leading run of non-paren chars. Inside
 * the params we may have nested `(`/`)` from default values like
 * `(handler = () => {})`. That's a minority case; we do a targeted re-scan
 * below for those.
 */
const FN_PATTERNS = [
  // function foo(...) [: ret] { ... }
  /(?:^|\n)[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^={\n]+?))?\s*[{\n]/g,
  // const foo = (...) [: ret] => ...
  /(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+?)?=\s*(?:async\s+)?(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^={\n=]+?))?\s*=>/g,
  // const foo = function (...) ...
  /(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+?)?=\s*(?:async\s+)?function\s*\*?\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^={\n]+?))?\s*[{\n]/g,
];

const CLASS_RE =
  /(?:^|\n)[ \t]*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?(class|interface)\s+(\w+)\s*(?:<[^>]+>)?\s*(?:extends\s+([^{\n]+?))?\s*(?:implements\s+([^{\n]+?))?\s*{/g;

function extractDefs(src) {
  const defs = [];
  const seen = new Set();

  for (const re of FN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      if (seen.has(name)) continue;
      // FN_PATTERNS include `(?:^|\n)` so m.index can land ON a newline
      // (the line BEFORE the function keyword). Skip past it so lineOf
      // returns the correct line for downstream body slicing.
      const realStart = src[m.index] === "\n" ? m.index + 1 : m.index;
      const line = lineOf(src, realStart);
      const params = parseParamList(m[2]);
      const returnType = parseReturnType(m[3]);
      defs.push({
        name,
        kind: "function",
        line,
        params,
        returnType,
      });
      seen.add(name);
    }
  }

  CLASS_RE.lastIndex = 0;
  let cm;
  while ((cm = CLASS_RE.exec(src)) !== null) {
    const kind = cm[1] === "interface" ? "class" : "class"; // both rendered as class for now
    const name = cm[2];
    if (seen.has(name)) continue;
    const baseClasses = collectBaseClasses(cm[3], cm[4]);
    const realStart = src[cm.index] === "\n" ? cm.index + 1 : cm.index;
    const line = lineOf(src, realStart);
    const bodyStart = cm.index + cm[0].length;
    const body = sliceClassBody(src, bodyStart);
    defs.push({
      name,
      kind,
      line,
      members: extractClassMembers(body),
      baseClasses,
    });
    seen.add(name);
  }

  return defs.sort((a, b) => a.line - b.line);
}

function collectBaseClasses(extendsClause, implementsClause) {
  const out = [];
  if (extendsClause) {
    for (const c of extendsClause.split(",")) {
      const t = c.trim().replace(/<.*$/, "");
      if (t) out.push(t);
    }
  }
  if (implementsClause) {
    for (const c of implementsClause.split(",")) {
      const t = c.trim().replace(/<.*$/, "");
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * Walk forward from `start` (just past the `{` of a class body) and return
 * the substring up to the matching `}`. Naive brace-counting; comments and
 * strings have already been stripped, so it's safe.
 */
function sliceClassBody(src, start) {
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (depth === 0) return src.slice(start, i);
    i++;
  }
  return src.slice(start, i);
}

const METHOD_RE =
  /(?:^|\n)[ \t]+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|abstract\s+|override\s+)*?(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^={\n;]+?))?\s*[{;]/g;

const FIELD_RE =
  /(?:^|\n)[ \t]+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*?(\w+)\s*(\??)\s*:\s*([^=;\n]+?)(?:=\s*([^;\n]+))?\s*[;\n]/g;

function extractClassMembers(body) {
  const methods = [];
  const fields = [];
  const seenMethods = new Set();

  METHOD_RE.lastIndex = 0;
  let mm;
  while ((mm = METHOD_RE.exec(body)) !== null) {
    const name = mm[1];
    if (RESERVED_FOR_FIELDS.has(name)) continue;
    if (seenMethods.has(name)) continue;
    seenMethods.add(name);
    methods.push({
      name,
      params: parseParamList(mm[2]),
      returnType: parseReturnType(mm[3]),
      line: lineOf(body, mm.index),
    });
  }

  FIELD_RE.lastIndex = 0;
  let fm;
  while ((fm = FIELD_RE.exec(body)) !== null) {
    const name = fm[1];
    if (RESERVED_FOR_FIELDS.has(name)) continue;
    if (seenMethods.has(name)) continue;
    fields.push({
      name,
      typeDisplay: fm[3]?.trim() || null,
      optional: fm[2] === "?",
      default: fm[4]?.trim() || null,
      line: lineOf(body, fm.index),
    });
  }

  return { methods, fields, baseClasses: [] };
}

const RESERVED_FOR_FIELDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "switch",
  "return",
  "throw",
  "try",
  "catch",
  "finally",
  "do",
  "case",
  "break",
  "continue",
  "constructor",
]);

// ---------------------------------------------------------------------------
// param + return parsing
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated parameter list. Splits at top-level commas (tracks
 * (), [], {}, <> depth so generics + destructuring don't split mid-token).
 * Each chunk:  [rest?] name [?] [: type] [= default]
 */
function parseParamList(raw) {
  if (!raw || !raw.trim()) return [];
  const params = [];
  for (const chunk of splitTopLevel(raw, ",")) {
    const t = chunk.trim();
    if (!t) continue;
    let rest = false;
    let body = t;
    if (body.startsWith("...")) {
      rest = true;
      body = body.slice(3).trim();
    }
    // Drop access-modifier keywords sometimes seen in TS constructors.
    body = body.replace(
      /^(?:public|private|protected|readonly)\s+/,
      "",
    );
    // Destructured params: `{a, b}: Type` — collapse to a synthetic name.
    if (body.startsWith("{") || body.startsWith("[")) {
      const colonIdx = topLevelIndexOf(body, ":");
      const equalsIdx = topLevelIndexOf(body, "=");
      let typeDisplay = null;
      let defaultVal = null;
      if (colonIdx >= 0) {
        const tail =
          equalsIdx >= 0 && equalsIdx > colonIdx
            ? body.slice(colonIdx + 1, equalsIdx)
            : body.slice(colonIdx + 1);
        typeDisplay = tail.trim() || null;
      }
      if (equalsIdx >= 0) defaultVal = body.slice(equalsIdx + 1).trim() || null;
      params.push({
        name: body[0] === "{" ? "_destructured" : "_array",
        typeDisplay,
        optional: false,
        default: defaultVal,
        rest,
      });
      continue;
    }
    const m = body.match(
      /^(\w+)(\??)\s*(?::\s*([\s\S]+?))?\s*(?:=\s*([\s\S]+))?$/,
    );
    if (!m) {
      params.push({ name: body, optional: false, rest });
      continue;
    }
    params.push({
      name: m[1],
      typeDisplay: m[3]?.trim() || null,
      optional: m[2] === "?",
      default: m[4]?.trim() || null,
      rest,
    });
  }
  return params;
}

function parseReturnType(raw) {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  return { display: t };
}

function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts;
}

function topLevelIndexOf(s, ch) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// calls (per top-level def)
// ---------------------------------------------------------------------------

function extractCalls(src) {
  const calls = [];
  const defs = extractDefs(src);
  if (defs.length === 0) return calls;

  const lines = src.split("\n");
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const next = defs[i + 1];
    const startLine = def.line;
    const endLine = next ? next.line - 1 : lines.length;
    const body = lines.slice(startLine, endLine).join("\n");

    const callRe =
      /(?:^|[^a-zA-Z0-9_$.])(?:await\s+)?(?:new\s+)?(\w+(?:\.\w+)*)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(body)) !== null) {
      const target = cm[1];
      const head = target.split(".")[0];
      if (TS_BUILTINS.has(head)) continue;
      if (head === def.name) continue;
      calls.push({ from: def.name, to: head, fullTarget: target });
    }
  }
  return calls;
}

const TS_BUILTINS = new Set([
  "if", "else", "while", "for", "switch", "catch", "return", "typeof",
  "instanceof", "void", "delete", "in", "of", "throw", "try", "do",
  "console", "JSON", "Math", "Array", "Object", "String", "Number",
  "Boolean", "Error", "Promise", "Set", "Map", "Date", "RegExp", "Symbol",
  "WeakMap", "WeakSet", "BigInt", "Proxy", "Reflect",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "require", "module", "exports", "process",
  "Buffer", "global", "globalThis", "window", "document", "fetch", "function",
  "URL", "URLSearchParams",
]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lineOf(src, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function stripCommentsOnly(src) {
  // Replace `//…` and `/* … */` with whitespace, preserving string literal
  // bodies so import specs still resolve.
  const out = [];
  const len = src.length;
  let i = 0;
  while (i < len) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < len && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out.push("  ");
      i += 2;
      while (i < len && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < len) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    // Pass strings through verbatim — extractImports needs the contents.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out.push(c);
      i++;
      while (i < len) {
        const ci = src[i];
        if (ci === "\\") {
          out.push(ci);
          out.push(src[i + 1] || "");
          i += 2;
          continue;
        }
        out.push(ci);
        if (ci === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

function stripStringsToo(src) {
  // Second-pass strip of string contents, applied to the comment-stripped
  // source. Defs / calls don't need string contents.
  const out = [];
  const len = src.length;
  let i = 0;
  while (i < len) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
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
        out.push(ci === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}
