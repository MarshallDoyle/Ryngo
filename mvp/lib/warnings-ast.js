/**
 * AST-based compiler warnings — Phase 10.warning-unlock.
 *
 * Tree-sitter-backed detectors that need real AST structure, not just
 * regex over text. Complements `mvp/lib/warnings.js` (body-text
 * heuristics) and `mvp/lib/dead-code.js` (IR-edge graph passes).
 *
 * Architecture:
 *   - `detectAstWarnings(sourceText, lang, defs)` is the only public
 *     entry point. Returns an array of `{ defName, kind, severity,
 *     message }`. Dispatcher in `parsers/index.js#parseFile` finds
 *     each def by name + appends the warnings to `def.warnings`.
 *   - Orthogonal to the parser backend that extracted `defs` — works
 *     whether the regex or tree-sitter extractor produced them. The
 *     AST pass does its own tree-sitter parse via the shared runtime.
 *   - Returns empty array gracefully when tree-sitter isn't available
 *     for the language (env flag off, grammar missing).
 *
 * Detectors shipped in this commit (6 total):
 *
 *   await-in-loop          high    `await` inside `for`/`while`/
 *                                  `for...in`/`for...of` — sequential
 *                                  I/O when batching is possible
 *   unreachable-code       medium  statements after return/throw/
 *                                  raise/break/continue in same block
 *   mutation-of-param      low     reassigning a function parameter —
 *                                  surprising at call sites
 *   switch-without-default medium  switch statement with no default
 *                                  case — unhandled inputs slip through
 *   function-defined-in-loop medium function/class declared inside a
 *                                  loop body — perf foot-gun
 *   unhandled-promise-rejection high `.then(...)` with no `.catch`
 *                                  anywhere in the chain — silent
 *                                  swallowed errors
 *
 * Each detector is one function; the dispatcher (`detectAstWarnings`)
 * routes per language and per detector.
 */

import {
  isGrammarLoadable,
  parseRaw,
  nodeText,
  nodeLine,
} from "./parsers/tree-sitter-runtime.js";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {string} sourceText
 * @param {"ts"|"tsx"|"js"|"py"} lang
 * @param {Array<{name:string, kind:string, line:number}>} defs
 * @returns {Array<{defName:string, kind:string, severity:string, message:string}>}
 */
export function detectAstWarnings(sourceText, lang, defs) {
  const out = [];
  if (!sourceText || !defs?.length) return out;

  // Map "js" / "tsx" / "ts" all to the same warning vocabulary. The
  // tree-sitter dispatcher in parsers/index.js already maps .js files
  // to the TS grammar (it's a strict superset), so we follow suit.
  const grammarLang = lang === "tsx" ? "tsx" : lang === "py" ? "py" : "ts";
  if (!isGrammarLoadable(grammarLang)) return out;

  const root = parseRaw(grammarLang, sourceText);
  if (!root) return out;

  // Defs are line-sorted. Build a function-only list for "enclosing
  // def" lookups — class defs don't carry warnings, only their methods
  // (which currently aren't surfaced separately at this level).
  const fnDefs = defs.filter((d) => d.kind === "function");
  if (fnDefs.length === 0) return out;
  const enclosing = (line) => binarySearchDef(fnDefs, line);

  if (grammarLang === "py") {
    detectPyAwaitInLoop(root, enclosing, out);
    detectPyUnreachableCode(root, enclosing, out);
    detectPyMutationOfParam(root, defs, out);
  } else {
    detectTsAwaitInLoop(root, enclosing, out);
    detectTsUnreachableCode(root, enclosing, out);
    detectTsMutationOfParam(root, defs, out);
    detectTsSwitchWithoutDefault(root, enclosing, out);
    detectTsFunctionInLoop(root, enclosing, out);
    detectTsUnhandledPromiseRejection(root, enclosing, out);
  }

  return out;
}

// ---------------------------------------------------------------------------
// helpers — enclosing-def lookup, ancestor walk
// ---------------------------------------------------------------------------

function binarySearchDef(fnDefs, line) {
  let lo = 0;
  let hi = fnDefs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (fnDefs[mid].line <= line) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best >= 0 ? fnDefs[best] : null;
}

/**
 * Walk ancestors of `node` until we find one whose type matches one
 * of `types`. Returns the ancestor or null. Stops at the file root.
 */
function findAncestor(node, types) {
  // Accept Set / Array / single string. Without the `instanceof Set`
  // check, passing a Set would wrap it in `new Set([setInstance])` —
  // a one-element set of-the-set-itself — and every `set.has(type)`
  // call would return false. Cost me an evening.
  const set =
    types instanceof Set
      ? types
      : new Set(Array.isArray(types) ? types : [types]);
  let p = node.parent;
  while (p) {
    if (set.has(p.type)) return p;
    p = p.parent;
  }
  return null;
}

