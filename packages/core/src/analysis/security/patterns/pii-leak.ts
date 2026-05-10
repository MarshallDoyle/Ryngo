/**
 * PII / Secret leak patterns — design/security-insights.md §5.2.
 *
 * One detector function emits all six §5.2 patterns:
 *   `secret-to-log`, `secret-to-network`, `secret-to-exec`, `secret-to-response`,
 *   `pii-to-log`, `pii-to-response`.
 *
 * Sources are nodes the registry has tagged `Pii` or `Secret`. Sinks are
 * `log`, `network`, `exec`, plus the special "response of an `http-route`"
 * sink (any expression child of a route handler whose `role` looks like a
 * response write — encoded as `tag:response`).
 *
 * Per §5.3 the registry's tag is propagated through *one* `unknown`-typed
 * hop — losing PII/Secret at every unknown boundary would gut the feature.
 * That's enforced in `bfsTagged` below: an unknown edge consumes the
 * "one-hop budget" for the rest of the walk.
 */
import {
  isExpressionNode,
  type Edge,
  type ExpressionNode,
  type Node,
  type NodeId,
} from "../../../ir/types.js";
import {
  isUnknownEdgeType,
  PATH_CATEGORIES,
  type GraphIndex,
} from "../graph-index.js";
import type { DetectorContext } from "../index.js";
import type { PiiTag } from "../pii-types.js";
import {
  COMPONENT_SCORE,
  severityFromScore,
  suppressionKey,
  type Finding,
  type PathStep,
  type PatternLabel,
} from "../findings.js";

export function detect(ctx: DetectorContext): Finding[] {
  const { graph, piiRegistry, authTracker, sanitizers, knownOkOutbounds } = ctx;
  const out: Finding[] = [];
  const tagged = piiRegistry.taggedNodes();

  for (const [sourceId, tag] of Array.from(tagged.entries()).sort(byKey)) {
    const hits = bfsTagged(graph, sourceId, sanitizers);
    for (const { sinkNode, path, edges } of hits) {
      const label = labelFor(tag, sinkNode);
      if (!label) continue;

      // Secret → outbound network: skip if the destination is in the
      // known-OK allowlist (§5.2 "Known-OK outbounds for secrets").
      if (label === "secret-to-network" && knownOkOutbounds) {
        const sinkUrl =
          sinkNode.sink?.flavor === "network" ? sinkNode.sink.url : undefined;
        if (sinkUrl && knownOkOutbounds.has(hostnameOf(sinkUrl))) continue;
      }

      const score = COMPONENT_SCORE[label];
      const routeAuth = nearestRouteAuth(graph, sourceId, ctx);
      out.push({
        pattern: label,
        severity: severityFromScore(score),
        componentScore: score,
        source: sourceId,
        sink: sinkNode.id,
        typeCarried: tag,
        path: path.map((nodeId, i) => ({
          nodeId,
          edgeCategory: i === 0 ? undefined : edges[i - 1]!.category,
          unknownEdge: i === 0 ? false : isUnknownEdgeType(edges[i - 1]!),
        })) satisfies PathStep[],
        evidence: {
          sourceLabel: ctx.labelForNode(sourceId),
          sinkLabel: ctx.labelForSink(sinkNode),
          routeAuth: label === "pii-to-response" ? routeAuth ?? "unknown" : routeAuth,
          note: edges.some(isUnknownEdgeType)
            ? `${tag} tag propagated through an unknown-typed hop (single-hop budget; §5.3)`
            : `${tag}-tagged value reaches a ${sinkNode.sink?.flavor ?? "response"} sink`,
        },
        suppressionKey: suppressionKey(label, sourceId, sinkNode.id),
      });
    }
  }
  return out;
}

interface TaggedHit {
  sinkNode: ExpressionNode;
  path: NodeId[];
  edges: Edge[];
}

/**
 * BFS from a tagged source. Unlike the generic `bfsAllTargets`, this version:
 *  - tracks an "unknown-hop budget" — the tag survives at most ONE unknown
 *    edge on any given path (§5.3),
 *  - admits *any* sink flavor as a target (caller decides which findings to
 *    emit per tag).
 */
