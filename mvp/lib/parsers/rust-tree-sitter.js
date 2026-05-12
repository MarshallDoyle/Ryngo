/**
 * Rust extractor — tree-sitter backed (Phase 5.5).
 *
 * First Ryngo extractor for Rust. The previous floor was the stub
 * backend; this module replaces it. Returns null when
 * tree-sitter-rust isn't available so the dispatcher falls back to
 * the stub gracefully.
 *
 * Notes on Rust-specific design:
 *   - `impl Foo { fn bar() {} }` — the `bar` becomes a def with name
 *     `Foo.bar`. Same qualification pattern as Go methods. impl blocks
 *     are walked separately to find the receiver type.
 *   - `trait Foo { fn bar(); }` — same qualification, name `Foo.bar`,
 *     captured via the function_signature_item pattern.
 *   - Macros (println!, vec!, …) are captured as calls. Useful for
 *     showing dependency usage but won't resolve cross-crate.
 *   - `use` declarations: parsed via text since the use_tree grammar
 *     allows arbitrarily nested groups that don't flatten well in a
 *     single .scm query.
 */

import { detectWarnings } from "../warnings.js";
import {
  isAvailable,
  matches as tsMatches,
  parse as tsParse,
  getQuery,
  nodeText,
  nodeLine,
  firstChildOfType,
  firstDescendantOfType,
} from "./tree-sitter-runtime.js";

const RUST_BUILTINS = new Set([
  // language-level
  "Box", "Vec", "String", "Option", "Result", "Some", "None", "Ok", "Err",
  "Self", "self", "true", "false", "_",
  // std macros
  "println", "print", "eprintln", "eprint", "format", "write", "writeln",
  "vec", "assert", "assert_eq", "assert_ne", "debug_assert", "panic",
  "todo", "unimplemented", "dbg", "matches", "include_str", "include_bytes",
  "concat", "stringify", "env", "option_env", "file", "line", "column", "module_path",
  // common stdlib prefixes the resolver shouldn't drag in
  "std", "core", "alloc", "crate", "super",
]);

export function parse(text) {
  if (!isAvailable("rust")) return null;
  const root = tsParse("rust", text);
  if (!root) return null;

  const stripped = stripCommentsAndStrings(text);
  const imports = extractImports(root);
  const defs = extractDefs(root);
  populateWarnings(stripped, defs);
  const calls = extractCalls(root, defs);

  return {
    lang: "rust",
    backend: "tree-sitter-rust",
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
  const query = getQuery("rust", "imports");
  if (!query) return out;

  for (const { captures } of tsMatches(query, root)) {
    if (captures.use) {
      const useText = nodeText(captures.use)
        .replace(/^use\s+/, "")
        .replace(/;\s*$/, "")
        .trim();
      const parsed = parseUseTree(useText);
      for (const item of parsed) {
        out.push({
          spec: item.spec,
          bindings: { [item.local]: item.orig },
          isRelative: item.spec.startsWith("crate") || item.spec.startsWith("super") || item.spec.startsWith("self"),
        });
      }
    }
    if (captures.extern_crate) {
      const name = nodeText(captures.crate_name);
      if (name) {
        out.push({
          spec: name,
          bindings: { [name]: name },
          isRelative: false,
        });
      }
    }
  }
  return out;
}

/**
 * Parse a Rust `use` tree (without leading `use ` / trailing `;`).
 * Returns one entry per leaf:
 *   "std::collections::HashMap"        → [{ spec: "std::collections", orig: "HashMap", local: "HashMap" }]
 *   "std::io::{self, Read, Write}"     → [{spec:"std::io", orig:"self", local:"std::io"}, {spec:"std::io", orig:"Read", local:"Read"}, …]
 *   "crate::foo::Bar as Baz"           → [{spec:"crate::foo", orig:"Bar", local:"Baz"}]
 *
 * Simple regex-based — Rust's full use-tree grammar is non-trivial
 * but the common cases are covered.
 */
function parseUseTree(text) {
  const out = [];
  // Glob: `path::*`
  if (text.endsWith("::*")) {
    const spec = text.slice(0, -3);
    out.push({ spec, orig: "*", local: "*" });
    return out;
  }
  // Group: `path::{a, b as c, …}`
  const groupMatch = text.match(/^(.+)::\{([^}]*)\}$/);
  if (groupMatch) {
    const spec = groupMatch[1];
    for (const item of groupMatch[2].split(",")) {
      const t = item.trim();
      if (!t) continue;
      const parts = t.split(/\s+as\s+/);
      const orig = parts[0]?.trim();
      const local =
        parts[1]?.trim() ||
        (orig === "self" ? spec.split("::").pop() : orig);
      if (orig && local) out.push({ spec, orig, local });
    }
    return out;
  }
  // `path::name as alias`
  const asMatch = text.match(/^(.+)\s+as\s+(\w+)$/);
  if (asMatch) {
    const pathParts = asMatch[1].split("::");
    const orig = pathParts.pop();
    const spec = pathParts.join("::") || asMatch[1];
    out.push({ spec, orig, local: asMatch[2] });
    return out;
  }
  // `path::Name`
  const pathParts = text.split("::");
  if (pathParts.length === 1) {
    out.push({ spec: text, orig: text, local: text });
  } else {
    const orig = pathParts.pop();
    const spec = pathParts.join("::");
    out.push({ spec, orig, local: orig });
  }
  return out;
}