/**
 * Push a warning, deduping by (defName, kind) within the same out
 * array. Prevents emitting the same kind twice for the same def
 * when multiple AST sites trigger it.
 */
function pushUnique(out, defName, kind, severity, message) {
  if (!defName) return;
  if (out.some((w) => w.defName === defName && w.kind === kind)) return;
  out.push({ defName, kind, severity, message });
}

/**
 * Walk every named descendant of `root`. Generator so callers can
 * `for of` it cheaply.
 */
function* walk(root) {
  if (!root) return;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    yield n;
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      stack.push(n.namedChild(i));
    }
  }
}

// ---------------------------------------------------------------------------
// TS / JS / TSX detectors
// ---------------------------------------------------------------------------

const TS_LOOP_TYPES = new Set([
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
]);

function detectTsAwaitInLoop(root, enclosing, out) {
  for (const node of walk(root)) {
    if (node.type !== "await_expression") continue;
    const loopAncestor = findAncestor(node, TS_LOOP_TYPES);
    if (!loopAncestor) continue;
    // Skip `for await (const x of iter)` — that's intentional async
    // iteration, not an avoidable serial await.
    if (loopAncestor.type === "for_in_statement") {
      const text = nodeText(loopAncestor);
      if (text.startsWith("for await")) continue;
    }
    // Make sure the await is inside the loop *body*, not the loop
    // initializer (`for (let x = await foo(); …)` is allowed).
    if (!inLoopBody(node, loopAncestor)) continue;
    const def = enclosing(nodeLine(node));
    if (!def) continue;
    pushUnique(
      out,
      def.name,
      "await-in-loop",
      "medium",
      "await inside a loop body — sequential I/O; consider Promise.all over the inputs",
    );
  }
}

function inLoopBody(awaitNode, loopNode) {
  // Walk up from await until we hit loopNode. If any intermediate
  // ancestor is the `body` field of loopNode (statement_block or
  // single statement child after the parenthesized init), we're in
  // the body. Otherwise we're in the header.
  //
  // Tree-sitter wraps every child accessor in a fresh JS object — we
  // compare via `.id` instead of `===` to dodge that.
  const loopId = loopNode?.id;
  const lastChildId = loopNode?.namedChild(loopNode.namedChildCount - 1)?.id;
  let p = awaitNode.parent;
  while (p && p.id !== loopId) {
    if (p.parent?.id === loopId) {
      return p.id === lastChildId;
    }
    p = p.parent;
  }
  return false;
}

function detectTsUnreachableCode(root, enclosing, out) {
  for (const block of walk(root)) {
    if (block.type !== "statement_block") continue;
    const children = block.namedChildren;
    for (let i = 0; i < children.length - 1; i++) {
      const stmt = children[i];
      if (
        stmt.type === "return_statement" ||
        stmt.type === "throw_statement" ||
        stmt.type === "break_statement" ||
        stmt.type === "continue_statement"
      ) {
        // Anything after this in the same block is unreachable.
        const next = children[i + 1];
        // Skip trailing comments — tree-sitter doesn't put them in
        // namedChildren, but defensively check the kind.
        if (!next || next.type === "comment") continue;
        const def = enclosing(nodeLine(stmt));
        if (!def) continue;
        pushUnique(
          out,
          def.name,
          "unreachable-code",
          "medium",
          `statement after ${stmt.type.replace("_statement", "")} on line ${nodeLine(stmt)} will never execute`,
        );
        break;
      }
    }
  }
}

function detectTsMutationOfParam(root, defs, out) {
  for (const def of defs) {
    if (def.kind !== "function") continue;
    if (!def.params?.length) continue;
    const paramNames = new Set(
      def.params.map((p) => p.name).filter((n) => n && n !== "_destructured" && n !== "_array"),
    );
    if (paramNames.size === 0) continue;
    // Find the function node whose start line matches this def. The
    // regex extractor gives 1-based lines; tree-sitter parse is
    // already 1-based via nodeLine. Take the first matching candidate.
    const fnNode = findTsFunctionNodeAtLine(root, def.line);
    if (!fnNode) continue;
    for (const node of walk(fnNode)) {
      if (node.type !== "assignment_expression") continue;
      const lhs = node.namedChildren[0];
      if (!lhs) continue;
      // Direct identifier reassignment — `param = ...`
      if (lhs.type !== "identifier") continue;
      const name = nodeText(lhs);
      if (!paramNames.has(name)) continue;
      // Skip the explicit default-coalesce idiom `param = param || x`
      // / `param = param ?? x` — those are intentional. Everything
      // else is worth flagging.
      const rhs = node.namedChildren[1];
      if (isDefaultCoalesceRhs(rhs, name)) continue;
      pushUnique(
        out,
        def.name,
        "mutation-of-param",
        "low",
        `parameter \`${name}\` reassigned inside the function body — caller's value is not updated`,
      );
      break;
    }
  }
}

