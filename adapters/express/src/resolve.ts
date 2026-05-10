/**
 * `resolve` phase for the Express adapter.
 *
 * One job: **mount-prefix composition.** Routes registered against a
 * `Router` need their declared paths joined with the mount prefixes from
 * every place that router was attached (`app.use('/api', router)`). A
 * router can be mounted at multiple prefixes; we fan the route out — one
 * composed route node per (router-route × mount-prefix). Routers nested
 * inside other routers compose transitively.
 *
 * What we DO NOT do here:
 *
 *   - Match frontend `fetch(...)` calls to routes. adapter-nextjs is the
 *     producer-of-record for cross-stack `http.calls` edges (see contract
 *     with adapter-nextjs). Express is producer-only of `http.route`
 *     nodes; the matcher reads ours via `peers.get("express")`.
 *   - Resolve deferred handler refs. Those become `unresolved-edge`
 *     placeholders by the host's default policy when no `resolveEdge`
 *     call lands. (We don't currently have a cross-file symbol resolver;
 *     a future pass can add one once language-indexer exports are
 *     queryable from `ctx`.)
 *
 * Determinism notes:
 *   - We sort everything we iterate over (routes, routers, mounts). The
 *     host hands us peer arrays in deterministic order, but we re-sort
 *     defensively because mount prefixes can be discovered in either
 *     order across files.
 *   - Composed route IDs include the mount prefix in their localId so
 *     they remain stable across runs even when the mount-discovery order
 *     changes.
 */

import type { IrId, IrNode, ResolveContext } from "@codegraph/adapter-sdk";

import {
  DIAG_ORPHAN_ROUTER,
  NODE_KIND_FILE_MOUNTS,
  NODE_KIND_ROUTE,
  NODE_KIND_ROUTER,
} from "./types.js";
import type {
  FileMountsNodeData,
  MountRecord,
  RouteNodeData,
  RouterNodeData,
} from "./types.js";

/**
 * Maximum depth we follow when composing nested routers, just so a
 * pathological self-mount cycle doesn't hang the resolver. We always
 * dedupe on the (router, prefix) pair so genuine recursion is broken;
 * this cap is paranoia for adversarial inputs.
 */
const MAX_MOUNT_NESTING = 16;

