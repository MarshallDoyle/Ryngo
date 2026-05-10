/**
 * Adapter-private types for `@codegraph/adapter-express`.
 *
 * Two layers of types live here:
 *
 * 1. **AST shapes.** Structural subtypes the analyzer pulls off whatever AST
 *    the host hands us via `@codegraph/adapter-sdk` walk helpers. We never
 *    import the full TypeScript or Babel node types — adapters work on
 *    shape, not on a particular parser's wire format. Anything we can't
 *    structurally recognize is treated as opaque.
 *
 * 2. **IR `data` payloads.** The shapes that ride on `IrNode.data` /
 *    `IrEdge.data`. The host validates these against this adapter's
 *    declared schema (when one is supplied); keep them strictly
 *    JSON-serializable: no functions, no class instances, no `undefined`
 *    inside arrays.
 */

import type { IrId } from "@codegraph/adapter-sdk";

// ---------------------------------------------------------------------------
// HTTP method vocabulary
// ---------------------------------------------------------------------------

/**
 * HTTP verbs Express exposes as method calls on `app` / `Router`. `use` is
 * NOT in this list — it is handled separately as a sub-router mount, never
 * as a route registration. `all` is included because Express implements it
 * as a real method and users sometimes reach for it.
 */
export const HTTP_VERBS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "all",
] as const;

export type HttpVerb = (typeof HTTP_VERBS)[number];

/** Set wrapper (avoids `.includes()` allocation in hot paths). */
const HTTP_VERB_SET: ReadonlySet<string> = new Set<string>(HTTP_VERBS);

export function isHttpVerb(s: string): s is HttpVerb {
  return HTTP_VERB_SET.has(s);
}

// ---------------------------------------------------------------------------
// Adapter node and edge kinds
//
// `http.route` is the shared contract kind across the HTTP adapters
// (express, fastapi, nextjs); any of them can read the others' route
// nodes via `ctx.peers.get(name).nodes("http.route")`. Other kinds we
// emit are private to express and use the `express.` prefix.
//
// Cross-stack `fetch -> route` edges are NOT emitted by this adapter.
// adapter-nextjs is the producer-of-record for `http.calls` edges; this
// adapter is producer-only of `http.route` nodes.
// ---------------------------------------------------------------------------

export const NODE_KIND_ROUTE = "http.route" as const;
export const NODE_KIND_HANDLER = "express.handler" as const;
export const NODE_KIND_ROUTER = "express.router" as const;
export const NODE_KIND_SUMMARY = "express.summary" as const;
export const NODE_KIND_FILE_MOUNTS = "express.file-mounts" as const;

export const EDGE_KIND_ROUTE_HANDLER = "express.route-handler" as const;

/** Framework discriminator carried on shared `http.route` nodes. */
export const FRAMEWORK = "express" as const;

// ---------------------------------------------------------------------------
// Diagnostic codes
// ---------------------------------------------------------------------------

export const DIAG_NON_LITERAL_PATH = "express/route-path-not-literal" as const;
export const DIAG_UNRESOLVED_HANDLER = "express/handler-unresolved" as const;
export const DIAG_ORPHAN_ROUTER = "express/router-not-mounted" as const;

// ---------------------------------------------------------------------------
// IR `data` payloads emitted by the adapter
// ---------------------------------------------------------------------------

/**
 * Whether a route is owned by an `app` (Express application — full path is
 * final) or a `Router` (relative path — needs prefix composition in
 * `resolve`).
 */
export type OwnerKind = "app" | "router";

/**
 * `data` shape on shared `http.route` nodes after `analyzeFile`. Some
 * fields (notably `path`) may still be partial at this point — they are
 * finalized in `resolve` when mount prefixes are composed.
 *
 * Cross-adapter contract (locked with adapter-nextjs):
 *   - `method`, `path`, `framework` are required and read by the matcher.
 *   - `handlerSymbolId` is optional and used for downstream call-graph
 *     joins. Set when we resolved the handler to a host-language symbol.
 *   - Everything else (`fullPath`, `ownerKind`, `ownerVar`, `routerId`,
 *     `dynamic`, `orphan`) is express-private; peers ignore it.
 */
export interface RouteNodeData extends Record<string, unknown> {
  /** Uppercased HTTP verb, e.g. "GET". `*` for `app.all(...)`. */
  readonly method: string;
  /**
   * Path as written at the registration site. May be relative when
   * `ownerKind === "router"`; the resolver fans out one route per mount
   * prefix and stamps `fullPath` accordingly.
   *
   * Express paths are already colon-style (`:id`, `*splat`) — no
   * normalization needed at emit-time per the cross-adapter contract.
   */
  readonly path: string;
  /** Required by the cross-adapter contract; always `"express"`. */
  readonly framework: typeof FRAMEWORK;
  /**
   * Composed full path, populated in `resolve`. Same as `path` when the
   * route is owned by an `app` (no composition needed).
   */
  readonly fullPath?: string;
  /** Host-language symbol id of the handler, when statically resolvable. */
  readonly handlerSymbolId?: IrId;
  readonly ownerKind: OwnerKind;
  /** Local variable name of the receiver (`app`, `userRouter`, …). */
  readonly ownerVar: string;
  /** True if the route's path was non-literal and we skipped extracting it. */
  readonly dynamic?: boolean;
  /** True if the owning router was never mounted. */
  readonly orphan?: boolean;
  /** Local id of the corresponding `express.router` node, when relevant. */
  readonly routerId?: IrId;
}

