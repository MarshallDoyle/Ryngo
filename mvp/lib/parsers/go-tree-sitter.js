/**
 * Go extractor — tree-sitter backed (Phase 5.4).
 *
 * First Ryngo extractor for Go. The regex-floor parser for Go is a
 * stub (`stubBackend("go", ...)` in `parsers/index.js`); this module
 * replaces it. When the tree-sitter-go grammar is unavailable
 * (env-flag off or native binding missing), `parse()` returns null
 * and the dispatcher falls back to the stub.
 *
 * Output shape matches the rest of the Tier-0 pipeline:
 *   { lang: "go", backend: "tree-sitter-go", imports, defs, calls }
 *
 * Notes on Go-specific design choices:
 *   - Methods are top-level in Go (`func (r *Receiver) MethodName(...)`).
 *     We emit them as defs with `name = "Receiver.MethodName"` so they
 *     don't clash with free functions of the same name and so a
 *     viewer-side filter can group methods by their receiver.
 *   - Structs / interfaces / type aliases get rendered as classes
 *     so the viewer's existing typed-port treatment applies.
 *   - Imports: a single `import_spec` per line produces one binding.
 *     We use the package's last path segment as the local name unless
 *     the import has an alias.
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
} from "./tree-sitter-runtime.js";

const GO_BUILTINS = new Set([
  // language-level builtins
  "len", "cap", "make", "new", "append", "copy", "delete", "panic",
  "recover", "print", "println", "complex", "real", "imag", "close",
  "iota", "nil", "true", "false",
  // common stdlib package names that the resolver shouldn't try to
  // resolve as in-repo defs
  "fmt", "log", "os", "io", "strings", "bytes", "errors", "math",
  "time", "sync", "context", "encoding", "net",
]);

export function parse(text) {
  if (!isAvailable("go")) return null;
  const root = tsParse("go", text);
  if (!root) return null;

  const stripped = stripCommentsAndStrings(text);
  const imports = extractImports(root);
  const defs = extractDefs(root);
  populateWarnings(stripped, defs);
  const calls = extractCalls(root, defs);

  return {
    lang: "go",
    backend: "tree-sitter-go",
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
  const query = getQuery("go", "imports");
  if (!query) return out;
  for (const { captures } of tsMatches(query, root)) {
    const pathNode = captures.path;
    if (!pathNode) continue;
    const pathRaw = nodeText(pathNode); // includes quotes
    const spec = pathRaw.replace(/^["`]|["`]$/g, "");
    if (!spec) continue;
    const aliasNode = captures.alias;
    const alias = aliasNode ? nodeText(aliasNode) : null;
    const local = alias || spec.split("/").pop();
    out.push({
      spec,
      bindings: { [local]: spec },
      isRelative: spec.startsWith(".") || spec.startsWith("/"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// defs (functions + methods + types)
// ---------------------------------------------------------------------------

function extractDefs(root) {
  const defs = [];
  const seen = new Set();

  // -- functions + methods ----------------------------------------------
  const fnQuery = getQuery("go", "functions");
  if (fnQuery) {
    for (const { captures } of tsMatches(fnQuery, root)) {
      const fnNode = captures.function;
      if (!fnNode) continue;
      const baseName = nodeText(captures.name);
      if (!baseName) continue;

      // Methods get a qualified name "Receiver.Method" so they don't
      // collide with free functions of the same name elsewhere.
      let qualifiedName = baseName;
      if (captures.receiver) {
        const recvText = nodeText(captures.receiver);
        const recvTypeMatch = recvText.match(/\b([A-Z]\w*)\b/);
        if (recvTypeMatch) qualifiedName = `${recvTypeMatch[1]}.${baseName}`;
      }
      if (seen.has(qualifiedName)) continue;
      seen.add(qualifiedName);

      const paramsText = stripOuterParens(nodeText(captures.params));
      const returnTypeText = captures.return_type
        ? stripOuterParens(nodeText(captures.return_type).trim())
        : null;
      defs.push({
        name: qualifiedName,
        kind: "function",
        line: nodeLine(fnNode),
        params: parseGoParamList(paramsText),
        returnType: returnTypeText ? { display: returnTypeText } : null,
      });
    }
  }

  // -- types (struct / interface / alias) → "class" kind ----------------
  const clQuery = getQuery("go", "classes");
  if (clQuery) {
    for (const { captures } of tsMatches(clQuery, root)) {
      const classSpec = captures.class_spec;
      const name = nodeText(captures.name);
      const body = captures.body;
      if (!classSpec || !name) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      defs.push({
        name,
        kind: "class",
        line: nodeLine(classSpec),
        members: extractStructMembers(body),
        baseClasses: collectEmbeddedTypes(body),
      });
    }
  }

  defs.sort((a, b) => a.line - b.line);
  return defs;
}

/**
 * Parse a Go parameter list. Go's syntax differs from TS / Python —
 * params share types: `func f(a, b int, c string) ...`. For simplicity
 * and zero-drift output, split on commas and emit one entry per
 * comma-separated chunk; the user's source text appears in the param
 * record's `typeDisplay` verbatim.
 */
