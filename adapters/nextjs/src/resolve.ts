/**
 * Cross-file resolution pass for `@codegraph/adapter-nextjs`.
 *
 * This adapter owns the cross-stack `fetch(url) -> http.route` matcher per the
 * contract agreed with adapter-express + adapter-fastapi (spec §9 worked
 * example). Algorithm:
 *
 *   1. For every deferred ref this adapter emitted with kind `"match-route"`,
 *      look up `http.route` nodes from:
 *        - own outputs   (this adapter's nextjs route nodes)
 *        - peers.get("fastapi").nodes("http.route")  (if peer is active)
 *        - peers.get("express").nodes("http.route")  (if peer is active)
 *   2. Exact match first: `(method, path)` after trimming trailing slashes
 *      from both sides and stripping query/hash from the client URL.
 *   3. Regex match second: convert route pattern to regex and test against
 *      the cleaned client URL. Last-segment `*name` -> `.*`; intermediate
 *      `:name` / `{name}` / `*name` -> `[^/]+`. Anchored `^...$`.
 *   4. First match wins; iterate peers in deterministic order
 *      (`own, fastapi, express`) so output is stable across runs.
 *
 * Server-action invocation edges
 * ------------------------------
 *   For every `nextjs.server-action` node this adapter produced, look up the
 *   action's bound symbol's references in the language indexer. Every `call`
 *   reference becomes an `nextjs.action-call` edge from the calling function
 *   to the action node, mirroring the cross-stack semantics of `http.calls`.
 *   This is the moral equivalent of the original `findCallersOf(action.id)`
 *   helper from the prototype.
 */

import type {
  IrEdge,
  IrId,
  IrNode,
  PeerView,
  Provenance,
  ResolveContext,
  SymbolRef,
} from "@codegraph/adapter-sdk";

import {
  EDGE_KIND,
  NODE_KIND,
  REF_KIND_MATCH_ROUTE,
  type ClientCallNodeData,
  type HttpMethod,
  type MatchRouteQuery,
  type RouteNodeData,
  type ServerActionNodeData,
} from "./types.js";

/** Names of peer adapters we read route nodes from. Order is significant: it
 * defines deterministic match-priority when multiple peers expose the same
 * `(method, path)`. */
const PEER_ROUTE_SOURCES = ["fastapi", "express"] as const;

export async function resolve(ctx: ResolveContext): Promise<void> {
  resolveHttpCalls(ctx);
  await emitActionCallEdges(ctx);
}

/* -------------------------------------------------------------------------- */
/*  http.calls resolver                                                       */
/* -------------------------------------------------------------------------- */

function resolveHttpCalls(ctx: ResolveContext): void {
  const sources = collectRouteSources(ctx);

  for (const entry of ctx.deferredRefs) {
    if (entry.ref.kind !== REF_KIND_MATCH_ROUTE) continue;
    const query = entry.ref.query as Partial<MatchRouteQuery>;
    if (!isHttpMethod(query.method) || typeof query.url !== "string") continue;

    const cleanedUrl = stripQueryAndHash(query.url);
    const target = findMatchingRouteId(sources, query.method, cleanedUrl);
    if (target) {
      ctx.resolveEdge({
        edgeId: entry.edgeId,
        endpoint: entry.endpoint,
        target,
      });
    }
    // Misses are intentionally left unresolved — the host turns them into
    // `unresolved-edge` placeholder diagnostics in `finalize`. Authoring an
    // adapter-specific message here would duplicate that machinery.
  }
}

interface RouteSource {
  readonly name: string;
  readonly nodes: ReadonlyArray<IrNode<RouteNodeData>>;
}

function collectRouteSources(ctx: ResolveContext): ReadonlyArray<RouteSource> {
  const sources: RouteSource[] = [];

  // Own routes first — when a Next.js page fetches its own `/api/...` route,
  // the in-repo nextjs route should win over any same-path coincidence.
  sources.push({
    name: "nextjs",
    nodes: ctx.own.nodes<RouteNodeData>(NODE_KIND.ROUTE),
  });

  for (const name of PEER_ROUTE_SOURCES) {
    if (!ctx.peers.has(name)) continue;
    const peer = ctx.peers.get(name);
    sources.push({
      name,
      nodes: peer.nodes<RouteNodeData>(NODE_KIND.ROUTE),
    });
  }

  return sources;
}

function findMatchingRouteId(
  sources: ReadonlyArray<RouteSource>,
  method: HttpMethod,
  cleanedUrl: string,
): IrId | null {
  // Pass 1: exact match across all sources, in declared order.
  for (const source of sources) {
    for (const route of source.nodes) {
      if (!isReachableRoute(source.name, route)) continue;
      if (route.data.method !== method) continue;
      if (normalizePath(route.data.path) === normalizePath(cleanedUrl)) {
        return route.id;
      }
    }
  }

  // Pass 2: regex match.
  for (const source of sources) {
    for (const route of source.nodes) {
      if (!isReachableRoute(source.name, route)) continue;
      if (route.data.method !== method) continue;
      const pattern = routePatternToRegex(route.data.path);
      if (pattern.test(cleanedUrl)) return route.id;
    }
  }

  return null;
}

/**
 * Whether `route` is a routable endpoint we should consider for a static
 * fetch URL match. Filters per-peer:
 *
 * - `express`: drop unreachable orphans (`data.orphan === true`); also drop
 *   the un-composed analyzer-emitted base nodes that adapter-express ships
 *   alongside its composed nodes for router-owned routes. Composed nodes
 *   carry `data.fullPath`; the base nodes do not. App-owned routes pass
 *   through because adapter-express populates `fullPath` for them too.
 * - `fastapi`: drop orphans (when adapter-fastapi tags them).
 * - `nextjs` (own): no filter — every emitted nextjs route is reachable.
 */
