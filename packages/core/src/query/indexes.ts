/**
 * cgql — in-memory store and the six always-on indexes (§7.1, §7.3 of
 * design/query-language.md).
 *
 * Built once at IR load; all subsequent queries reuse the same store.
 * `buildStore` is intentionally side-effect-free over the IR — the IR is
 * never mutated, so an IR shared across queries (or shared between cgql and
 * the security-impl reachability code) stays canonical.
 *
 * Reach-index sketches (§7.3 second half) are deliberately stubbed for
 * v0.1; the opt-in `--build-reach` flag is parked. When that lands the
 * `Store` type gains a `reach?: ReachSketch` field — purely additive.
 */

import {
  isExpressionNode,
  isModuleNode,
  isServiceNode,
} from "../ir/types.js";
import type {
  Edge,
  EdgeCategory,
  ExpressionNode,
  IR,
  LeafFlavor,
  Node,
  NodeId,
  NodeTier,
  SinkFlavor,
} from "../ir/types.js";
import type { EdgeRef } from "./types.js";

// =============================================================================
// Public types
// =============================================================================

/**
 * `byPath` is kept as two parallel arrays sorted by `path` so the planner can
 * locate a prefix range with two binary searches. (Map<string, NodeId[]> is
 * insufficient: globs need range scans, not equality lookups.)
 */
export interface PathIndex {
  paths: string[];
  ids: NodeId[][];
}

export interface Store {
  /** O(1) node lookup. Alias `byId` for §7.3 doc parity. */
  nodes: Map<NodeId, Node>;
  byId: Map<NodeId, Node>;

  /** Canonical edge list — the order edges arrived in the IR. */
  edges: Edge[];

  /** Adjacency, forward and reverse. EdgeRef.index points back into `edges`. */
  outEdges: Map<NodeId, EdgeRef[]>;
  inEdges: Map<NodeId, EdgeRef[]>;

  /** byTier — small categorical index. */
  byTier: Map<NodeTier, NodeId[]>;

  /** bySinkFlavor / byLeafFlavor — only populated for expression nodes. */
  bySinkFlavor: Map<SinkFlavor, NodeId[]>;
  byLeafFlavor: Map<LeafFlavor, NodeId[]>;

  /** byCategory — edges grouped by category for typed traversal. */
  byCategory: Map<EdgeCategory, EdgeRef[]>;

  /** byPath — sorted-by-prefix index used by glob() and STARTS WITH. */
  byPath: PathIndex;

  /** Reachability sketch — opt-in, populated by future --build-reach. */
  // TODO(v0.2): wire reach-index sketches per design §7.3.
  reach?: undefined;
}

// =============================================================================
// Build
// =============================================================================

/**
 * Construct a `Store` from an IR. O(N + E); every node and edge is touched
 * exactly once. Cost is dominated by the byPath sort (N log N) which only
 * runs on tiers that carry a `path` field (service + module).
 */
export function buildStore(ir: IR): Store {
  const nodes = new Map<NodeId, Node>();
  const byTier = new Map<NodeTier, NodeId[]>();
  const bySinkFlavor = new Map<SinkFlavor, NodeId[]>();
  const byLeafFlavor = new Map<LeafFlavor, NodeId[]>();

  // ---------------------------------------------------------------- nodes
  for (const n of ir.nodes) {
    nodes.set(n.id, n);
    pushInto(byTier, n.tier, n.id);

    if (isExpressionNode(n)) {
      const e = n as ExpressionNode;
      if (e.sink && typeof e.sink.flavor === "string") {
        pushInto(bySinkFlavor, e.sink.flavor, n.id);
      }
      if (e.leaf && typeof e.leaf.flavor === "string") {
        pushInto(byLeafFlavor, e.leaf.flavor, n.id);
      }
    }
  }

  // ---------------------------------------------------------------- edges
  // Stable EdgeRef.index = position in ir.edges; this guarantees deterministic
  // ordering downstream (the engine's tie-breaker, §7.5).
  const edges: Edge[] = ir.edges;
  const outEdges = new Map<NodeId, EdgeRef[]>();
  const inEdges = new Map<NodeId, EdgeRef[]>();
  const byCategory = new Map<EdgeCategory, EdgeRef[]>();

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const ref: EdgeRef = {
      sourceId: e.sourceId,
      targetId: e.targetId,
      category: e.category,
      index: i,
    };
    pushInto(outEdges, e.sourceId, ref);
    pushInto(inEdges, e.targetId, ref);
    pushInto(byCategory, e.category, ref);
  }

  // ---------------------------------------------------------------- byPath
  // Only service and module nodes carry a stable file `path`. Sort by path
  // so prefix lookups (glob, STARTS WITH) are a binary-search range.
  const pathy: Array<{ path: string; id: NodeId }> = [];
  for (const n of ir.nodes) {
    if (isServiceNode(n) || isModuleNode(n)) {
      pathy.push({ path: n.path, id: n.id });
    }
  }
  pathy.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byPath: PathIndex = { paths: [], ids: [] };
  let last = "";
  let bucket: NodeId[] | null = null;
  for (const { path, id } of pathy) {
    if (path === last && bucket) {
      bucket.push(id);
    } else {
      bucket = [id];
      byPath.paths.push(path);
      byPath.ids.push(bucket);
      last = path;
    }
  }

  return {
    nodes,
    byId: nodes,
    edges,
    outEdges,
    inEdges,
    byTier,
    bySinkFlavor,
    byLeafFlavor,
    byCategory,
    byPath,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function pushInto<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const cur = m.get(k);
  if (cur) cur.push(v);
  else m.set(k, [v]);
}

/**
 * Lower-bound binary search on `byPath.paths`. Returns the index of the first
 * entry >= `prefix`. Used by the planner to seed STARTS WITH / glob scans.
 */
export function lowerBound(paths: string[], prefix: string): number {
  let lo = 0;
  let hi = paths.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (paths[mid]! < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * All node ids whose path starts with `prefix`. Linear in the matching range
 * after a single binary search.
 */
export function pathPrefixScan(idx: PathIndex, prefix: string): NodeId[] {
  if (prefix.length === 0) return idx.ids.flat();
  const start = lowerBound(idx.paths, prefix);
  const out: NodeId[] = [];
  for (let i = start; i < idx.paths.length; i++) {
    if (!idx.paths[i]!.startsWith(prefix)) break;
    for (const id of idx.ids[i]!) out.push(id);
  }
  return out;
}
