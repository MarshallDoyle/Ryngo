/**
 * Forward reachability over the IR.
 *
 * Per `design/dead-code.md` §3:
 *   - Walk only `call`, `import`, `type-flow`, `http-route` edges in the
 *     source -> target direction.
 *   - Skip edges marked `attributes.unresolved` (a single dynamic-dispatch hub
 *     would otherwise mark the universe live).
 *   - Containment propagates *downward only*: a live function pulls its
 *     expressions; a live module does NOT pull its functions.
 *
 * Sink edges (`db-*`, `env-read`, `fs-*`, `network`, `exec`) point at
 * expression leaves with no outgoing live-bearing edges, so walking them is
 * harmless but adds nothing. We exclude them to keep the per-node fan-out
 * small.
 */

import type {
  IR,
  Node,
  Edge,
  NodeId,
  EdgeCategory,
} from "../../ir/types.js";
import type { EntryPointRef } from "./entry-points.js";

/** Edge categories that propagate liveness from source to target. */
export const LIVE_EDGE_CATEGORIES: ReadonlySet<EdgeCategory> = new Set([
  "call",
  "import",
  "type-flow",
  "http-route",
]);

/** Containment direction is downward: parent -> children, not children -> parent. */
type DownwardIndex = Map<NodeId, NodeId[]>;
type OutEdgeIndex = Map<NodeId, Edge[]>;

export interface ReachabilityResult {
  /** Set of live (reachable) node ids. */
  live: Set<NodeId>;
  /** Edges skipped because they were marked unresolved. */
  unresolvedEdges: Edge[];
}

/**
 * Build downward containment index. We walk every node's `parentId` once;
 * `O(V)` and called once per analysis.
 */
function buildContainment(ir: IR): DownwardIndex {
  const downward: DownwardIndex = new Map();
  for (const n of ir.nodes) {
    const parentId = (n as Node & { parentId?: NodeId }).parentId;
    if (!parentId) continue;
    let arr = downward.get(parentId);
    if (!arr) {
      arr = [];
      downward.set(parentId, arr);
    }
    arr.push(n.id);
  }
  return downward;
}

function buildOutEdges(ir: IR): OutEdgeIndex {
  const outIdx: OutEdgeIndex = new Map();
  for (const e of ir.edges) {
    if (!LIVE_EDGE_CATEGORIES.has(e.category)) continue;
    let arr = outIdx.get(e.sourceId);
    if (!arr) {
      arr = [];
      outIdx.set(e.sourceId, arr);
    }
    arr.push(e);
  }
  return outIdx;
}

/** Conservative read: an edge is "unresolved" if any of these flags are set. */
function isUnresolvedEdge(e: Edge): boolean {
  // Per the design (§3.2) the IR carries this hint as `attributes.unresolved`.
  // We also accept the more concise top-level `unresolved` for older analyzer
  // outputs, and a `tags: ['unresolved']` form. All three are
  // forward-compatible no-ops if absent.
  const ee = e as Edge & {
    unresolved?: unknown;
    attributes?: { unresolved?: unknown };
    tags?: string[];
  };
  if (ee.unresolved === true) return true;
  if (ee.attributes && ee.attributes.unresolved === true) return true;
  if (ee.tags && ee.tags.includes("unresolved")) return true;
  return false;
}

/**
 * Forward BFS from the entry set. Returns the live set and any skipped
 * unresolved edges (the caller may surface those as diagnostics).
 */
export function computeReachable(
  ir: IR,
  entries: EntryPointRef[],
): ReachabilityResult {
  const downward = buildContainment(ir);
  const outEdges = buildOutEdges(ir);
  const nodeIds = new Set<NodeId>(ir.nodes.map((n) => n.id));

  const live = new Set<NodeId>();
  const unresolvedEdges: Edge[] = [];
  // Plain array used as a queue. BFS order doesn't matter for correctness here
  // (we only care about reachability, not shortest path), but BFS is friendlier
  // to debug than DFS when traces are inspected.
  const queue: NodeId[] = [];

  for (const e of entries) {
    if (!nodeIds.has(e.nodeId)) continue; // include resolved against a stale IR
    if (live.has(e.nodeId)) continue;
    live.add(e.nodeId);
    queue.push(e.nodeId);
  }

  let head = 0;
  while (head < queue.length) {
    const n = queue[head++];

    // Containment: parent -> children, downward only.
    const children = downward.get(n);
    if (children) {
      for (const c of children) {
        if (!live.has(c)) {
          live.add(c);
          queue.push(c);
        }
      }
    }

    // Live-bearing outgoing edges.
    const outs = outEdges.get(n);
    if (!outs) continue;
    for (const e of outs) {
      if (isUnresolvedEdge(e)) {
        unresolvedEdges.push(e);
        continue;
      }
      if (!nodeIds.has(e.targetId)) continue; // dangling edge
      if (live.has(e.targetId)) continue;
      live.add(e.targetId);
      queue.push(e.targetId);
    }
  }

  return { live, unresolvedEdges };
}

/**
 * Convenience: given a reachability result, partition the function nodes
 * of the IR into (live, candidates). Dead-code reporting is restricted to
 * `function` tier (see design §6).
 */
export function partitionFunctions(
  ir: IR,
  live: Set<NodeId>,
): { liveFunctions: Node[]; candidateDead: Node[] } {
  const liveFunctions: Node[] = [];
  const candidateDead: Node[] = [];
  for (const n of ir.nodes) {
    if (n.tier !== "function") continue;
    if (live.has(n.id)) liveFunctions.push(n);
    else candidateDead.push(n);
  }
  return { liveFunctions, candidateDead };
}
