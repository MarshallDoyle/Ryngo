/**
 * Python extractor — tree-sitter backed (Phase 5.1.2).
 *
 * Same shape as `py.js` (the regex floor). Reuses the regex
 * extractor's helpers (parseParamList, parseBaseClasses,
 * extractClassMembers, PY_BUILTINS) so the IR's stable node ids hold
 * across the swap.
 *
 * Top-level filter: matches the regex extractor by only emitting
 * functions at column 0 (or directly inside a `decorated_definition`
 * whose own parent is `module`). Class methods land via
 * `extractClassMembers` on the class body text — Python tree-sitter
 * exposes method signatures but we already have working extraction
 * via text in the regex helper, so reuse it for parity.
 *
 * Returns `null` when the Python grammar isn't available (env flag
 * off, native binding missing) so the dispatcher in
 * `mvp/lib/parsers/index.js` falls back to the regex extractor.
 */

import { detectWarnings } from "../warnings.js";
import {
  parseParamList,
  parseBaseClasses,
  extractClassMembers,
  PY_BUILTINS,
} from "./py.js";
import {
  isAvailable,
  matches as tsMatches,
  parse as tsParse,
  getQuery,
  nodeText,
  nodeLine,
} from "./tree-sitter-runtime.js";

export function parse(text /*, opts */) {
  if (!isAvailable("py")) return null;

  const root = tsParse("py", text);
  if (!root) return null;

  // Strip comments + strings for the warning detector input ONLY —
  // body-text scan needs the same input the regex extractor uses for
  // parity. Tree-sitter doesn't need it for the structural queries.
  const stripped = stripCommentsAndStrings(text);

  const imports = extractImports(root);
  const defs = extractDefs(root);
  populateWarnings(stripped, defs);
  const calls = extractCalls(root, defs);

  return {
    lang: "py",
    backend: "tree-sitter-py",
    imports,
    defs,
    calls,
  };
}

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