// ---------------------------------------------------------------------------
// defs (functions / impl methods / types)
// ---------------------------------------------------------------------------

function extractDefs(root) {
  const defs = [];
  const seen = new Set();

  // -- functions (including impl methods, trait method signatures) ------
  const fnQuery = getQuery("rust", "functions");
  if (fnQuery) {
    for (const { captures } of tsMatches(fnQuery, root)) {
      const fnNode = captures.function;
      if (!fnNode) continue;
      const baseName = nodeText(captures.name);
      if (!baseName) continue;

      // Qualify name with the enclosing impl/trait receiver, if any.
      const receiver = enclosingReceiverType(fnNode);
      const qualifiedName = receiver ? `${receiver}.${baseName}` : baseName;
      if (seen.has(qualifiedName)) continue;
      seen.add(qualifiedName);

      const paramsText = stripOuterParens(nodeText(captures.params));
      const returnTypeText = captures.return_type
        ? nodeText(captures.return_type)
            .replace(/^->\s*/, "")
            .trim()
        : null;
      defs.push({
        name: qualifiedName,
        kind: "function",
        line: nodeLine(fnNode),
        params: parseRustParamList(paramsText),
        returnType: returnTypeText ? { display: returnTypeText } : null,
      });
    }
  }

  // -- structs / enums / traits / type aliases → "class" kind -----------
  const clQuery = getQuery("rust", "classes");
  if (clQuery) {
    for (const { captures } of tsMatches(clQuery, root)) {
      const classNode = captures.class;
      const name = nodeText(captures.name);
      if (!classNode || !name) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      defs.push({
        name,
        kind: "class",
        line: nodeLine(classNode),
        members: extractRustMembers(captures.body, classNode.type),
        baseClasses: extractTraitBounds(classNode),
      });
    }
  }

  defs.sort((a, b) => a.line - b.line);
  return defs;
}

/**
 * Walk up the parent chain to find the enclosing `impl ... for Type {}`
 * or `impl Type {}` or `trait Name {}` block. Returns the type or
 * trait name, or null if the function sits at module top-level.
 */
function enclosingReceiverType(node) {
  let p = node.parent;
  while (p) {
    if (p.type === "impl_item") {
      // impl-item has children: [trait_path]? <type>
      // The type appearing after `for` (or alone) is the implementing type.
      const typeId = firstDescendantOfType(p, "type_identifier");
      return typeId ? nodeText(typeId) : null;
    }
    if (p.type === "trait_item") {
      const typeId = firstChildOfType(p, "type_identifier");
      return typeId ? nodeText(typeId) : null;
    }
    if (p.type === "function_item" || p.type === "source_file") {
      return null;
    }
    p = p.parent;
  }
  return null;
}

function parseRustParamList(raw) {
  if (!raw || !raw.trim()) return [];
  const params = [];
  for (const chunk of splitTopLevel(raw, ",")) {
    const t = chunk.trim();
    if (!t) continue;
    if (t === "self" || t === "&self" || t === "&mut self" || t.startsWith("&'") || t.match(/^(?:mut\s+)?self\b/)) {
      params.push({ name: "self", typeDisplay: t, optional: false, default: null, rest: false });
      continue;
    }
    const m = t.match(/^(\w+)\s*:\s*(.+)$/);
    if (m) {
      params.push({
        name: m[1],
        typeDisplay: m[2].trim() || null,
        optional: false,
        default: null,
        rest: false,
      });
    } else {
      params.push({
        name: "_",
        typeDisplay: t || null,
        optional: false,
        default: null,
        rest: false,
      });
    }
  }
  return params;
}

function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0;
  let angle = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "<") angle++;
    else if (c === ">") angle--;
    else if (c === sep && depth === 0 && angle === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts;
}

