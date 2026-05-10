/**
 * `analyzeFile` phase for the Express adapter.
 *
 * Pure per-file work. The host parallelizes us across files and caches the
 * resulting fragments by `(adapter@version, file content hash)`, so this
 * function MUST be deterministic and side-effect-free at module level.
 * All state lives on local objects and on `ctx`.
 *
 * What we recognize (single AST walk, no string heuristics):
 *
 *   1. `const x = express()`            → bind `x` as an `app`
 *   2. `const x = express.Router()`     → bind `x` as a `router`
 *   3. `const x = Router()`             → bind `x` as a `router`
 *      (only when `Router` was imported from the `express` module — the
 *       SDK's symbol index tells us this)
 *   4. `app.METHOD(path, ...handlers)`  → emit shared `http.route` node +
 *                                          private route-handler edge
 *   5. `app.use(prefix, router)`        → record a mount; resolved later
 *   6. `app.use(router)`                → record a prefix-less mount ("")
 *
 * What we deliberately DON'T do:
 *
 *   - Walk `app.route('/x').get(...).post(...)` chains. These are real
 *     Express but rare; v0.1 emits a warn diagnostic and skips. v0.2 will
 *     handle the chain.
 *   - Treat `app.use(fn)` (middleware-only) as a route. Middleware
 *     tracking is a separate, future concern.
 *   - Infer paths from non-literal expressions. Template literals with
 *     ONLY string parts are accepted (we synthesize the literal); anything
 *     with interpolations is flagged dynamic and skipped — never fabricate.
 *   - Emit cross-stack `fetch -> route` edges. adapter-nextjs is the
 *     producer-of-record for those (see contract with adapter-nextjs).
 */

import type { AnalyzeFileContext, IrEdge, IrId, IrNode } from "@codegraph/adapter-sdk";

import {
  DIAG_NON_LITERAL_PATH,
  DIAG_UNRESOLVED_HANDLER,
  EDGE_KIND_ROUTE_HANDLER,
  FRAMEWORK,
  HTTP_VERBS,
  NODE_KIND_FILE_MOUNTS,
  NODE_KIND_HANDLER,
  NODE_KIND_ROUTE,
  NODE_KIND_ROUTER,
  isHttpVerb,
} from "./types.js";
import type {
  AppBinding,
  AstCallExpression,
  AstFunctionLike,
  AstIdentifier,
  AstImportDeclaration,
  AstMemberExpression,
  AstNodeBase,
  AstStringLiteral,
  AstTemplateLiteral,
  AstVariableDeclarator,
  FileMountsNodeData,
  HandlerNodeData,
  MountRecord,
  RouteHandlerEdgeData,
  RouteNodeData,
  RouterNodeData,
} from "./types.js";

interface FileState {
  /** Local bindings: variable name → kind + optional router IR id. */
  readonly bindings: Map<string, AppBinding>;
  /** Mounts discovered while walking this file. */
  readonly mounts: MountRecord[];
  /** Names that resolve to the `express` default import. */
  readonly expressNames: Set<string>;
  /** Names that resolve to a `Router`-named import from express. */
  readonly routerNames: Set<string>;
}

