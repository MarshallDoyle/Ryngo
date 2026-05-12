/**
 * TypeScript / TSX / JS extractor — tree-sitter backed (Phase 5.1.1).
 *
 * Produces the same `ParsedFile` shape as `ts.js` (the regex floor)
 * so that downstream IR construction is byte-equal where the source
 * is unambiguous, and a strict superset where regex previously
 * missed things (arrow functions in odd positions, JSX edge cases,
 * deeply destructured params, complex generics).
 *
 * Design:
 *   - Tree-sitter finds the structural anchors (function declarations,
 *     class declarations, imports, calls).
 *   - The text spans those anchors cover (the inside of `(...)`, the
 *     bit after `:`, etc.) are passed through the REGEX EXTRACTOR'S
 *     helpers (parseParamList, parseReturnType, parseBindings,
 *     extractClassMembers). That gives us bug-for-bug parity with the
 *     existing extractor's output shape — same node ids, same param
 *     records, same return-type display strings.
 *   - If the grammar isn't available (Cloud Run image missing the
 *     native binding, env-flag disabled), this module returns null
 *     and the dispatcher in `index.js` falls back to the regex
 *     extractor for that file.
 *
 * Backend label: "tree-sitter-ts" / "tree-sitter-tsx" / "tree-sitter-js".
 * The `compile-report` in `lib/quality.js` already groups by backend so
 * the corpus harness will show how many files used which backend.
 */

import { detectWarnings } from "../warnings.js";
import {
  parseBindings,
  parseParamList,
  parseReturnType,
  collectBaseClasses,
  extractClassMembers,
  TS_BUILTINS,
} from "./ts.js";
import {
  isAvailable,
  matches as tsMatches,
  parse as tsParse,
  getQuery,
  nodeText,
  nodeLine,
  firstChildOfType,
} from "./tree-sitter-runtime.js";

/**
 * Per-language entry point. `lang` is the Ryngo language key
 * (`ts` | `tsx` | `js`). Returns `ParsedFile` or `null` when
 * tree-sitter isn't available for this file — caller should fall
 * back to the regex extractor in that case.
 */
export function parse(text, lang = "ts") {
  if (!isAvailable(lang)) return null;

  const root = tsParse(lang, text);
  if (!root) return null;

  // Strip comments + strings for the warning detection input ONLY —
  // the regex helpers want a stripped string. Imports + structural
  // pieces work straight off the tree-sitter parse, which doesn't
  // care about contents-of-strings.
  const fullyStripped = stripCommentsAndStrings(text);

  const imports = extractImports(root, lang);
  const defs = extractDefs(root, text, fullyStripped, lang);
  const calls = extractCalls(root, lang, defs);

  return {
    lang: lang === "tsx" ? "ts" : lang,
    backend: `tree-sitter-${lang}`,
    imports,
    defs,
    calls,
  };
}

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

function extractImports(root, lang) {
  const out = [];
  const queryLang = lang === "tsx" ? "tsx" : lang;
  const query = getQuery(queryLang, "imports");
  if (!query) return out;

  for (const { captures } of tsMatches(query, root)) {
    if (!captures.import) continue;
    const importNode = captures.import;
    const sourceNode = captures.source;
    const specRaw = nodeText(sourceNode);
    if (!specRaw) continue;
    const spec = specRaw.slice(1, -1); // strip the quotes

    // Tree-sitter gives us the structural import_clause. The clause
    // can be `default`, `default, { named }`, `{ named }`, `* as ns`,
    // or absent (side-effect import). Easiest: pass the raw text
    // between `import` and `from` to the existing parseBindings.
    const importText = nodeText(importNode);
    const clauseMatch = importText.match(
      /^import\s+(?:type\s+)?([\s\S]+?)\s+from/,
    );
    const clause = clauseMatch ? clauseMatch[1].trim() : null;
    out.push({
      spec,
      bindings: parseBindings(clause),
      isRelative: spec.startsWith(".") || spec.startsWith("/"),
    });
  }

  // CJS `require(...)` + dynamic `import(...)` aren't covered by the
  // imports.scm query (those are call_expressions). Pull them with a
  // small per-call walk so the IR matches the regex extractor.
  extractRequireAndDynamicImports(root, out, lang);

  return out;
}

