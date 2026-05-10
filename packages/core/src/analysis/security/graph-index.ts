/**
 * Internal graph adjacency / lookup helpers — *not* exported from
 * `index.ts`. Each pattern's `detect()` runs reachability over `type-flow` and
 * `call` edges; this module is the small BFS substrate.
 *
 * If `@codegraph/core/query` ships first, we replace the BFS callsites with
 * `runQuery(ir, "MATCH p = (h:function)-[:call|type-flow*1..K]->(s) ...")`
 * and delete the body of this file. Until then, this file IS the engine.
 */
import {
  isExpressionNode,
  type Edge,
  type ExpressionNode,
  type IR,
  type Node,
  type NodeId,
  type SinkFlavor,
} from "../../ir/types.js";

/** Default reachability bound — matches the `*1..8` in `cgql` examples. */
export const DEFAULT_MAX_HOPS = 8;

/** Edge categories that "carry a value" in the §1 mental model. */
export const PATH_CATEGORIES = new Set<string>(["call", "type-flow"]);

export interface GraphIndex {
  ir: IR;
  byId: Map<NodeId, Node>;
  outEdges: Map<NodeId, Edge[]>;
  inEdges: Map<NodeId, Edge[]>;
  /** Expression nodes by their sink flavor. */
  bySinkFlavor: Map<SinkFlavor, ExpressionNode[]>;
  /** Expression nodes that are leaves (any leaf flavor). */
  httpInputLeaves: ExpressionNode[];
  /** Function/handler nodes that are the source of an `http-route` edge. */
  routeHandlers: NodeId[];
}

export function buildGraphIndex(ir: IR): GraphIndex {
  const byId = new Map<NodeId, Node>();
  const outEdges = new Map<NodeId, Edge[]>();
  const inEdges = new Map<NodeId, Edge[]>();
  const bySinkFlavor = new Map<SinkFlavor, ExpressionNode[]>();
  const httpInputLeaves: ExpressionNode[] = [];

  for (const n of ir.nodes) {
    byId.set(n.id, n);
    if (isExpressionNode(n)) {
      if (n.sink) {
        const list = bySinkFlavor.get(n.sink.flavor) ?? [];
        list.push(n);
        bySinkFlavor.set(n.sink.flavor, list);
      }
      if (n.leaf?.flavor === "http-input") {
        httpInputLeaves.push(n);
      }
    }
  }

  for (const e of ir.edges) {
    pushList(outEdges, e.sourceId, e);
    pushList(inEdges, e.targetId, e);
  }

  const routeHandlerSet = new Set<NodeId>();
  for (const e of ir.edges) {
    if (e.category === "http-route") routeHandlerSet.add(e.sourceId);
  }
  return {
    ir,
    byId,
    outEdges,
    inEdges,
    bySinkFlavor,
    httpInputLeaves,
    routeHandlers: Array.from(routeHandlerSet).sort(),
  };
}

function pushList<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

export interface BfsHit {
  /** Ordered nodes from `start` to `end`, inclusive. */
  nodes: NodeId[];
  /** Edges traversed; `edges[i]` lands on `nodes[i + 1]`. */
  edges: Edge[];
}

export interface BfsOptions {
  /** Edge categories the path may traverse. Default: `call`, `type-flow`. */
  categories?: ReadonlySet<string>;
  /** Maximum hops. Default `DEFAULT_MAX_HOPS`. */
  maxHops?: number;
  /** Optional predicate run on each candidate target node. */
  targetFilter?: (n: Node) => boolean;
  /** Optional predicate to *prune* a node from the frontier (returns true to skip). */
  pruneNode?: (n: Node) => boolean;
}

/**
 * BFS from `start` until any node satisfying `targetFilter` is found. Returns
 * a *single* shortest path or undefined. Determinism: edges are walked in IR
 * order; nodes are visited at most once per BFS run.
 */
export function bfsToTarget(
  g: GraphIndex,
  start: NodeId,
  opts: BfsOptions,
): BfsHit | undefined {
  const categories = opts.categories ?? PATH_CATEGORIES;
  const maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
  const visited = new Set<NodeId>([start]);
  const parent = new Map<NodeId, { prev: NodeId; edge: Edge }>();
  const depth = new Map<NodeId, number>([[start, 0]]);
  const queue: NodeId[] = [start];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = depth.get(cur) ?? 0;
    if (d >= maxHops) continue;
    const out = g.outEdges.get(cur) ?? [];
    for (const e of out) {
      if (!categories.has(e.category)) continue;
      if (visited.has(e.targetId)) continue;
      const tgt = g.byId.get(e.targetId);
      if (!tgt) continue;
      if (opts.pruneNode && opts.pruneNode(tgt)) continue;
      visited.add(e.targetId);
      parent.set(e.targetId, { prev: cur, edge: e });
      depth.set(e.targetId, d + 1);
      if (opts.targetFilter && opts.targetFilter(tgt)) {
        return reconstruct(start, e.targetId, parent);
      }
      queue.push(e.targetId);
    }
  }
  return undefined;
}

/**
 * BFS from `start` and yield ALL targets satisfying `targetFilter` along with
 * one shortest path each. Used when a single source can fan out to many sinks.
 */
export function bfsAllTargets(
  g: GraphIndex,
  start: NodeId,
  opts: BfsOptions,
): BfsHit[] {
  const categories = opts.categories ?? PATH_CATEGORIES;
  const maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
  const visited = new Set<NodeId>([start]);
  const parent = new Map<NodeId, { prev: NodeId; edge: Edge }>();
  const depth = new Map<NodeId, number>([[start, 0]]);
  const queue: NodeId[] = [start];
  const hits: BfsHit[] = [];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = depth.get(cur) ?? 0;
    if (d >= maxHops) continue;
    const out = g.outEdges.get(cur) ?? [];
    for (const e of out) {
      if (!categories.has(e.category)) continue;
      if (visited.has(e.targetId)) continue;
      const tgt = g.byId.get(e.targetId);
      if (!tgt) continue;
      if (opts.pruneNode && opts.pruneNode(tgt)) continue;
      visited.add(e.targetId);
      parent.set(e.targetId, { prev: cur, edge: e });
      depth.set(e.targetId, d + 1);
      if (opts.targetFilter && opts.targetFilter(tgt)) {
        hits.push(reconstruct(start, e.targetId, parent));
      }
      queue.push(e.targetId);
    }
  }
  return hits;
}

function reconstruct(
  start: NodeId,
  end: NodeId,
  parent: Map<NodeId, { prev: NodeId; edge: Edge }>,
): BfsHit {
  const nodes: NodeId[] = [];
  const edges: Edge[] = [];
  let cur: NodeId | undefined = end;
  while (cur && cur !== start) {
    nodes.unshift(cur);
    const p = parent.get(cur);
    if (!p) break;
    edges.unshift(p.edge);
    cur = p.prev;
  }
  nodes.unshift(start);
  return { nodes, edges };
}

/** True if any edge in `path.edges` carries an `unknown` valueType. */
export function pathHasUnknownEdge(path: BfsHit): boolean {
  for (const e of path.edges) {
    if (isUnknownEdgeType(e)) return true;
  }
  return false;
}

export function isUnknownEdgeType(e: Edge): boolean {
  const t = (e as { valueType?: { display?: string } }).valueType;
  if (!t) return false;
  const d = t.display?.toLowerCase();
  return d === "unknown" || d === "any" || d === "interface{}";
}