export async function resolve(ctx: ResolveContext): Promise<void> {
  if (ctx.signal.aborted) return;

  // -------- 1. Collect mount records --------------------------------------
  // `analyzeFile` stowed mounts on synthetic `express.file-mounts` nodes
  // so that mounts cross the analyze-file boundary. Pull them all in.
  const mountsByRouter = collectMounts(ctx);

  // Build the full set of prefixes for each router, transitively. A router
  // mounted onto another router inherits the parent's mount prefixes.
  const routerNodes = sortNodes(
    ctx.own.nodes<RouterNodeData>(NODE_KIND_ROUTER),
    (n) => n.id,
  );
  const prefixesByRouter = composePrefixes(routerNodes, mountsByRouter);

  // -------- 2. Compose routes --------------------------------------------
  // For each route owned by a router, fan out one composed route per
  // resolved prefix. App-owned routes already have their final path; we
  // leave their analyzer-emitted node alone (re-emitting would duplicate
  // the IR id) but the matcher reads `data.fullPath ?? data.path`, so
  // peers don't need to special-case ownerKind on our side either.
  const allRoutes = sortNodes(
    ctx.own.nodes<RouteNodeData>(NODE_KIND_ROUTE),
    (n) => n.id,
  );

  for (const route of allRoutes) {
    if (route.data.ownerKind === "app") continue;

    const prefixes = prefixesByRouter.get(route.data.ownerVar);
    if (!prefixes || prefixes.length === 0) {
      // Orphan: defined on a router that was never mounted. Emit a single
      // composed route with `orphan: true` so downstream tools can flag it
      // — never drop a route silently.
      ctx.diagnostic({
        severity: "warn",
        code: DIAG_ORPHAN_ROUTER,
        message: `Router '${route.data.ownerVar}' carries route ${route.data.method} ${route.data.path} but is never mounted`,
        ...(route.provenance?.file ? { file: route.provenance.file } : {}),
        ...(route.provenance?.range ? { range: route.provenance.range } : {}),
      });
      emitComposedRoute(route, "", { orphan: true }, ctx);
      continue;
    }

    for (const prefix of prefixes) {
      emitComposedRoute(route, prefix, {}, ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// Mount collection
// ---------------------------------------------------------------------------

/**
 * Scan synthetic `express.file-mounts` nodes for their carried
 * `MountRecord[]` and group by router variable name.
 *
 * Cross-file mounts (file A mounts a router variable from file B's
 * exports) are common in real apps. We index by router var name only;
 * disambiguating by file would prevent legitimate composition. The
 * analyzer phase already checks that the local binding resolves to a
 * router declared in scope, so two unrelated files that each have a
 * `userRouter` will both compose against any matching mount.
 */
function collectMounts(ctx: ResolveContext): Map<string, MountRecord[]> {
  const out = new Map<string, MountRecord[]>();
  const fileMountNodes = ctx.own.nodes<FileMountsNodeData>(NODE_KIND_FILE_MOUNTS);
  for (const node of fileMountNodes) {
    for (const m of node.data.mounts) {
      const arr = out.get(m.routerVar) ?? [];
      arr.push(m);
      out.set(m.routerVar, arr);
    }
  }
  // Sort each list for deterministic prefix order.
  for (const [k, arr] of out) {
    arr.sort((a, b) => {
      if (a.prefix !== b.prefix) return a.prefix < b.prefix ? -1 : 1;
      if (a.mountedOn !== b.mountedOn) return a.mountedOn < b.mountedOn ? -1 : 1;
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
    });
    out.set(k, arr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prefix composition
// ---------------------------------------------------------------------------

/**
 * Given `routerVar -> [mounts]`, compute `routerVar -> [fully-composed
 * prefixes]`. Mounts onto another router compose transitively; mounts
 * onto an `app` are roots and contribute their literal prefix.
 *
 * We treat `mountedOn === <other router var>` as a parent edge in a DAG.
 * Self-mounts and cycles are broken by `seen` tracking.
 */
function composePrefixes(
  routers: ReadonlyArray<IrNode<RouterNodeData>>,
  mountsByRouter: ReadonlyMap<string, ReadonlyArray<MountRecord>>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const router of routers) {
    const varName = router.data.varName;
    const prefixes = computePrefixesFor(varName, mountsByRouter, new Set<string>(), 0);
    // Dedupe + sort for deterministic fan-out.
    const unique = Array.from(new Set(prefixes)).sort();
    if (unique.length > 0) result.set(varName, unique);
  }

  return result;
}

function computePrefixesFor(
  varName: string,
  mountsByRouter: ReadonlyMap<string, ReadonlyArray<MountRecord>>,
  seen: Set<string>,
  depth: number,
): string[] {
  if (depth >= MAX_MOUNT_NESTING) return [];
  if (seen.has(varName)) return [];
  seen.add(varName);

  const mounts = mountsByRouter.get(varName) ?? [];
  if (mounts.length === 0) {
    seen.delete(varName);
    return [];
  }

  const out: string[] = [];
  for (const m of mounts) {
    // Mounted directly onto a router we already know? Walk up.
    const parentPrefixes = mountsByRouter.has(m.mountedOn)
      ? computePrefixesFor(m.mountedOn, mountsByRouter, seen, depth + 1)
      : [""]; // mounted on an app or unknown — treat as root
    for (const p of parentPrefixes) {
      out.push(joinPath(p, m.prefix));
    }
  }
  seen.delete(varName);
  return out;
}

// ---------------------------------------------------------------------------
// Route fan-out emission
// ---------------------------------------------------------------------------

function emitComposedRoute(
  base: IrNode<RouteNodeData>,
  prefix: string,
  extra: { orphan?: boolean },
  ctx: ResolveContext,
): void {
  const fullPath = joinPath(prefix, base.data.path);

  // Stable id derived from `(file, ownerVar, mountPrefix, method,
  // localPath)`, per the cross-adapter ID contract with adapter-nextjs.
  // Crucially we do NOT include the base route id — that would let an
  // unrelated change to the analyzer's local-id format ripple into every
  // composed id. The five components above are the route's intrinsic
  // identity in the IR; adding a third mount prefix to the same router
  // does not perturb the existing two composed ids.
  const file = base.provenance?.file ?? "<unknown>";
  const composedId = ctx.id.mint({
    path: file,
    localId: `route-composed::${file}::${base.data.ownerVar}::${prefix}::${base.data.method}::${base.data.path}`,
  });

  const data: RouteNodeData = {
    method: base.data.method,
    path: base.data.path,
    framework: base.data.framework,
    fullPath,
    ownerKind: base.data.ownerKind,
    ownerVar: base.data.ownerVar,
    ...(base.data.routerId !== undefined ? { routerId: base.data.routerId } : {}),
    ...(base.data.handlerSymbolId !== undefined
      ? { handlerSymbolId: base.data.handlerSymbolId }
      : {}),
    ...(extra.orphan === true ? { orphan: true as const } : {}),
  };

  const node: IrNode<RouteNodeData> = {
    id: composedId,
    kind: NODE_KIND_ROUTE,
    label: `${base.data.method} ${fullPath}`,
    data,
    provenance: base.provenance,
  };
  ctx.emit(node);
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function joinPath(prefix: string, sub: string): string {
  if (!prefix) return sub.startsWith("/") || sub === "" ? sub : "/" + sub;
  const a = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (!sub) return a || "/";
  const b = sub.startsWith("/") ? sub : "/" + sub;
  return a + b;
}

function sortNodes<T extends { id: IrId }>(
  nodes: ReadonlyArray<T>,
  key: (n: T) => string,
): T[] {
  return [...nodes].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