function extractRequireAndDynamicImports(root, out, lang) {
  const queryLang = lang === "tsx" ? "tsx" : lang;
  const callQuery = getQuery(queryLang, "calls");
  if (!callQuery) return;

  // Walk every call_expression. require('foo') / import('foo') are
  // both call_expression nodes with the callee identifier resolving
  // to `require` / `import`.
  for (const { captures } of tsMatches(callQuery, root)) {
    const call = captures.call;
    if (!call) continue;
    const callText = nodeText(call);
    const requireMatch = callText.match(/^require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch) {
      out.push({
        spec: requireMatch[1],
        bindings: {},
        isRelative: requireMatch[1].startsWith(".") || requireMatch[1].startsWith("/"),
      });
      continue;
    }
    const importMatch = callText.match(/^import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (importMatch) {
      out.push({
        spec: importMatch[1],
        bindings: {},
        isRelative: importMatch[1].startsWith(".") || importMatch[1].startsWith("/"),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// defs (functions + classes)
// ---------------------------------------------------------------------------

function extractDefs(root, originalText, strippedText, lang) {
  const defs = [];
  const seen = new Set();
  const queryLang = lang === "tsx" ? "tsx" : lang;

  // -- functions ---------------------------------------------------------
  const fnQuery = getQuery(queryLang, "functions");
  if (fnQuery) {
    for (const { captures } of tsMatches(fnQuery, root)) {
      const fnNode = captures.function;
      const nameNode = captures.name;
      if (!fnNode || !nameNode) continue;
      const name = nodeText(nameNode);
      if (!name || seen.has(name)) continue;
      const paramsText = nodeText(captures.params).replace(/^\(|\)$/g, "");
      const returnTypeText = captures.return_type
        ? nodeText(captures.return_type).replace(/^:\s*/, "")
        : null;
      defs.push({
        name,
        kind: "function",
        line: nodeLine(fnNode),
        params: parseParamList(paramsText),
        returnType: parseReturnType(returnTypeText),
      });
      seen.add(name);
    }
  }

  // -- classes / interfaces / enums / type aliases -----------------------
  const clQuery = getQuery(queryLang, "classes");
  if (clQuery) {
    for (const { captures } of tsMatches(clQuery, root)) {
      // class_declaration pattern
      if (captures.class && captures.class_name) {
        const name = nodeText(captures.class_name);
        if (!name || seen.has(name)) continue;
        const heritageText = nodeText(captures.class_heritage);
        const { extendsClause, implementsClause } = parseHeritage(heritageText);
        const classBodyNode = captures.class_body;
        const bodyText = stripBodyBraces(nodeText(classBodyNode));
        const bodyBaseLine = classBodyNode ? nodeLine(classBodyNode) - 1 : 0;
        defs.push({
          name,
          kind: "class",
          line: nodeLine(captures.class),
          members: extractClassMembers(bodyText, bodyBaseLine),
          baseClasses: collectBaseClasses(extendsClause, implementsClause),
        });
        seen.add(name);
        continue;
      }
      // interface_declaration → render as class (same as regex extractor)
      if (captures.interface && captures.interface_name) {
        const name = nodeText(captures.interface_name);
        if (!name || seen.has(name)) continue;
        defs.push({
          name,
          kind: "class",
          line: nodeLine(captures.interface),
          members: { methods: [], fields: [], baseClasses: [] },
          baseClasses: [],
        });
        seen.add(name);
        continue;
      }
      // enum / type alias — also surfaced as `class` for now (matches
      // the regex extractor's behavior).
      if (captures.enum && captures.enum_name) {
        const name = nodeText(captures.enum_name);
        if (!name || seen.has(name)) continue;
        defs.push({
          name,
          kind: "class",
          line: nodeLine(captures.enum),
          members: { methods: [], fields: [], baseClasses: [] },
          baseClasses: [],
        });
        seen.add(name);
        continue;
      }
      if (captures.type_alias && captures.type_alias_name) {
        const name = nodeText(captures.type_alias_name);
        if (!name || seen.has(name)) continue;
        defs.push({
          name,
          kind: "class",
          line: nodeLine(captures.type_alias),
          members: { methods: [], fields: [], baseClasses: [] },
          baseClasses: [],
        });
        seen.add(name);
      }
    }
  }

  defs.sort((a, b) => a.line - b.line);
  populateWarnings(strippedText, defs);
  return defs;
}

function parseHeritage(text) {
  // `extends Foo, Bar implements Baz` — pull the two clauses out.
  if (!text) return { extendsClause: null, implementsClause: null };
  const ex = text.match(/extends\s+([^]*?)(?=\s+implements|$)/);
  const im = text.match(/implements\s+(.+)$/);
  return {
    extendsClause: ex ? ex[1].trim() : null,
    implementsClause: im ? im[1].trim() : null,
  };
}

function stripBodyBraces(bodyText) {
  if (!bodyText) return "";
  return bodyText.replace(/^\s*\{/, "").replace(/\}\s*$/, "");
}

function populateWarnings(strippedText, defs) {
  if (!defs.length) return;
  const lines = strippedText.split("\n");
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
// calls
// ---------------------------------------------------------------------------

/**
 * Extract calls and attribute each to its enclosing def by line range.
 * Output shape matches the regex extractor:
 *   { from: <enclosing def name>, to: <head identifier>, fullTarget: <full chain> }
 *
 * `to` is the FIRST identifier of the callee (e.g. `Promise` for
 * `Promise.resolve(...)`), not the property — that's what the
 * resolver in `lib/resolver.js` looks up against import bindings.
 */
function extractCalls(root, lang, defs) {
  const out = [];
  const queryLang = lang === "tsx" ? "tsx" : lang;
  const query = getQuery(queryLang, "calls");
  if (!query) return out;
  if (!defs?.length) return out;

  // Build a function: line → enclosing def. Defs are line-sorted; the
  // enclosing def is the one with the highest line ≤ call's line.
  // Includes BOTH function and class defs to match the regex extractor:
  // calls inside class methods get attributed to the class itself
  // (the IR doesn't have per-method call attribution).
  const enclosingDefs = defs.slice();
  if (enclosingDefs.length === 0) return out;
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
    if (TS_BUILTINS.has(head)) continue;
    const line = nodeLine(call);
    const enclosing = enclosingDef(line);
    if (!enclosing) continue; // call sits at module top-level — regex skips these too
    if (head === enclosing.name) continue;
    out.push({ from: enclosing.name, to: head, fullTarget: target });
  }
  return out;
}

/**
 * Reduce a callee node to its dotted-path string. For a bare
 * identifier `foo`, returns `"foo"`. For `obj.foo`, returns
 * `"obj.foo"`. For `a.b.c`, returns `"a.b.c"`. Optional chaining
 * (`obj?.foo`) is collapsed to `obj.foo`. Returns null when the
 * callee is a complex expression we can't reduce to a clean chain.
 */
function calleeFullTarget(node) {
  if (!node) return null;
  switch (node.type) {
    case "identifier":
    case "type_identifier":
      return nodeText(node);
    case "member_expression": {
      const obj = firstChildOfType(node, "identifier")
        || firstChildOfType(node, "member_expression")
        || firstChildOfType(node, "this");
      const prop = firstChildOfType(node, "property_identifier");
      const left = obj ? calleeFullTarget(obj) : null;
      const right = prop ? nodeText(prop) : null;
      if (!left && !right) return null;
      if (!right) return left;
      if (!left) return right;
      return `${left}.${right}`;
    }
    case "subscript_expression": {
      const prop = firstChildOfType(node, "property_identifier");
      return prop ? nodeText(prop) : null;
    }
    case "non_null_expression":
    case "as_expression":
    case "satisfies_expression":
    case "parenthesized_expression": {
      // unwrap and recurse
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
 * Comment + string stripper — matches the regex extractor's
 * `stripCommentsAndStrings` so the warning detector input is
 * byte-identical between the two backends.
 *
 * Tree-sitter already gives us the AST, but warning detection
 * historically operates on a stripped string for stable line
 * indexes. We preserve that contract.
 */
function stripCommentsAndStrings(text) {
  // 1. Strip block + line comments first (preserves string content).
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  // 2. Strip string literals to empty pairs of the same length so
  //    char indexes (and thus line counts) stay aligned.
  out = out.replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  out = out.replace(/"(?:\\.|[^"\\])*"/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  out = out.replace(/'(?:\\.|[^'\\])*'/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return out;
}