function extractImports(root) {
  const out = [];
  const query = getQuery("py", "imports");
  if (!query) return out;

  for (const { captures } of tsMatches(query, root)) {
    const importNode = captures.import;
    if (!importNode) continue;
    const text = nodeText(importNode);
    // `from .X import a, b as c`
    const fromMatch = text.match(/^from\s+(\.*[\w.]*)\s+import\s+(.+)$/s);
    if (fromMatch) {
      const spec = fromMatch[1];
      const isRelative = spec.startsWith(".");
      const items = fromMatch[2]
        .replace(/[()]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const bindings = {};
      for (const item of items) {
        const parts = item.split(/\s+as\s+/);
        const orig = parts[0]?.trim();
        const local = (parts[1] || parts[0])?.trim();
        if (orig && local) bindings[local] = orig;
      }
      out.push({ spec, bindings, isRelative });
      continue;
    }
    // `import X` / `import X as Y` / `import X, Y.Z`
    const importMatch = text.match(/^import\s+(.+)$/s);
    if (importMatch) {
      const items = importMatch[1]
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
  }

  return out;
}

// ---------------------------------------------------------------------------
// defs (functions + classes, top-level only)
// ---------------------------------------------------------------------------

function extractDefs(root) {
  const defs = [];
  const seen = new Set();

  // -- top-level functions ----------------------------------------------
  // We can't easily express "top-level only" in a .scm query (no
  // negation on parent type). Pull all function_definition matches
  // and filter via parent chain in JS.
  const fnQuery = getQuery("py", "functions");
  if (fnQuery) {
    for (const { captures } of tsMatches(fnQuery, root)) {
      const fnNode = captures.function;
      if (!fnNode) continue;
      if (!isTopLevelDef(fnNode)) continue;
      const name = nodeText(captures.name);
      if (!name || seen.has(name)) continue;
      const paramsText = stripParamParens(nodeText(captures.params));
      const returnTypeText = captures.return_type
        ? nodeText(captures.return_type).trim()
        : null;
      defs.push({
        name,
        kind: "function",
        line: nodeLine(fnNode),
        params: parseParamList(paramsText),
        returnType: returnTypeText ? { display: returnTypeText } : null,
      });
      seen.add(name);
    }
  }

  // -- top-level classes ------------------------------------------------
  const clQuery = getQuery("py", "classes");
  if (clQuery) {
    for (const { captures } of tsMatches(clQuery, root)) {
      const clNode = captures.class;
      if (!clNode) continue;
      if (!isTopLevelDef(clNode)) continue;
      const name = nodeText(captures.name);
      if (!name || seen.has(name)) continue;
      const basesText = captures.bases
        ? stripParamParens(nodeText(captures.bases))
        : "";
      const bodyNode = captures.body;
      const bodyText = bodyNode ? nodeText(bodyNode) : "";
      const bodyBaseLine = bodyNode ? nodeLine(bodyNode) : nodeLine(clNode) + 1;
      defs.push({
        name,
        kind: "class",
        line: nodeLine(clNode),
        members: extractClassMembers(bodyText, bodyBaseLine),
        baseClasses: parseBaseClasses(basesText),
      });
      seen.add(name);
    }
  }

  defs.sort((a, b) => a.line - b.line);
  return defs;
}

/**
 * Walk parents to determine if a def lives at module top-level.
 * Python tree-sitter wraps decorated defs in a `decorated_definition`
 * node — we accept that as still being "top-level" if its parent is
 * `module`.
 */
function isTopLevelDef(node) {
  let p = node.parent;
  if (!p) return true;
  if (p.type === "decorated_definition") p = p.parent;
  if (!p) return true;
  return p.type === "module";
}

function stripParamParens(text) {
  if (!text) return "";
  return text.replace(/^\s*\(/, "").replace(/\)\s*$/, "");
}

function populateWarnings(strippedSrc, defs) {
  if (!defs.length) return;
  const lines = strippedSrc.split("\n");
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
// calls
// ---------------------------------------------------------------------------

function extractCalls(root, defs) {
  const out = [];
  const query = getQuery("py", "calls");
  if (!query) return out;
  if (!defs?.length) return out;

  // enclosing def lookup — same line-range binary search as TS.
  // Includes class defs so calls inside class methods get attributed
  // to the class, matching the regex extractor's behavior.
  const enclosingDefs = defs.slice();
  function enclosingDef(line) {
    let lo = 0;
    let hi = enclosingDefs.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (enclosingDefs[mid].line <= line) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 ? enclosingDefs[best] : null;
  }

  for (const { captures } of tsMatches(query, root)) {
    const callee = captures.callee;
    const call = captures.call;
    if (!callee || !call) continue;
    const target = calleeFullTarget(callee);
    if (!target) continue;
    const head = target.split(".")[0];
    if (!head) continue;
    if (PY_BUILTINS.has(head)) continue;
    const line = nodeLine(call);
    const enclosing = enclosingDef(line);
    if (!enclosing) continue;
    if (head === enclosing.name) continue;
    out.push({ from: enclosing.name, to: head, fullTarget: target });
  }
  return out;
}

/**
 * Reduce a Python callee node to its dotted-path string.
 *   identifier `foo`         → "foo"
 *   attribute `obj.foo`      → "obj.foo"
 *   attribute `a.b.c`        → "a.b.c"
 *   subscript `arr[0]`       → null (not a member call)
 *   parenthesized            → unwrap and recurse
 */
function calleeFullTarget(node) {
  if (!node) return null;
  switch (node.type) {
    case "identifier":
      return nodeText(node);
    case "attribute": {
      // attribute has: object (Expression), attribute (Identifier)
      const objNode = node.namedChildren[0];
      const attrNode = node.namedChild(node.namedChildCount - 1);
      const left = objNode ? calleeFullTarget(objNode) : null;
      const right = attrNode ? nodeText(attrNode) : null;
      if (!left && !right) return null;
      if (!right) return left;
      if (!left) return right;
      return `${left}.${right}`;
    }
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner ? calleeFullTarget(inner) : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Strip comments + strings to spaces (preserving newlines + char
 * counts so line indexes stay aligned). The warning detector input
 * needs this for parity with what `py.js` produces.
 */
function stripCommentsAndStrings(src) {
  let out = src.replace(/#[^\n]*/g, (m) => " ".repeat(m.length));
  // triple-quoted strings (both """ and ''')
  out = out.replace(/"""[\s\S]*?"""/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  out = out.replace(/'''[\s\S]*?'''/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  // single-line strings
  out = out.replace(/"(?:\\.|[^"\\])*"/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  out = out.replace(/'(?:\\.|[^'\\])*'/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return out;
}