function isReachableRoute(
  sourceName: string,
  route: IrNode<RouteNodeData>,
): boolean {
  const data = route.data as RouteNodeData & {
    orphan?: boolean;
    fullPath?: string;
  };
  if (data.orphan === true) return false;
  if (sourceName === "express" && data.fullPath === undefined) return false;
  return true;
}

function normalizePath(p: string): string {
  if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p;
}

function stripQueryAndHash(url: string): string {
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  let cut = url.length;
  if (q >= 0) cut = Math.min(cut, q);
  if (h >= 0) cut = Math.min(cut, h);
  return normalizePath(url.slice(0, cut));
}

/**
 * Convert a normalized route pattern to an anchored regex per the agreed
 * algorithm (`*name` last-segment -> `.*`; otherwise `[^/]+`).
 */
export function routePatternToRegex(routePath: string): RegExp {
  const trimmed = normalizePath(routePath);
  const segments = trimmed.split("/");
  const lastIndex = segments.length - 1;
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.startsWith("*")) {
      out.push(i === lastIndex ? ".*" : "[^/]+");
      continue;
    }
    if (seg.startsWith(":")) {
      out.push("[^/]+");
      continue;
    }
    if (seg.startsWith("{") && seg.endsWith("}")) {
      out.push("[^/]+");
      continue;
    }
    out.push(escapeRegexLiteral(seg));
  }
  return new RegExp("^" + out.join("/") + "$");
}

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHttpMethod(value: unknown): value is HttpMethod {
  return (
    value === "GET" ||
    value === "POST" ||
    value === "PUT" ||
    value === "PATCH" ||
    value === "DELETE" ||
    value === "OPTIONS" ||
    value === "HEAD"
  );
}

/* -------------------------------------------------------------------------- */
/*  action-call edges (the moral findCallersOf)                               */
/* -------------------------------------------------------------------------- */

async function emitActionCallEdges(ctx: ResolveContext): Promise<void> {
  const actions = ctx.own.nodes<ServerActionNodeData>(NODE_KIND.ACTION);
  if (actions.length === 0) return;

  // The ResolveContext gives us read-only access to *its own* nodes/edges and
  // to peer adapter outputs (the language indexer is a peer in the v0.1 model
  // — STRUCTURE.md §6 calls these the host indexers). We resolve callers by
  // walking the language indexer's references for each action's symbol.
  const indexerNames = ["typescript-indexer", "ts-indexer"] as const;
  let indexerView: PeerView | null = null;
  for (const name of indexerNames) {
    if (ctx.peers.has(name)) {
      indexerView = ctx.peers.get(name);
      break;
    }
  }

  for (const action of actions) {
    const symbolId = action.data.symbolId;
    if (!symbolId) continue;

    if (indexerView) {
      const callerIds = collectCallerIds(indexerView, symbolId as IrId);
      for (const callerId of callerIds) {
        ctx.emit({
          id: derivedActionCallEdgeId(ctx, action.id, callerId),
          kind: EDGE_KIND.ACTION_CALL,
          from: callerId,
          to: action.id,
          label: action.data.name,
          data: { action: action.data.name },
          provenance: passthroughProvenance(action.provenance),
        } satisfies IrEdge);
      }
    }
  }
}

/**
 * Look up call-site references to `symbolId` in the language indexer's peer
 * view. v0.1 of the SDK doesn't standardize a "find references" API on
 * `PeerView`, so we walk the indexer's reference edges (kind `"cg.reference"`)
 * and pick out call sites pointing at our symbol. If the indexer instead
 * exposes references in a different shape, this falls back gracefully —
 * unmatched indexers contribute zero callers and nothing breaks.
 */
function collectCallerIds(indexer: PeerView, symbolId: IrId): IrId[] {
  const callers = new Set<IrId>();

  for (const refKind of ["cg.reference", "cg.call", "reference", "call"]) {
    for (const edge of indexer.edges(refKind)) {
      const to = endpointId(edge.to);
      if (to !== symbolId) continue;
      const data = (edge.data ?? {}) as { kind?: string };
      if (data.kind && data.kind !== "call") continue;
      const from = endpointId(edge.from);
      if (from) callers.add(from);
    }
  }

  return [...callers];
}

function endpointId(endpoint: IrEdge["from"]): IrId | null {
  return typeof endpoint === "string" ? (endpoint as IrId) : null;
}

function derivedActionCallEdgeId(
  ctx: ResolveContext,
  actionId: IrId,
  callerId: IrId,
): IrId {
  return ctx.id.mint({
    path: "<resolve>",
    localId: `action-call::${callerId}::${actionId}`,
  });
}

function passthroughProvenance(p: Provenance): Provenance {
  return {
    file: p.file,
    range: p.range,
    adapter: "",
    version: "",
  };
}

// Type guard kept exported for tests of the surrounding adapter package.
export function isClientCallNode(
  node: IrNode,
): node is IrNode<ClientCallNodeData> {
  return node.kind === NODE_KIND.CLIENT_CALL;
}

// Re-export for tests; the SDK's SymbolRef is referenced indirectly via
// indexer edges so we don't need it at runtime, but keeping the type bound
// makes future symbol-driven refinements a one-line change.
export type _SymbolRefBrand = SymbolRef;