function findTsFunctionNodeAtLine(root, line) {
  for (const node of walk(root)) {
    if (
      node.type !== "function_declaration" &&
      node.type !== "method_definition" &&
      node.type !== "arrow_function" &&
      node.type !== "function_expression" &&
      node.type !== "function" // shorthand
    ) continue;
    if (nodeLine(node) === line) return node;
  }
  return null;
}

function detectTsSwitchWithoutDefault(root, enclosing, out) {
  for (const node of walk(root)) {
    if (node.type !== "switch_statement") continue;
    const body = node.namedChildren.find((c) => c.type === "switch_body");
    if (!body) continue;
    const hasDefault = body.namedChildren.some(
      (c) => c.type === "switch_default",
    );
    if (hasDefault) continue;
    const def = enclosing(nodeLine(node));
    if (!def) continue;
    pushUnique(
      out,
      def.name,
      "switch-without-default",
      "medium",
      "switch without default — unhandled cases fall through silently; add `default:` even if it throws",
    );
  }
}

function detectTsFunctionInLoop(root, enclosing, out) {
  const fnTypes = new Set([
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
  ]);
  for (const node of walk(root)) {
    if (!fnTypes.has(node.type)) continue;
    const loop = findAncestor(node, TS_LOOP_TYPES);
    if (!loop) continue;
    // Allow callback-shaped fns passed to non-loop methods inside the
    // loop body — those are real but unavoidable. We err toward
    // emission: any function declared inside a loop body deserves a
    // look.
    if (!inLoopBody(node, loop)) continue;
    const def = enclosing(nodeLine(loop));
    if (!def) continue;
    pushUnique(
      out,
      def.name,
      "function-defined-in-loop",
      "medium",
      "function declared inside a loop body — fresh closure per iteration; hoist if the body doesn't depend on loop vars",
    );
  }
}

function detectTsUnhandledPromiseRejection(root, enclosing, out) {
  // Look for `<expr>.then(...)` where the resulting expression isn't
  // followed by `.catch(...)` in the same statement and isn't
  // returned / awaited / assigned to a variable used elsewhere.
  for (const node of walk(root)) {
    if (node.type !== "call_expression") continue;
    const callee = node.namedChildren[0];
    if (!callee || callee.type !== "member_expression") continue;
    const prop = callee.namedChildren.find(
      (c) => c.type === "property_identifier",
    );
    if (!prop || nodeText(prop) !== "then") continue;
    // Walk the surrounding expression chain to see if a `.catch` is
    // attached. The chain might be `.then(...).then(...).catch(...)`
    // so check the top-most enclosing member_expression too.
    const top = climbCallChain(node);
    if (chainHasCatch(top)) continue;
    // Skip if the result is `await`-ed (await would throw on rejection).
    if (top.parent?.type === "await_expression") continue;
    // Skip if it's a `return` value (caller might catch).
    if (top.parent?.type === "return_statement") continue;
    const def = enclosing(nodeLine(node));
    if (!def) continue;
    pushUnique(
      out,
      def.name,
      "unhandled-promise-rejection",
      "high",
      "`.then(...)` chain with no `.catch` — rejections become silent unhandled rejections",
    );
  }
}

function climbCallChain(node) {
  let top = node;
  while (
    top.parent &&
    (top.parent.type === "member_expression" ||
      (top.parent.type === "call_expression" &&
        top.parent.namedChildren[0] === top.parent.namedChildren[0]))
  ) {
    // Climb if we're a child of a member_expression chain, OR if
    // we're a call_expression whose callee is itself a chain.
    if (top.parent.type === "member_expression") {
      top = top.parent;
    } else if (top.parent.type === "call_expression") {
      top = top.parent;
    } else break;
  }
  return top;
}