function bfsTagged(
  g: GraphIndex,
  start: NodeId,
  sanitizers: ReadonlySet<string> | undefined,
): TaggedHit[] {
  type State = { node: NodeId; budget: 0 | 1 };
  const visited = new Map<string, true>();
  const parent = new Map<string, { prev: string; edge: Edge }>();
  const startKey = `${start}|1`;
  visited.set(startKey, true);
  const queue: State[] = [{ node: start, budget: 1 }];
  const hits: TaggedHit[] = [];
  const MAX_HOPS = 10;
  const depth = new Map<string, number>([[startKey, 0]]);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curKey = `${cur.node}|${cur.budget}`;
    const d = depth.get(curKey) ?? 0;
    if (d >= MAX_HOPS) continue;
    if (sanitizers?.has(cur.node)) continue;
    const out = g.outEdges.get(cur.node) ?? [];
    for (const e of out) {
      if (!PATH_CATEGORIES.has(e.category)) continue;
      const isUnknown = isUnknownEdgeType(e);
      let nextBudget: 0 | 1 = cur.budget;
      if (isUnknown) {
        if (cur.budget === 0) continue; // tag already lost
        nextBudget = 0;
      }
      const tgt = g.byId.get(e.targetId);
      if (!tgt) continue;
      const tgtKey = `${tgt.id}|${nextBudget}`;
      if (visited.has(tgtKey)) continue;
      visited.set(tgtKey, true);
      parent.set(tgtKey, { prev: curKey, edge: e });
      depth.set(tgtKey, d + 1);
      if (isExpressionNode(tgt) && tgt.sink) {
        hits.push(reconstructTagged(start, tgt, parent));
      }
      queue.push({ node: tgt.id, budget: nextBudget });
    }
  }
  return hits;
}

function reconstructTagged(
  start: NodeId,
  end: ExpressionNode,
  parent: Map<string, { prev: string; edge: Edge }>,
): TaggedHit {
  const path: NodeId[] = [end.id];
  const edges: Edge[] = [];
  let cur = `${end.id}|0`;
  if (!parent.has(cur)) cur = `${end.id}|1`;
  while (cur && !cur.startsWith(`${start}|`)) {
    const p = parent.get(cur);
    if (!p) break;
    edges.unshift(p.edge);
    const prevNodeId = p.prev.split("|")[0]! as NodeId;
    path.unshift(prevNodeId);
    cur = p.prev;
  }
  return { sinkNode: end, path, edges };
}

function labelFor(tag: PiiTag, sink: ExpressionNode): PatternLabel | undefined {
  const flavor = sink.sink?.flavor;
  if (tag === "Secret") {
    if (flavor === "log") return "secret-to-log";
    if (flavor === "network") return "secret-to-network";
    if (flavor === "exec") return "secret-to-exec";
    if (sinkIsHttpResponse(sink)) return "secret-to-response";
    return undefined;
  }
  // Pii
  if (flavor === "log") return "pii-to-log";
  if (sinkIsHttpResponse(sink)) return "pii-to-response";
  return undefined;
}

function sinkIsHttpResponse(n: ExpressionNode): boolean {
  return !!n.tags?.includes("sink:http-response");
}

function hostnameOf(url: string): string {
  const m = url.match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1]!.toLowerCase() : url.toLowerCase();
}

function nearestRouteAuth(
  g: GraphIndex,
  nodeId: NodeId,
  ctx: DetectorContext,
): "required" | "optional" | "none" | "unknown" | undefined {
  // Walk parents up to the enclosing function; ask the auth tracker.
  let cur: Node | undefined = g.byId.get(nodeId);
  while (cur) {
    if (cur.tier === "function") {
      const info = ctx.authTracker.forHandler(cur.id);
      if (info) return info.auth;
    }
    if (!cur.parentId) break;
    cur = g.byId.get(cur.parentId);
  }
  return undefined;
}

function byKey<T>(a: [string, T], b: [string, T]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}
