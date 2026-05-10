/**
 * Adapter-local IR data shapes for `@codegraph/adapter-nextjs`.
 *
 * These shapes describe the `data` payload of the IR nodes/edges this adapter
 * emits. They are deliberately structural and JSON-serializable — the host
 * persists them verbatim into the IR document and forwards them to peer
 * adapters via `PeerView`.
 *
 * Cross-adapter contract (agreed with adapter-express + adapter-fastapi):
 *   - Route nodes use kind `"http.route"` with normalized colon-style paths.
 *   - Client-call nodes use kind `"http.client-call"`.
 *   - Cross-stack edge kind is `"http.calls"`, resolved via deferred refs.
 */

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD";

export const HTTP_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
]);

export type Framework = "nextjs";

/** Node kinds this adapter emits. Dotted lowercase per spec convention. */
export const NODE_KIND = {
  ROUTE: "http.route",
  PAGE: "nextjs.page",
  ACTION: "nextjs.server-action",
  CLIENT_CALL: "http.client-call",
} as const;

/** Edge kinds this adapter emits. */
export const EDGE_KIND = {
  ROUTE_HANDLER: "http.route-handler",
  PAGE_COMPONENT: "nextjs.page-component",
  ACTION_HANDLER: "nextjs.action-handler",
  ACTION_CALL: "nextjs.action-call",
  HTTP_CALL: "http.calls",
} as const;

/** Diagnostic codes emitted by this adapter. */
export const DIAG_CODE = {
  DYNAMIC_FETCH_URL: "nextjs/dynamic-fetch-url",
  UNKNOWN_HTTP_METHOD: "nextjs/unknown-http-method",
  ROUTE_HANDLER_NOT_FUNCTION: "nextjs/route-handler-not-function",
  UNRESOLVED_HTTP_CALL: "nextjs/unresolved-http-call",
} as const;

/** Deferred-ref kind used by client-call -> route matching. */
export const REF_KIND_MATCH_ROUTE = "match-route" as const;

/**
 * `data` for an `http.route` node. Shape is shared across HTTP adapters
 * (express, fastapi, nextjs) so any adapter can match against any other's
 * routes during cross-stack resolution.
 */
export interface RouteNodeData extends Record<string, unknown> {
  readonly method: HttpMethod;
  /** Fully composed colon-style path, e.g. `/users/:id` or `/blog/*slug`. */
  readonly path: string;
  readonly framework: Framework;
  /** App Router has no router-prefix concept; always "app". */
  readonly ownerKind: "app";
  /** Source of the route, useful for click-to-source (route.ts file path). */
  readonly sourceFile: string;
  /** Name of the export that handles this method (e.g. "GET", "POST"). */
  readonly handlerExport: HttpMethod;
}

/** `data` for a `nextjs.page` node — a rendered React page. */
export interface PageNodeData extends Record<string, unknown> {
  readonly path: string;
  readonly framework: Framework;
  readonly sourceFile: string;
  /** Whether the default export is an async (server) component. */
  readonly async: boolean;
}

/** `data` for a `nextjs.server-action` node. */
export interface ServerActionNodeData extends Record<string, unknown> {
  readonly framework: Framework;
  readonly name: string;
  readonly sourceFile: string;
  /** Module-level `'use server'` vs function-level. */
  readonly directiveScope: "module" | "function";
  /** Symbol id for the action's binding, when resolvable. */
  readonly symbolId?: string;
}

/**
 * `data` for an `http.client-call` node — a `fetch(...)` call with a
 * statically-resolvable URL. Shape is shared across HTTP adapters.
 */
export interface ClientCallNodeData extends Record<string, unknown> {
  readonly method: HttpMethod;
  readonly url: string;
  readonly framework: string;
  /** Source-side caller symbol (when resolvable). */
  readonly callerSymbolId?: string;
}

/**
 * Match query carried in the deferred ref for client-call -> route resolution.
 * Mirrored on every HTTP adapter.
 */
export interface MatchRouteQuery extends Record<string, unknown> {
  readonly method: HttpMethod;
  readonly url: string;
}