function chainHasCatch(top) {
  // Walk down through the call chain looking for a `.catch(...)` call.
  // The chain is right-extending in the tree; check the full subtree.
  for (const node of walk(top)) {
    if (node.type !== "call_expression") continue;
    const callee = node.namedChildren[0];
    if (!callee || callee.type !== "member_expression") continue;
    const prop = callee.namedChildren.find(
      (c) => c.type === "property_identifier",
    );
    if (prop && nodeText(prop) === "catch") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Python detectors
// ---------------------------------------------------------------------------

const PY_LOOP_TYPES = new Set(["for_statement", "while_statement"]);

function detectPyAwaitInLoop(root, enclosing, out) {
  for (const node of walk(root)) {
    if (node.type !== "await") continue; // tree-sitter-python: await is an expr type
    const loop = findAncestor(node, PY_LOOP_TYPES);
    if (!loop) continue;
    // Make sure await is in the loop *body*, not the iterable
    // expression (`for x in await foo():` is fine — the await runs
    // once before iteration).
    const body = pyLoopBody(loop);
    if (!body || !isDescendantOf(node, body)) continue;
    const def = enclosing(nodeLine(node));
    if (!def) continue;
    pushUnique(
      out,
      def.name,
      "await-in-loop",
      "medium",
      "await inside a loop body — sequential I/O; consider asyncio.gather() over the inputs",
    );
  }
}

function pyLoopBody(loopNode) {
  // tree-sitter-python: `for_statement` and `while_statement` have a
  // `body` field — usually a `block` node.
  return loopNode.namedChildren.find((c) => c.type === "block");
}

function isDescendantOf(node, ancestor) {
  // Tree-sitter creates fresh wrapper objects on each child accessor;
  // compare by `.id` (stable across re-reads of the same syntactic
  // node) instead of `===` (which compares object identity and fails
  // even when both wrappers refer to the same syntactic node).
  const targetId = ancestor?.id;
  if (targetId == null) return false;
  let p = node.parent;
  while (p) {
    if (p.id === targetId) return true;
    p = p.parent;
  }
  return false;
}

function detectPyUnreachableCode(root, enclosing, out) {
  for (const block of walk(root)) {
    if (block.type !== "block") continue;
    const children = block.namedChildren;
    for (let i = 0; i < children.length - 1; i++) {
      const stmt = children[i];
      const t = stmt.type;
      if (
        t === "return_statement" ||
        t === "raise_statement" ||
        t === "break_statement" ||
        t === "continue_statement"
      ) {
        const next = children[i + 1];
        if (!next || next.type === "comment") continue;
        const def = enclosing(nodeLine(stmt));
        if (!def) continue;
        pushUnique(
          out,
          def.name,
          "unreachable-code",
          "medium",
          `statement after ${t.replace("_statement", "")} on line ${nodeLine(stmt)} will never execute`,
        );
        break;
      }
    }
  }
}

function detectPyMutationOfParam(root, defs, out) {
  for (const def of defs) {
    if (def.kind !== "function") continue;
    if (!def.params?.length) continue;
    const paramNames = new Set(
      def.params
        .map((p) => p.name)
        .filter((n) => n && n !== "self" && n !== "cls"),
    );
    if (paramNames.size === 0) continue;
    const fnNode = findPyFunctionNodeAtLine(root, def.line);
    if (!fnNode) continue;
    for (const node of walk(fnNode)) {
      if (node.type !== "assignment") continue;
      const lhs = node.namedChildren[0];
      if (!lhs || lhs.type !== "identifier") continue;
      const name = nodeText(lhs);
      if (!paramNames.has(name)) continue;
      const rhs = node.namedChildren[1];
      if (rhs && nodeText(rhs).includes(name)) continue; // self-references
      pushUnique(
        out,
        def.name,
        "mutation-of-param",
        "low",
        `parameter \`${name}\` reassigned inside the function body — caller's value is not updated`,
      );
      break;
    }
  }
}

/**
 * Recognize `param || default` / `param ?? default` / `param if param else default`
 * — the intentional default-coalesce idiom that shouldn't trigger
 * mutation-of-param. Anything else is a real mutation.
 */
function isDefaultCoalesceRhs(rhs, paramName) {
  if (!rhs) return false;
  // JS / TS: binary_expression with || or ??
  if (rhs.type === "binary_expression") {
    const op = rhs.children.find((c) => !c.isNamed)?.type;
    if (op === "||" || op === "??") {
      const left = rhs.namedChildren[0];
      return left && nodeText(left).trim() === paramName;
    }
  }
  // TS short-circuit: `param || default` parsed as logical_expression
  // (some grammars), or as binary_expression. Handle both.
  if (rhs.type === "logical_expression") {
    const left = rhs.namedChildren[0];
    return left && nodeText(left).trim() === paramName;
  }
  // Python: `param if param is not None else default` — conditional_expression.
  if (rhs.type === "conditional_expression") {
    const truthy = rhs.namedChildren[0];
    return truthy && nodeText(truthy).trim() === paramName;
  }
  return false;
}

function findPyFunctionNodeAtLine(root, line) {
  for (const node of walk(root)) {
    if (
      node.type !== "function_definition" &&
      node.type !== "async_function_definition"
    ) continue;
    if (nodeLine(node) === line) return node;
  }
  return null;
}
