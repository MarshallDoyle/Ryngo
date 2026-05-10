/**
 * Local types for the FastAPI adapter.
 *
 * These are NOT part of the IR schema; the IR schema lives in
 * `@codegraph/core` and is consumed by adapters via `@codegraph/adapter-sdk`.
 * What we keep here is:
 *   - the per-file scratch state shape we accumulate during `analyzeFile`,
 *     stashed on the per-adapter side-channel so `resolve` can pick it up;
 *   - the `data` payload shapes we attach to the IR nodes/edges we emit
 *     (fully JSON-serializable, as required by the adapter SDK).
 *
 * Naming: kinds emitted by this adapter are dotted-lowercase under the
 * `http.*` namespace so peer adapters (express, nextjs, http-client) can
 * filter by kind without caring which server framework produced the node.
 * This is the cross-service edge-shape contract shared with adapter-express
 * and adapter-nextjs. fastapi is a pure *producer* of `http.route` nodes;
 * the client-side adapter (nextjs, http-client) owns the fetch→route
 * matching pass and emits `http.calls` edges.
 */
import type {
  IrId,
  IrNode,
  NodeKind,
  EdgeKind,
  Provenance,
} from "@codegraph/adapter-sdk";

// ---------------------------------------------------------------------------
// HTTP method (closed enum — the FastAPI surface only exposes these verbs as
// decorator method names).
// ---------------------------------------------------------------------------
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD";

export const HTTP_VERBS: ReadonlyArray<Lowercase<HttpMethod>> = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
];

// ---------------------------------------------------------------------------
// Kinds. Exported so peer adapters can `peers.get("fastapi").nodes(K.route)`
// without stringly-typing. fastapi only emits the producer-side kinds —
// `http.calls` is owned by the client adapter (nextjs).
// ---------------------------------------------------------------------------
export const K = {
  route: "http.route" as NodeKind,
  module: "http.module" as NodeKind,
  handler: "http.handler" as EdgeKind,
} as const;

// ---------------------------------------------------------------------------
// Path normalization (cross-service contract with adapter-nextjs / adapter-express)
// ---------------------------------------------------------------------------

/**
 * Normalize a FastAPI path template to the colon-style canonical form used
 * by every consumer of `http.route` nodes:
 *
 *     /users/{id}                 → /users/:id
 *     /items/{item_id:int}        → /items/:item_id
 *     /static/{rest:path}         → /static/*rest          (last segment only)
 *     /a/{x:path}/b               → /a/:x/b                (intermediate :path
 *                                                           treated as single
 *                                                           segment — FastAPI
 *                                                           itself rejects this
 *                                                           at runtime, but be
 *                                                           defensive)
 *
 * The matcher in the client adapter (nextjs) translates `:name` → `[^/]+`
 * and last-segment `*name` → `.*`. By doing the FastAPI-specific
 * translation here, we keep that translation single-sourced.
 */
export function normalizeRoutePath(raw: string): string {
  // Split on `/` so we can detect last-segment vs. intermediate `:path`
  // converters. Empty segments (leading/trailing `/`, double `//`) are
  // preserved so the rejoined string round-trips.
  const segments = raw.split("/");
  const lastIdx = segments.length - 1;
  return segments
    .map((seg, i) => {
      // Match a single placeholder occupying the entire segment.
      const m = /^\{([^}:]+)(?::([^}]+))?\}$/.exec(seg);
      if (!m) return seg;
      const name = m[1]!;
      const converter = m[2];
      if (converter === "path" && i === lastIdx) return `*${name}`;
      return `:${name}`;
    })
    .join("/");
}

// ---------------------------------------------------------------------------
// IR node / edge data payloads
// ---------------------------------------------------------------------------

/**
 * Where the route lives. APIRouter routes carry the binding's *own* prefix
 * but get an additional prefix via `include_router(prefix=...)` in resolve.
 * App-mounted routes are final (FastAPI() takes no `prefix`).
 */
export type OwnerKind = "app" | "router";

/**
 * A pydantic-flavored type shape pulled from a parameter or `response_model`
 * kwarg. We keep this opaque (the host's py-indexer fills it) — the adapter
 * just records what it found.
 */
export interface TypeShape {
  /** "pydantic-model" | "primitive" | "list" | "dict" | "union" | "unknown". */
  readonly kind: string;
  /** Best-effort display name (e.g. "User", "list[User]"). */
  readonly display: string;
  /** When kind === "pydantic-model": fully-qualified class name. */
  readonly fqName?: string;
}

export type ParamLocation = "path" | "query" | "body" | "header" | "cookie";

export interface RouteParam {
  readonly in: ParamLocation;
  readonly name: string;
  readonly type: TypeShape;
  readonly required?: boolean;
}