/**
 * `data` for `express.router` nodes. We emit one router node per
 * `express.Router()` (or `Router()`) binding so that route -> router and
 * router -> mount-prefix relations are explicit in the graph.
 */
export interface RouterNodeData extends Record<string, unknown> {
  /** Local variable name the Router was bound to. */
  readonly varName: string;
  /** Unmodifiable list of full mount prefixes; populated in `resolve`. */
  readonly prefixes?: ReadonlyArray<string>;
}

/**
 * Synthesized handler nodes — used when the handler argument is an inline
 * arrow / function expression and there's no language-indexer symbol to
 * point at. For named identifier or member-expression handlers we link
 * directly to the language indexer's symbol via a deferred ref instead.
 */
export interface HandlerNodeData extends Record<string, unknown> {
  /** "anonymous", or the dotted source like "controllers.users.list". */
  readonly displayName: string;
  /** True if the underlying callable is async. */
  readonly async?: boolean;
}

/** `data` payload on the route-handler edge. */
export interface RouteHandlerEdgeData extends Record<string, unknown> {
  readonly method: string;
  readonly path: string;
}

/** Summary node emitted in `finalize`. One per repo. */
export interface SummaryNodeData extends Record<string, unknown> {
  readonly routes: number;
  readonly routers: number;
  readonly orphanRouters: number;
}

/** Internal payload for the synthetic `express.file-mounts` carrier node. */
export interface FileMountsNodeData extends Record<string, unknown> {
  readonly mounts: ReadonlyArray<MountRecord>;
}

// ---------------------------------------------------------------------------
// Per-file scratch state
//
// Accumulated during the file walk and consumed at the bottom of
// `analyzeFile`. Kept structurally simple so the host can serialize it
// across worker-thread boundaries without a custom codec.
// ---------------------------------------------------------------------------

/** Local-binding kinds we track. */
export type BindingKind = OwnerKind;

export interface AppBinding {
  readonly kind: BindingKind;
  /** The router IR id (only set for `kind === "router"`). */
  readonly routerId?: IrId;
}

export interface MountRecord {
  /** Path passed to `app.use('/api', router)`. Can be `""` for `app.use(router)`. */
  readonly prefix: string;
  /** Local variable name of the router being mounted. */
  readonly routerVar: string;
  /** Local variable name of the receiver (`app`, or another router for nesting). */
  readonly mountedOn: string;
  /** Provenance file. Routers can be mounted in a different file from where they're defined. */
  readonly file: string;
}

// ---------------------------------------------------------------------------
// Minimal AST shape contracts
//
// These match the shapes produced by the SDK's AST normalizer. They are
// purely structural, so the same code works against TS, Babel, or any
// other ESTree-shaped parser the SDK adds in the future. Anything we don't
// recognize structurally is treated as opaque (we emit a diagnostic and
// skip — never fabricate a path).
// ---------------------------------------------------------------------------

export interface AstLoc {
  readonly start: { line: number; column: number; byte: number };
  readonly end: { line: number; column: number; byte: number };
}

export interface AstNodeBase {
  readonly type: string;
  readonly loc?: AstLoc;
}

export interface AstIdentifier extends AstNodeBase {
  readonly type: "Identifier";
  readonly name: string;
}

export interface AstStringLiteral extends AstNodeBase {
  readonly type: "StringLiteral" | "Literal";
  readonly value: string | number | boolean | null;
}

export interface AstTemplateLiteral extends AstNodeBase {
  readonly type: "TemplateLiteral";
  readonly quasis: ReadonlyArray<{ readonly value: { readonly cooked?: string; readonly raw: string } }>;
  readonly expressions: ReadonlyArray<AstNodeBase>;
}

export interface AstMemberExpression extends AstNodeBase {
  readonly type: "MemberExpression";
  readonly object: AstNodeBase;
  readonly property: AstNodeBase;
  readonly computed: boolean;
}

export interface AstCallExpression extends AstNodeBase {
  readonly type: "CallExpression";
  readonly callee: AstNodeBase;
  readonly arguments: ReadonlyArray<AstNodeBase>;
}

export interface AstFunctionLike extends AstNodeBase {
  readonly type:
    | "ArrowFunctionExpression"
    | "FunctionExpression"
    | "FunctionDeclaration";
  readonly async?: boolean;
  readonly params: ReadonlyArray<AstNodeBase>;
}

export interface AstVariableDeclarator extends AstNodeBase {
  readonly type: "VariableDeclarator";
  readonly id: AstNodeBase;
  readonly init: AstNodeBase | null;
}

export interface AstImportDeclaration extends AstNodeBase {
  readonly type: "ImportDeclaration";
  readonly source: AstStringLiteral;
  readonly specifiers: ReadonlyArray<AstNodeBase>;
}
