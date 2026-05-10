/**
 * `http-input-to-exec` — design/security-insights.md §2.3.
 *
 * Reachability from any route handler to an `exec` sink. Critical baseline.
 * We do not try to distinguish argv[0] from argv[1+]; an attacker-controlled
 * argument is bad enough on its own.
 */
import { isExpressionNode, type ExpressionNode, type Node } from "../../../ir/types.js";
import { bfsAllTargets } from "../graph-index.js";
import type { DetectorContext } from "../index.js";
import {
  COMPONENT_SCORE,
  severityFromScore,
  suppressionKey,
  type Finding,
  type PathStep,
} from "../findings.js";

export function detect(ctx: DetectorContext): Finding[] {
  const { graph, authTracker, sanitizers } = ctx;
  const out: Finding[] = [];

  for (const handlerId of graph.routeHandlers) {
    const auth = authTracker.forHandler(handlerId);
    const hits = bfsAllTargets(graph, handlerId, {
      targetFilter: isExecSink,
    });
    for (const hit of hits) {
      if (sanitizers && hit.nodes.some((n) => sanitizers.has(n))) continue;
      const sinkNode = graph.byId.get(hit.nodes[hit.nodes.length - 1]!);
      if (!sinkNode || !isExpressionNode(sinkNode)) continue;
      const score = COMPONENT_SCORE["http-input-to-exec"];
      const command =
        sinkNode.sink && sinkNode.sink.flavor === "exec"
          ? sinkNode.sink.command
          : undefined;
      out.push({
        pattern: "http-input-to-exec",
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
          sinkLabel: command ? `exec(${command})` : ctx.labelForSink(sinkNode),
          routeAuth: auth?.auth,
          note: "user input reaches a subprocess/shell sink",
        },
        suppressionKey: suppressionKey(
          "http-input-to-exec",
          handlerId,
          sinkNode.id,
        ),
      });
    }
  }
  return out;
}

function isExecSink(n: Node): boolean {
  if (!isExpressionNode(n)) return false;
  const e = n as ExpressionNode;
  return e.sink?.flavor === "exec";
}