export async function analyzeFile(ctx: AnalyzeFileContext): Promise<void> {
  // Cheap bail: only TS/JS files can contain Express registrations.
  if (!isJsLike(ctx.file.language)) return;
  // Even cheaper bail: if the source doesn't mention "express" anywhere,
  // there's nothing for us to find. Static cost; saves the AST walk on
  // unrelated files. Allowed by spec §6.3 — `file.content` is part of the
  // cache key.
  if (!ctx.file.content.includes("express")) return;
  if (ctx.file.ast === null) return;

  const state: FileState = {
    bindings: new Map<string, AppBinding>(),
    mounts: [],
    expressNames: new Set<string>(),
    routerNames: new Set<string>(),
  };

  // Pass 1: scan import declarations to learn which local names refer to
  // the `express` module. We need this so that `Router()` (no `express.`
  // qualifier) isn't mistaken for an unrelated `Router` from elsewhere.
  visit(ctx.file.ast as AstNodeBase, (node) => {
    if (node.type === "ImportDeclaration") {
      handleImport(node as AstImportDeclaration, state);
    }
  });

  // Pass 2: bindings + route registrations + mounts. Single walk.
  visit(ctx.file.ast as AstNodeBase, (node) => {
    if (ctx.signal.aborted) return;

    if (node.type === "VariableDeclarator") {
      handleBindingCandidate(node as AstVariableDeclarator, ctx, state);
      return;
    }
    if (node.type === "CallExpression") {
      handleCallExpression(node as AstCallExpression, ctx, state);
      return;
    }
  });

  // Emit one router node per discovered router binding so peer adapters
  // and the resolver can address it by IR id. Done at the end so we have a
  // stable iteration order over `state.bindings`.
  for (const [varName, binding] of sortedEntries(state.bindings)) {
    if (binding.kind !== "router" || !binding.routerId) continue;
    const routerNode: IrNode<RouterNodeData> = {
      id: binding.routerId,
      kind: NODE_KIND_ROUTER,
      label: `Router ${varName}`,
      data: { varName },
      provenance: undefined as never, // host stamps real provenance
    } as IrNode<RouterNodeData>;
    ctx.emit(routerNode);
  }

  // Mounts ride on a synthetic per-file carrier node so the resolver can
  // see them via `ctx.own.nodes(NODE_KIND_FILE_MOUNTS)`. This avoids the
  // older API's `output.private` channel — the spec's emit/peer model has
  // no per-adapter scratch space, only IR nodes.
  if (state.mounts.length > 0) {
    const mountsId = ctx.id.mint({
      path: ctx.file.path,
      localId: `mounts::${ctx.file.path}`,
    });
    const mountsNode: IrNode<FileMountsNodeData> = {
      id: mountsId,
      kind: NODE_KIND_FILE_MOUNTS,
      label: `Express mounts (${ctx.file.path})`,
      data: { mounts: state.mounts },
      provenance: undefined as never,
    } as IrNode<FileMountsNodeData>;
    ctx.emit(mountsNode);
  }
}

// ---------------------------------------------------------------------------
// Import handling
// ---------------------------------------------------------------------------

function handleImport(node: AstImportDeclaration, state: FileState): void {
  if (node.source.value !== "express") return;
  for (const spec of node.specifiers) {
    // ImportDefaultSpecifier  → `import express from 'express'`
    // ImportSpecifier         → `import { Router } from 'express'`
    // ImportNamespaceSpecifier → `import * as e from 'express'`
    const t = spec.type;
    if (t === "ImportDefaultSpecifier" || t === "ImportNamespaceSpecifier") {
      const localName = readLocalName(spec);
      if (localName) state.expressNames.add(localName);
      continue;
    }
    if (t === "ImportSpecifier") {
      const localName = readLocalName(spec);
      const importedName = readImportedName(spec);
      if (!localName) continue;
      if (importedName === "Router") {
        state.routerNames.add(localName);
      } else if (importedName === "default") {
        state.expressNames.add(localName);
      }
    }
  }
}

function readLocalName(spec: AstNodeBase): string | null {
  const local = (spec as { local?: AstNodeBase }).local;
  if (local && local.type === "Identifier") return (local as AstIdentifier).name;
  return null;
}

function readImportedName(spec: AstNodeBase): string | null {
  const imported = (spec as { imported?: AstNodeBase }).imported;
  if (imported && imported.type === "Identifier") return (imported as AstIdentifier).name;
  // `import { default as x } from 'express'` shows up with imported === null in
  // some normalizers; treat that as default.
  return null;
}

// ---------------------------------------------------------------------------
// Variable bindings: detect `app = express()` / `r = express.Router()`
// ---------------------------------------------------------------------------

function handleBindingCandidate(
  node: AstVariableDeclarator,
  ctx: AnalyzeFileContext,
  state: FileState,
): void {
  if (node.id.type !== "Identifier") return;
  const init = node.init;
  if (!init || init.type !== "CallExpression") return;

  const call = init as AstCallExpression;
  const varName = (node.id as AstIdentifier).name;

  // express()
  if (
    call.callee.type === "Identifier" &&
    state.expressNames.has((call.callee as AstIdentifier).name)
  ) {
    state.bindings.set(varName, { kind: "app" });
    return;
  }

  // express.Router() — works whether `express` is the default import name
  // or some user-chosen alias.
  if (call.callee.type === "MemberExpression") {
    const member = call.callee as AstMemberExpression;
    if (
      !member.computed &&
      member.object.type === "Identifier" &&
      member.property.type === "Identifier" &&
      state.expressNames.has((member.object as AstIdentifier).name) &&
      (member.property as AstIdentifier).name === "Router"
    ) {
      state.bindings.set(varName, makeRouterBinding(varName, ctx));
      return;
    }
  }

  // Bare Router() — only if `Router` was named-imported from express.
  if (
    call.callee.type === "Identifier" &&
    state.routerNames.has((call.callee as AstIdentifier).name)
  ) {
    state.bindings.set(varName, makeRouterBinding(varName, ctx));
  }
}

