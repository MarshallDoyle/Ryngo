/**
 * resolve — global pass after every file has been analyzed.
 *
 * Per the cross-service contract agreed with adapter-nextjs (and adapter-
 * express), fastapi is a *pure producer* of `http.route` nodes. Matching
 * frontend `fetch()` calls to backend routes is the client adapter's job:
 * nextjs walks `peers.get("fastapi").nodes("http.route")` in its own
 * resolve, exact-then-regex matches client URLs, and emits the
 * `http.calls` edges via `ctx.resolveEdge(...)` on its deferred refs.
 * fastapi does not emit `http.calls` edges, period — that would
 * double-emit when nextjs runs.
 *
 * What this phase still does:
 *
 *   1. Compose APIRouter prefixes through `include_router` to a fixed
 *      point. A router can be defined in one file, declared with its own
 *      prefix, and then mounted from one or more parents (an app, or
 *      another router) in entirely different files. We BFS the
 *      include-graph until no new prefixes appear or we hit the safety
 *      bound (32 iterations, far more than any real codebase chains
 *      include_router). The result is, for each binding, the list of
 *      full prefixes it is reachable at from any `app`.
 *
 *   2. Re-emit each route at its full composed path(s). Routers defined
 *      but never mounted are tagged `orphan: true` and surfaced at
 *      their declared prefix so downstream tooling can flag dead code.
 *
 * Design note on re-emit-vs-mutate
 *
 *   The SDK's `resolve` cannot mutate already-emitted nodes in place.
 *   We re-emit each route under a new content-addressed ID containing
 *   the full path. Consumers that scan all `http.route` nodes will see
 *   both the local-path version (from analyzeFile) and the full-path
 *   version (from resolve); IDs differ because the path is part of the
 *   localId. This is verbose but stays within the public interface; if
 *   the host adds `ctx.replace(node)` later, simplifying is mechanical.
 */
import type { IrNode, ResolveContext } from "@codegraph/adapter-sdk";
import {
  type AdapterState,
  type BindingInfo,
  type RouteData,
  K,
} from "./types.js";

export async function resolve(
  ctx: ResolveContext,
  state: AdapterState,
): Promise<void> {
  // -----------------------------------------------------------------------
  // 1. Merge per-file scratch into a global view.
  // -----------------------------------------------------------------------
  // bindings: var-name -> info (last-write wins; same name in two files is
  // already ambiguous in Python without explicit imports, so users who do
  // this are broken regardless of what we choose).
  const bindings = new Map<string, BindingInfo>();
  const includes: Array<{ parentVar: string; childVar: string; extraPrefix: string }> = [];
  for (const fs of state.perFile.values()) {
    for (const [name, b] of fs.bindings) bindings.set(name, b);
    for (const inc of fs.includes) includes.push(inc);
  }

  // -----------------------------------------------------------------------
  // 2. Compute, for each binding, the list of full prefixes it is reachable
  //    at from an `app`. App bindings start at [""]; routers start empty
  //    until propagated. Multiple paths represent multiple include_router
  //    mountings — a router included from two parents shows up twice.
  // -----------------------------------------------------------------------
  const fullPrefixes = new Map<string, string[]>();
  for (const [name, b] of bindings) {
    fullPrefixes.set(name, b.kind === "app" ? [""] : []);
  }

  // Fixed-point BFS. The graph is small (one node per binding) so this is
  // O(passes * includes). 32 passes is far more than any real codebase
  // chains include_router — the safety bound is strictly a runaway-loop
  // guard, not a correctness limit.
  let changed = true;
  let safety = 0;
  while (changed && safety++ < 32) {
    changed = false;
    for (const inc of includes) {
      const parentPrefixes = fullPrefixes.get(inc.parentVar);
      if (!parentPrefixes || parentPrefixes.length === 0) continue;
      const childOwn = bindings.get(inc.childVar)?.prefix ?? "";
      const childPrefixes = fullPrefixes.get(inc.childVar) ?? [];
      for (const p of parentPrefixes) {
        const composed = joinPath(joinPath(p, inc.extraPrefix), childOwn);
        if (!childPrefixes.includes(composed)) {
          childPrefixes.push(composed);
          fullPrefixes.set(inc.childVar, childPrefixes);
          changed = true;
        }
      }
    }
  }
  if (safety >= 32) {
    ctx.diagnostic({
      severity: "warn",
      code: "fastapi/include-router-fixed-point-cap",
      message:
        "include_router prefix composition hit the 32-pass safety cap; some routes may be missing fan-outs.",
      hint: "This usually indicates a cyclic include_router chain, which FastAPI rejects at runtime.",
    });
  }

  // -----------------------------------------------------------------------
  // 3. Re-emit each local-path route as one full-path route per reachable
  //    prefix. Tag orphan routers (defined, never mounted) with
  //    `orphan: true` and surface them at their own declared prefix so
  //    they still show up in the graph.
  // -----------------------------------------------------------------------
  const ownRoutes = ctx.own.nodes<RouteData>(K.route);
  for (const route of ownRoutes) {
    const data = route.data;
    if (data.ownerKind === "app") {
      // FastAPI() takes no prefix, but we honor whatever bindings table
      // says (defensive — third-party FastAPI subclasses sometimes do).
      const ownPrefix = bindings.get(data.ownerVar)?.prefix ?? "";
      emitFullPathRoute(ctx, route, joinPath(ownPrefix, data.path));
      continue;
    }

    const prefixes = fullPrefixes.get(data.ownerVar);
    if (!prefixes || prefixes.length === 0) {
      // Orphan router. Emit at its own prefix and flag.
      const ownPrefix = bindings.get(data.ownerVar)?.prefix ?? "";
      emitFullPathRoute(ctx, route, joinPath(ownPrefix, data.path), { orphan: true });
      continue;
    }

    for (const prefix of prefixes) {
      emitFullPathRoute(ctx, route, joinPath(prefix, data.path));
    }
  }
}

// ---------------------------------------------------------------------------
function emitFullPathRoute(
  ctx: ResolveContext,
  original: IrNode<RouteData>,
  fullPath: string,
  extra: Partial<RouteData> = {},
): void {
  // Skip the no-op case: the local path equals the full path. The original
  // node already reflects reality and re-emitting would be churn.
  if (fullPath === original.data.path && Object.keys(extra).length === 0) return;

  const newId = ctx.id.mint({
    path: original.provenance.file,
    localId: `route::${original.data.method}:${fullPath}@${original.data.ownerVar}`,
  });
  ctx.emit({
    id: newId,
    kind: K.route,
    label: `${original.data.method} ${fullPath}`,
    data: { ...original.data, path: fullPath, ...extra },
    provenance: original.provenance,
  });
}

function joinPath(prefix: string, sub: string): string {
  if (!prefix) return sub;
  if (!sub) return prefix;
  const a = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const b = sub.startsWith("/") ? sub : "/" + sub;
  return a + b;
}