export interface RouteData extends Record<string, unknown> {
  readonly framework: "fastapi";
  readonly method: HttpMethod;
  /**
   * Path the route serves, normalized to colon-style placeholders
   * (`/users/:id`, last-segment splat `*rest`). FastAPI's native `{name}`
   * and `{name:type}` syntax is normalized at emit-time per the
   * cross-service contract with adapter-express and adapter-nextjs:
   * consumers of `http.route` (notably nextjs's fetch→route matcher) need
   * exactly one regex translation, not one per server framework. Type
   * info from `{name:int}` lives on the corresponding `RouteParam.type`.
   *
   * During `analyzeFile` this is the local path. `resolve` rewrites it to
   * the full composed path after prefix composition.
   */
  readonly path: string;
  readonly ownerKind: OwnerKind;
  /** The Python variable name the decorator was hung off (e.g. "app",
   *  "user_router"). Used by `resolve` to look up the binding's prefix. */
  readonly ownerVar: string;
  readonly params: ReadonlyArray<RouteParam>;
  readonly requestBody?: TypeShape;
  readonly responseType?: TypeShape;
  readonly statusCode?: number;
  readonly tags?: ReadonlyArray<string>;
  /**
   * Optional symbol id of the handler function. Populated eagerly when the
   * host's py-indexer surfaces a symbol for the decorated function;
   * otherwise omitted (rather than fabricated). Lets downstream tools
   * join the route to call-graph nodes without dereferencing the
   * separate `http.handler` edge.
   */
  readonly handlerSymbolId?: IrId;
  /** True when set by `resolve` for a router that was defined but never
   *  mounted from an app via `include_router`. Downstream tooling can flag
   *  these as dead code. */
  readonly orphan?: boolean;
}

export interface ModuleSummaryData extends Record<string, unknown> {
  readonly framework: "fastapi";
  readonly routeCount: number;
  readonly routerCount: number;
  readonly appCount: number;
  readonly orphanCount: number;
}

// Convenience aliases — same shapes, narrower payloads.
export type RouteNode = IrNode<RouteData>;
export type ModuleSummaryNode = IrNode<ModuleSummaryData>;

// ---------------------------------------------------------------------------
// Per-file scratch state
// ---------------------------------------------------------------------------

/**
 * What `analyzeFile` records about each Python module. We can't just emit
 * routes and forget — the cross-file `resolve` pass needs the file's
 * binding table and `include_router` calls to compose final paths.
 *
 * We stash these on the adapter's side-channel via `ctx.emit({...})` for the
 * routes themselves, and via a private state map keyed by file path for
 * the binding/include scaffolding. The state lives on the adapter object's
 * `__state` symbol; the adapter SDK sandbox isolates this per-run.
 */
export interface BindingInfo {
  readonly kind: OwnerKind;
  /** Prefix declared at construction: `APIRouter(prefix="/users")`. The app
   *  binding itself has no prefix concept — FastAPI() takes none. */
  readonly prefix: string;
}

export interface IncludeInfo {
  readonly parentVar: string;
  readonly childVar: string;
  /** Extra prefix passed to `include_router(child, prefix=...)`. */
  readonly extraPrefix: string;
}

/**
 * A router-owned route captured in `analyzeFile` and held until `resolve`
 * can compose the full path(s).
 *
 * Per the cross-service contract with adapter-nextjs, fastapi emits exactly
 * one `http.route` node per `(router × mount-prefix)` — and zero local-path
 * nodes for router-owned routes. App-owned routes are emitted directly
 * from `analyzeFile` because their paths are already final. This keeps
 * matchers in client adapters from accidentally hitting a prefix-relative
 * placeholder when the URL only matches the composed path.
 *
 * The shape is fully serializable (no AST nodes, no closures). All the
 * AST-side resolution (handler symbol, parameter type shapes) happens in
 * `analyzeFile` so this record can survive the worker-thread boundary
 * the SDK uses between phases.
 */
export interface PendingRouterRoute {
  readonly method: HttpMethod;
  /** Local path — already normalized to colon-style. `resolve` joins it
   *  with each composed prefix to produce the final `RouteData.path`. */
  readonly localPath: string;
  readonly ownerVar: string;
  readonly params: ReadonlyArray<RouteParam>;
  readonly requestBody?: TypeShape;
  readonly responseType?: TypeShape;
  readonly statusCode?: number;
  readonly tags?: ReadonlyArray<string>;
  /** Resolved at analyze time; passed through to the emitted node and edge. */
  readonly handlerSymbolId?: IrId;
  /** Display name for the `http.handler` edge label. */
  readonly handlerFqName?: string;
  /** Provenance is captured from the AST node in `analyzeFile`; resolve
   *  reuses it for both the route node and the handler edge. */
  readonly provenance: Provenance;
}

export interface FileState {
  readonly file: string;
  readonly bindings: Map<string, BindingInfo>;
  readonly includes: IncludeInfo[];
  /** App-owned route IDs minted in this file. Router-owned routes are NOT
   *  in here — they live in `pendingRouterRoutes` until `resolve` mints
   *  one ID per `(router × mount-prefix)`. */
  readonly routeIds: IrId[];
  /** Router-owned routes captured by analyzeFile; finalized in `resolve`. */
  readonly pendingRouterRoutes: PendingRouterRoute[];
}

/**
 * The shared mutable state the adapter carries across phases. Lives on the
 * adapter instance returned by the factory (there is one instance per run).
 *
 * Per the adapter SDK contract (§6.2), no module-level mutable state — but
 * adapter-instance state IS allowed because the SDK gives each run a fresh
 * adapter instance from the factory.
 */
export interface AdapterState {
  /** file path -> per-file scratch */
  readonly perFile: Map<string, FileState>;
}

export function makeAdapterState(): AdapterState {
  return { perFile: new Map() };
}