function makeRouterBinding(varName: string, ctx: AnalyzeFileContext): AppBinding {
  const routerId = ctx.id.mint({
    path: ctx.file.path,
    localId: `router::${varName}`,
  });
  return { kind: "router", routerId };
}

// ---------------------------------------------------------------------------
// Call expressions: route registrations + mounts
// ---------------------------------------------------------------------------

function handleCallExpression(
  node: AstCallExpression,
  ctx: AnalyzeFileContext,
  state: FileState,
): void {
  if (node.callee.type !== "MemberExpression") return;
  const member = node.callee as AstMemberExpression;
  if (member.computed) return;
  if (member.object.type !== "Identifier" || member.property.type !== "Identifier") return;

  const ownerVar = (member.object as AstIdentifier).name;
  const verbWritten = (member.property as AstIdentifier).name;
  const verb = verbWritten.toLowerCase();

  const binding = state.bindings.get(ownerVar);
  if (!binding) return;

  // Sub-router mounting. `app.use([prefix,] router)`
  if (verb === "use") {
    handleUseCall(node, ownerVar, ctx, state);
    return;
  }

  // Route registration. Skip anything that isn't a known HTTP verb so we
  // don't accidentally treat `app.set(...)` or `app.engine(...)` as routes.
  if (!isHttpVerb(verb)) return;
  if (!HTTP_VERBS.includes(verb)) return; // narrowing for noUncheckedIndexedAccess

  emitRoute(node, verb, ownerVar, binding, ctx);
}

function handleUseCall(
  node: AstCallExpression,
  ownerVar: string,
  ctx: AnalyzeFileContext,
  state: FileState,
): void {
  const args = node.arguments;
  if (args.length === 0) return;

  // `app.use('/api', someRouter)` — most common shape.
  if (args.length >= 2) {
    const pathArg = args[0];
    const routerArg = args[1];
    if (!pathArg || !routerArg) return;
    const prefix = readStringPath(pathArg);
    if (prefix === null) return; // dynamic prefix; refuse to fabricate
    if (routerArg.type !== "Identifier") return;
    const routerName = (routerArg as AstIdentifier).name;
    const targetBinding = state.bindings.get(routerName);
    if (targetBinding?.kind !== "router") return;
    state.mounts.push({
      prefix,
      routerVar: routerName,
      mountedOn: ownerVar,
      file: ctx.file.path,
    });
    return;
  }

  // `app.use(someRouter)` — prefix-less mount.
  const onlyArg = args[0];
  if (!onlyArg || onlyArg.type !== "Identifier") return;
  const routerName = (onlyArg as AstIdentifier).name;
  const targetBinding = state.bindings.get(routerName);
  if (targetBinding?.kind !== "router") return;
  state.mounts.push({
    prefix: "",
    routerVar: routerName,
    mountedOn: ownerVar,
    file: ctx.file.path,
  });
}

// ---------------------------------------------------------------------------
// Route emission
// ---------------------------------------------------------------------------

function emitRoute(
  call: AstCallExpression,
  verb: string,
  ownerVar: string,
  binding: AppBinding,
  ctx: AnalyzeFileContext,
): void {
  const args = call.arguments;
  if (args.length < 2) return; // need at least path + handler
  const pathArg = args[0];
  if (!pathArg) return;
  const path = readStringPath(pathArg);

  if (path === null) {
    ctx.diagnostic({
      severity: "warn",
      code: DIAG_NON_LITERAL_PATH,
      message: `Skipping ${verb.toUpperCase()} route on '${ownerVar}': path is not a static literal`,
      file: ctx.file.path,
      range: locOf(pathArg),
      hint: "Adapters must be sound — rewrite the registration with a string literal, or split into multiple registrations.",
    });
    return;
  }

  const method = verb === "all" ? "*" : verb.toUpperCase();
  const routeId = ctx.id.mint({
    path: ctx.file.path,
    localId: `route::${binding.kind}::${ownerVar}::${method} ${path}`,
  });

  // Resolve the handler first so we can stamp `handlerSymbolId` onto the
  // route node when the cross-adapter contract's optional field applies.
  const handler = args[args.length - 1];
  const handlerInfo = handler ? resolveHandler(handler, method, path, ctx) : null;

  const data: RouteNodeData = {
    method,
    path,
    framework: FRAMEWORK,
    ownerKind: binding.kind,
    ownerVar,
    ...(binding.routerId !== undefined ? { routerId: binding.routerId } : {}),
    ...(handlerInfo?.symbolId !== undefined ? { handlerSymbolId: handlerInfo.symbolId } : {}),
  };

  const routeNode: IrNode<RouteNodeData> = {
    id: routeId,
    kind: NODE_KIND_ROUTE,
    label: `${method} ${path}`,
    data,
    provenance: undefined as never,
  } as IrNode<RouteNodeData>;
  ctx.emit(routeNode);

  if (handlerInfo) {
    emitRouteHandlerEdge(routeId, handlerInfo, method, path, ctx);
  }
}