function parseGoParamList(raw) {
  if (!raw || !raw.trim()) return [];
  const params = [];
  const chunks = splitTopLevel(raw, ",");
  for (const chunk of chunks) {
    const t = chunk.trim();
    if (!t) continue;
    // `name type`, `a, b int` (paren-grouped collapsed by splitter), or `...type`
    const variadic = t.startsWith("...");
    const body = variadic ? t.slice(3).trim() : t;
    const m = body.match(/^(\w+)\s+(.+)$/);
    if (m) {
      params.push({
        name: m[1],
        typeDisplay: m[2].trim() || null,
        optional: false,
        default: null,
        rest: variadic,
      });
    } else {
      // unnamed param or just-a-type. Emit with synthetic name.
      params.push({
        name: "_",
        typeDisplay: body.trim() || null,
        optional: false,
        default: null,
        rest: variadic,
      });
    }
  }
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

function stripOuterParens(s) {
  if (!s) return "";
  let t = s.trim();
  if (t.startsWith("(") && t.endsWith(")")) t = t.slice(1, -1);
  return t.trim();
}

/**
 * Extract struct fields (each field_declaration child) as the
 * class's `members.fields`. Method list comes from the top-level
 * function pass (Go methods are NOT nested in the struct body).
 */
function extractStructMembers(bodyNode) {
  const fields = [];
  if (!bodyNode) return { methods: [], fields, baseClasses: [] };
  if (bodyNode.type === "struct_type" || bodyNode.type === "interface_type") {
    for (const child of bodyNode.namedChildren) {
      if (child.type !== "field_declaration_list" && child.type !== "method_elem") continue;
      if (child.type === "field_declaration_list") {
        for (const decl of child.namedChildren) {
          if (decl.type !== "field_declaration") continue;
          const nameNode = firstChildOfType(decl, "field_identifier");
          const typeNode = decl.namedChildren.find(
            (c) => c.type !== "field_identifier" && c.type !== "comment",
          );
          if (!nameNode) continue;
          fields.push({
            name: nodeText(nameNode),
            typeDisplay: typeNode ? nodeText(typeNode) : null,
            default: null,
            line: nodeLine(decl),
          });
        }
      }
    }
  }
  return { methods: [], fields, baseClasses: [] };
}

function collectEmbeddedTypes(bodyNode) {
  // Anonymous embedded types in a Go struct — `type X struct { Foo; Bar }`
  // Treat as base classes for IR parity with other languages.
  const out = [];
  if (!bodyNode || bodyNode.type !== "struct_type") return out;
  const list = firstChildOfType(bodyNode, "field_declaration_list");
  if (!list) return out;
  for (const decl of list.namedChildren) {
    if (decl.type !== "field_declaration") continue;
    if (firstChildOfType(decl, "field_identifier")) continue; // named field
    const typeChild = decl.namedChildren[0];
    if (typeChild) out.push(nodeText(typeChild));
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
    // Run the same TS-flavored detectors — most are syntax-agnostic
    // (loop bodies, async-without-await won't fire on Go, hardcoded
    // password etc still match). Output is body-shape compatible.
    const w = detectWarnings(body, def.params, def.name, "ts");
    if (w.length) def.warnings = w;
  }
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

function extractCalls(root, defs) {
  const out = [];
  const query = getQuery("go", "calls");
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
    const head = target.split(".")[0];
    if (!head) continue;
    if (GO_BUILTINS.has(head)) continue;
    const line = nodeLine(call);
    const enclosing = enclosingDef(line);
    if (!enclosing) continue;
    // Compare with the unqualified method name too — methods are
    // stored with "Receiver.Method" but the body may call them as
    // "Method" alone.
    const enclosingBase = enclosing.name.includes(".")
      ? enclosing.name.split(".")[1]
      : enclosing.name;
    if (head === enclosingBase) continue;
    out.push({ from: enclosing.name, to: head, fullTarget: target });
  }
  return out;
}

/**
 * Reduce a Go callee node to its dotted-path string.
 *   identifier `foo`                          → "foo"
 *   selector_expression `pkg.Fn`              → "pkg.Fn"
 *   selector_expression `obj.field.Method`    → "obj.field.Method"
 *   parenthesized                             → unwrap and recurse
 */
function calleeFullTarget(node) {
  if (!node) return null;
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "field_identifier":
      return nodeText(node);
    case "selector_expression": {
      const operand = node.namedChildren[0];
      const fieldNode = firstChildOfType(node, "field_identifier");
      const left = operand ? calleeFullTarget(operand) : null;
      const right = fieldNode ? nodeText(fieldNode) : null;
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

function stripCommentsAndStrings(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  out = out.replace(/`(?:[^`\\]|\\.)*`/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  out = out.replace(/"(?:\\.|[^"\\])*"/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return out;
}
