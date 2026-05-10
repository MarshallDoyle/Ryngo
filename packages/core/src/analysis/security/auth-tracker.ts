/**
 * Auth-boundary tracking — implements `design/security-insights.md` §3.
 *
 * Marks every `http-route` edge in the IR as `required` / `optional` /
 * `none` / `unknown` based on adapter middleware output, JSDoc/decorator
 * annotations, and workspace-config defaults. The result is consumed by
 * `patterns/*` (severity escalation) and by §3.2's `unauth-sink` query.
 *
 * The IR's `HttpRouteEdge` does not carry a typed `auth` field at v0.1,
 * but adapters do stash it in `tags` (e.g. `auth:required`). We honor that
 * convention and provide a single helper so pattern files don't all
 * re-derive the rule.
 */
import {
  isHttpRouteEdge,
  type Edge,
  type HttpRouteEdge,
  type IR,
  type NodeId,
} from "../../ir/types.js";

export type AuthState = "required" | "optional" | "none" | "unknown";

/** Names a middleware that codegraph treats as enforcing auth. */
const AUTH_MIDDLEWARE_PATTERN =
  /^(auth|require|verify|jwt|passport|session|principal|guard|authenticate|authorize)/i;

export interface AuthTrackerOptions {
  /** Routes matching these globs default to `auth=none` (e.g. /health). */
  publicRoutes?: string[];
  /** When true, routes with no explicit auth signal default to `required`. */
  defaultRequired?: boolean;
}

export interface RouteAuthInfo {
  /** The `http-route` edge itself. */
  edge: HttpRouteEdge;
  /** The handler function node id (edge.sourceId). */
  handlerId: NodeId;
  /** The route literal node id (edge.targetId). */
  routeLiteralId: NodeId;
  /** Resolved auth state, after adapter / annotation / config layering. */
  auth: AuthState;
  /** The literal route path string, when known (extracted from tags or edge). */
  routePath?: string;
  method?: string;
}

/** Resolves the priority-ordered auth state for a single route edge. */
export function resolveAuthForEdge(
  edge: HttpRouteEdge,
  opts: AuthTrackerOptions,
): AuthState {
  // 1) Explicit annotation tag wins (`auth:required` / `auth:none` / etc).
  const fromTag = readAuthTag(edge.tags);
  if (fromTag) return fromTag;

  // 2) Adapter middleware inference — adapters tag the edge with
  //    `middleware:requireAuth`, `middleware:passport.authenticate`, etc.
  const fromMiddleware = inferFromMiddleware(edge.tags);
  if (fromMiddleware) return fromMiddleware;

  // 3) Workspace config: publicRoutes glob → none.
  const path = extractRoutePath(edge);
  if (path && matchesAny(path, opts.publicRoutes ?? [])) return "none";

  // 4) Default. With `defaultRequired:true`, fall to `required`; else `unknown`
  //    so we don't escalate severity on routes the adapter genuinely couldn't
  //    classify.
  return opts.defaultRequired ? "required" : "unknown";
}

/** Walk every `http-route` edge in the IR, resolving each to an `AuthState`. */
export function buildAuthTracker(
  ir: IR,
  opts: AuthTrackerOptions = {},
): AuthTracker {
  const byHandler = new Map<NodeId, RouteAuthInfo>();
  const byEdgeKey = new Map<string, RouteAuthInfo>();
  for (const e of ir.edges) {
    if (!isHttpRouteEdge(e)) continue;
    const info: RouteAuthInfo = {
      edge: e,
      handlerId: e.sourceId,
      routeLiteralId: e.targetId,
      auth: resolveAuthForEdge(e, opts),
      routePath: extractRoutePath(e),
      method: e.method,
    };
    byHandler.set(e.sourceId, info);
    byEdgeKey.set(`${e.sourceId}->${e.targetId}`, info);
  }
  return new AuthTracker(byHandler, byEdgeKey);
}

export class AuthTracker {
  constructor(
    private readonly byHandler: Map<NodeId, RouteAuthInfo>,
    private readonly byEdgeKey: Map<string, RouteAuthInfo>,
  ) {}

  /** Lookup auth info for a handler function node. */
  forHandler(handlerId: NodeId): RouteAuthInfo | undefined {
    return this.byHandler.get(handlerId);
  }

  /** Lookup auth info for a specific route edge. */
  forEdge(e: Edge): RouteAuthInfo | undefined {
    return this.byEdgeKey.get(`${e.sourceId}->${e.targetId}`);
  }

  /** All resolved routes. */
  routes(): RouteAuthInfo[] {
    // Stable order: by handler id (NodeId is hex, lex-comparable).
    return Array.from(this.byHandler.values()).sort((a, b) =>
      a.handlerId < b.handlerId ? -1 : a.handlerId > b.handlerId ? 1 : 0,
    );
  }

  /** Routes whose auth state is anything other than `required`. */
  unprotectedRoutes(): RouteAuthInfo[] {
    return this.routes().filter((r) => r.auth !== "required");
  }
}

// ---------- helpers (module-private) ----------

function readAuthTag(tags: string[] | undefined): AuthState | undefined {
  if (!tags) return undefined;
  for (const t of tags) {
    if (t === "auth:required") return "required";
    if (t === "auth:optional") return "optional";
    if (t === "auth:none") return "none";
    if (t === "auth:unknown") return "unknown";
  }
  return undefined;
}

function inferFromMiddleware(
  tags: string[] | undefined,
): AuthState | undefined {
  if (!tags) return undefined;
  let sawMiddleware = false;
  for (const t of tags) {
    if (!t.startsWith("middleware:")) continue;
    sawMiddleware = true;
    const name = t.slice("middleware:".length);
    if (AUTH_MIDDLEWARE_PATTERN.test(name)) return "required";
  }
  // Middleware was present but none looked like an auth gate — call it
  // `unknown` rather than `none` (per §3.1 priority 1).
  return sawMiddleware ? "unknown" : undefined;
}

function extractRoutePath(edge: HttpRouteEdge): string | undefined {
  if (!edge.tags) return undefined;
  for (const t of edge.tags) {
    if (t.startsWith("path:")) return t.slice("path:".length);
  }
  return undefined;
}

function matchesAny(path: string, globs: string[]): boolean {
  for (const g of globs) {
    if (matchesGlob(path, g)) return true;
  }
  return false;
}

/** Tiny glob matcher — supports `*` (segment) and `**` (path). */
function matchesGlob(path: string, pattern: string): boolean {
  const re =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "::DBLSTAR::")
      .replace(/\*/g, "[^/]*")
      .replace(/::DBLSTAR::/g, ".*") +
    "$";
  return new RegExp(re).test(path);
}