interface ResolvedHandler {
  /** The IR id used as the edge `to`. May be a deferred ref or a real id. */
  readonly target: IrId;
  /** When the handler resolved to a host-language symbol, the symbol id. */
  readonly symbolId?: IrId;
  /** True iff `target` is a synthesized inline-handler node we just emitted. */
  readonly synthesizedNode: boolean;
}

function resolveHandler(
  handler: AstNodeBase,
  method: string,
  path: string,
  ctx: AnalyzeFileContext,
): ResolvedHandler | null {
  // Inline arrow / function expression: synthesize a handler node.
  if (
    handler.type === "ArrowFunctionExpression" ||
    handler.type === "FunctionExpression"
  ) {
    const fn = handler as AstFunctionLike;
    const handlerId = ctx.id.mint({
      path: ctx.file.path,
      localId: `handler::inline::${method} ${path}`,
    });
    const handlerData: HandlerNodeData = {
      displayName: "anonymous",
      ...(fn.async === true ? { async: true } : {}),
    };
    const handlerNode: IrNode<HandlerNodeData> = {
      id: handlerId,
      kind: NODE_KIND_HANDLER,
      label: `handler (${method} ${path})`,
      data: handlerData,
      provenance: undefined as never,
    } as IrNode<HandlerNodeData>;
    ctx.emit(handlerNode);
    return { target: handlerId, synthesizedNode: true };
  }

  // Identifier handler: `app.get('/x', getUser)`. Use the SDK's symbol
  // table to resolve to the language-indexer's symbol id; fall back to a
  // deferred ref so the resolver can take another pass once cross-file
  // exports are available.
  if (handler.type === "Identifier") {
    const symbol = lookupSymbol(handler, ctx);
    if (symbol) {
      return { target: symbol, symbolId: symbol, synthesizedNode: false };
    }
    const name = (handler as AstIdentifier).name;
    const deferred = ctx.id.ref("match-symbol", { name, file: ctx.file.path });
    return { target: deferred as unknown as IrId, synthesizedNode: false };
  }

  // Member expression: `controllers.user.get`. Try to resolve via symbol
  // index at the start of the dotted path; if that fails, defer.
  if (handler.type === "MemberExpression") {
    const dotted = readDottedPath(handler as AstMemberExpression);
    if (dotted) {
      const deferred = ctx.id.ref("match-dotted-symbol", {
        dotted,
        file: ctx.file.path,
      });
      return { target: deferred as unknown as IrId, synthesizedNode: false };
    }
  }

  // Fully unknown handler shape (e.g. a CallExpression as terminal arg).
  // Don't fabricate; record a diagnostic and move on.
  ctx.diagnostic({
    severity: "warn",
    code: DIAG_UNRESOLVED_HANDLER,
    message: `Unable to resolve handler for ${method} ${path}: terminal arg is a ${handler.type}`,
    file: ctx.file.path,
    range: locOf(handler),
  });
  return null;
}