function stripOuterParens(s) {
  if (!s) return "";
  let t = s.trim();
  if (t.startsWith("(") && t.endsWith(")")) t = t.slice(1, -1);
  return t.trim();
}

function extractRustMembers(bodyNode, declType) {
  const fields = [];
  if (!bodyNode) return { methods: [], fields, baseClasses: [] };
  // struct: field_declaration_list with field_declaration children
  if (bodyNode.type === "field_declaration_list") {
    for (const child of bodyNode.namedChildren) {
      if (child.type !== "field_declaration") continue;
      const nameNode = firstChildOfType(child, "field_identifier");
      const typeNode = child.namedChildren.find(
        (c) =>
          c.type !== "field_identifier" &&
          c.type !== "visibility_modifier" &&
          c.type !== "attribute_item",
      );
      if (!nameNode) continue;
      fields.push({
        name: nodeText(nameNode),
        typeDisplay: typeNode ? nodeText(typeNode) : null,
        default: null,
        line: nodeLine(child),
      });
    }
  }
  return { methods: [], fields, baseClasses: [] };
}

function extractTraitBounds(classNode) {
  const out = [];
  // For `struct/enum/trait Name<T: Bound1 + Bound2>` — pull bounds
  // out of the type_parameters child if present.
  const typeParams = firstChildOfType(classNode, "type_parameters");
  if (!typeParams) return out;
  // We just record the textual bounds as base-class entries — they're
  // visualized the same way as TS class heritage.
  for (const child of typeParams.namedChildren) {
    if (child.type === "constrained_type_parameter") {
      const bounds = firstChildOfType(child, "trait_bounds");
      if (bounds) {
        for (const b of bounds.namedChildren) {
          if (b.type === "type_identifier") out.push(nodeText(b));
        }
      }
    }
  }
  return out;
}

function populateWarnings(stripped, defs) {
  if (!defs.length) return;
  const lines = stripped.split("\n");
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    if (def.kind !== "function") continue;
    const next = defs[i + 1];
    const startLine = def.line;
    const endLine = next ? next.line - 1 : lines.length;
    const body = lines.slice(startLine - 1, endLine).join("\n");
    // Reuse TS-flavored detectors. Most are language-agnostic;
    // async-without-await / loose-equality / etc. won't fire on Rust
    // but the loop / I/O / long-fn / many-params / nested heuristics
    // do useful work.
    const w = detectWarnings(body, def.params, def.name, "ts");
    if (w.length) def.warnings = w;
  }
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

function extractCalls(root, defs) {
  const out = [];
  const query = getQuery("rust", "calls");
  if (!query || !defs?.length) return out;

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
      } else hi = mid - 1;
    }
    return best >= 0 ? enclosingDefs[best] : null;
  }

  for (const { captures } of tsMatches(query, root)) {
    const callee = captures.callee;
    const call = captures.call;
    if (!callee || !call) continue;
    const target = calleeFullTarget(callee);
    if (!target) continue;
    const head = target.split(/::|\./)[0];
    if (!head) continue;
    if (RUST_BUILTINS.has(head)) continue;
    const line = nodeLine(call);
    const enclosing = enclosingDef(line);
    if (!enclosing) continue;
    const enclosingBase = enclosing.name.includes(".")
      ? enclosing.name.split(".")[1]
      : enclosing.name;
    if (head === enclosingBase) continue;
    out.push({ from: enclosing.name, to: head, fullTarget: target });
  }
  return out;
}

function calleeFullTarget(node) {
  if (!node) return null;
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "field_identifier":
      return nodeText(node);
    case "scoped_identifier":
    case "scoped_type_identifier": {
      // a::b::c
      const left = firstChildOfType(node, "scoped_identifier")
        || firstChildOfType(node, "scoped_type_identifier")
        || firstChildOfType(node, "identifier")
        || firstChildOfType(node, "type_identifier");
      const right = node.namedChild(node.namedChildCount - 1);
      const l = left ? calleeFullTarget(left) : null;
      const r = right ? nodeText(right) : null;
      if (!l && !r) return null;
      if (!r) return l;
      if (!l) return r;
      return `${l}::${r}`;
    }
    case "field_expression": {
      const obj = node.namedChildren[0];
      const field = firstChildOfType(node, "field_identifier");
      const l = obj ? calleeFullTarget(obj) : null;
      const r = field ? nodeText(field) : null;
      if (!l && !r) return null;
      if (!r) return l;
      if (!l) return r;
      return `${l}.${r}`;
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

function stripCommentsAndStrings(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  out = out.replace(/r#*"[\s\S]*?"#*/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  out = out.replace(/"(?:\\.|[^"\\])*"/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return out;
}
