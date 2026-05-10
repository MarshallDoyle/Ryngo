/**
 * `db-read-to-response-no-auth` — design/security-insights.md §2.6.
 *
 * Heuristic IDOR pattern. The IR doesn't tell us "this row belongs to a
 * user," so we lean on adapter / annotation hints: an expression node tagged
 * `tenant-key:<field>` (or any field whose StructuralType carries a
 * `Tenant`-branded segment) marks the row as tenant-keyed.
 *
 * For each route handler that reaches such a tagged db-read, we check
 * whether the same handler ALSO consumes an `auth-context` leaf (a leaf
 * tagged `auth-context` by the auth adapter). If not, we flag — but always
 * with `lowConfidence: true` per §2.6.
 */
import { isExpressionNode, type Node } from "../../../ir/types.js";
import { bfsAllTargets, PATH_CATEGORIES } from "../graph-index.js";
import type { DetectorContext } from "../index.js";
import {
  COMPONENT_SCORE,
  severityFromScore,
  suppressionKey,
  type Finding,
  type PathStep,
} from "../findings.js";

export function detect(ctx: DetectorContext): Finding[] {
  const { graph, authTracker } = ctx;
  const out: Finding[] = [];

  for (const handlerId of graph.routeHandlers) {
    const auth = authTracker.forHandler(handlerId);
    // We only flag when the handler itself enforces no auth-context check.
    if (handlerConsumesAuthContext(graph, handlerId)) continue;

    const hits = bfsAllTargets(graph, handlerId, {
      categories: PATH_CATEGORIES,
      targetFilter: (n) => isTenantKeyedDbRead(n),
    });

    for (const hit of hits) {
      const sinkNode = graph.byId.get(hit.nodes[hit.nodes.length - 1]!);
      if (!sinkNode || !isExpressionNode(sinkNode)) continue;
      const score = COMPONENT_SCORE["db-read-to-response-no-auth"];
      out.push({
        pattern: "db-read-to-response-no-auth",
        severity: severityFromScore(score),
        componentScore: score,
        source: handlerId,
        sink: sinkNode.id,
        path: hit.nodes.map((nodeId, i) => ({
          nodeId,
          edgeCategory: i === 0 ? undefined : hit.edges[i - 1]!.category,
        })) satisfies PathStep[],
        evidence: {
          sourceLabel: ctx.labelForRoute(handlerId),
          sinkLabel: ctx.labelForSink(sinkNode),
          routeAuth: auth?.auth,
          note: "tenant-keyed row reachable from a route that does not consume an auth-context leaf (heuristic, low-confidence per §2.6)",
        },
        lowConfidence: true,
        suppressionKey: suppressionKey(
          "db-read-to-response-no-auth",
          handlerId,
          sinkNode.id,
        ),
      });
    }
  }

  return out;
}

function isTenantKeyedDbRead(n: Node): boolean {
  if (!isExpressionNode(n)) return false;
  if (n.leaf?.flavor !== "db-read") return false;
  const tags = n.tags ?? [];
  return tags.some((t) => t.startsWith("tenant-key:") || t === "tenant-keyed");
}

function handlerConsumesAuthContext(
  g: import("../graph-index.js").GraphIndex,
  handlerId: import("../../../ir/types.js").NodeId,
): boolean {
  const out = g.outEdges.get(handlerId) ?? [];
  for (const e of out) {
    const tgt = g.byId.get(e.targetId);
    if (!tgt) continue;
    if (
      isExpressionNode(tgt) &&
      tgt.tags?.some((t) => t === "auth-context" || t.startsWith("auth-context:"))
    ) {
      return true;
    }
  }
  return false;
}