function emitRouteHandlerEdge(
  routeId: IrId,
  handlerInfo: ResolvedHandler,
  method: string,
  path: string,
  ctx: AnalyzeFileContext,
): void {
  const edgeId = ctx.id.mint({
    path: ctx.file.path,
    localId: `route-handler::${method} ${path}`,
  });
  const edgeData: RouteHandlerEdgeData = { method, path };
  const edge: IrEdge<RouteHandlerEdgeData> = {
    id: edgeId,
    kind: EDGE_KIND_ROUTE_HANDLER,
    from: routeId,
    to: handlerInfo.target,
    data: edgeData,
    provenance: undefined as never,
  } as IrEdge<RouteHandlerEdgeData>;
  ctx.emit(edge);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isJsLike(language: string | null): boolean {
  if (language === null) return false;
  return (
    language === "typescript" ||
    language === "tsx" ||
    language === "javascript" ||
    language === "jsx"
  );
}

/**
 * Tree walker. Adapter-sdk normally exposes a richer visitor API; we use a
 * plain DFS here to keep the adapter dependency-light and inspectable. We
 * recurse over enumerable own properties only — fast, allocation-light,
 * and parser-shape-agnostic (works on Babel and TS-AST out of the box).
 */
function visit(root: AstNodeBase, fn: (n: AstNodeBase) => void): void {
  const stack: AstNodeBase[] = [root];
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top) continue;
    fn(top);
    for (const key in top) {
      const child = (top as Record<string, unknown>)[key];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) {
        for (const item of child) {
          if (isAstNode(item)) stack.push(item);
        }
        continue;
      }
      if (isAstNode(child)) stack.push(child);
    }
  }
}

function isAstNode(v: unknown): v is AstNodeBase {
  return typeof v === "object" && v !== null && typeof (v as AstNodeBase).type === "string";
}

/**
 * Read a string literal or a fully-static template literal. Returns the
 * canonical path string, or `null` if the expression cannot be resolved
 * to a static literal — caller is responsible for diagnostic reporting.
 */
function readStringPath(node: AstNodeBase): string | null {
  if (node.type === "StringLiteral" || node.type === "Literal") {
    const v = (node as AstStringLiteral).value;
    return typeof v === "string" ? v : null;
  }
  if (node.type === "TemplateLiteral") {
    const tmpl = node as AstTemplateLiteral;
    if (tmpl.expressions.length > 0) return null;
    let out = "";
    for (const q of tmpl.quasis) {
      out += q.value.cooked ?? q.value.raw;
    }
    return out;
  }
  return null;
}

/**
 * Read a dotted path like `controllers.user.get` into the array
 * `["controllers", "user", "get"]`. Returns null if any part isn't a
 * plain identifier (e.g. computed access `obj["x"]`).
 */
function readDottedPath(node: AstMemberExpression): string[] | null {
  const out: string[] = [];
  let cur: AstNodeBase = node;
  while (cur.type === "MemberExpression") {
    const m = cur as AstMemberExpression;
    if (m.computed || m.property.type !== "Identifier") return null;
    out.unshift((m.property as AstIdentifier).name);
    cur = m.object;
  }
  if (cur.type !== "Identifier") return null;
  out.unshift((cur as AstIdentifier).name);
  return out;
}

/**
 * Resolve an identifier to a host-language symbol id, if the language
 * indexer has one for it. We use `symbols.atOffset` keyed on the start
 * byte of the identifier — that's where a SymbolRef lives.
 */
function lookupSymbol(node: AstNodeBase, ctx: AnalyzeFileContext): IrId | null {
  const symbols = ctx.file.symbols;
  if (!symbols || !node.loc) return null;
  const found = symbols.atOffset(node.loc.start.byte);
  if (!found) return null;
  // SymbolRef carries `target`; SymbolDef carries `id`. Either is fine.
  if ("target" in found) return found.target;
  return found.id;
}

/**
 * Build a SourceRange from an AST node's `loc`. Shared shape between
 * diagnostics and provenance. Returns a synthetic zero-range when the
 * parser didn't supply location info.
 */
function locOf(node: AstNodeBase): {
  startByte: number;
  endByte: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
} {
  const loc = node.loc;
  if (!loc) {
    return {
      startByte: 0,
      endByte: 0,
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 1,
    };
  }
  return {
    startByte: loc.start.byte,
    endByte: loc.end.byte,
    startLine: loc.start.line,
    startCol: loc.start.column + 1,
    endLine: loc.end.line,
    endCol: loc.end.column + 1,
  };
}

/**
 * Stable iteration over a Map's entries — sorted by key. Necessary for
 * determinism: Map preserves insertion order, but insertion order can vary
 * with parallel parse pipelines or partial caches.
 */
function sortedEntries<V>(m: ReadonlyMap<string, V>): Array<[string, V]> {
  return Array.from(m.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
