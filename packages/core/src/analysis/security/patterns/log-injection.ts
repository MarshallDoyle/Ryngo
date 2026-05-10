/**
 * `http-input-to-log` — design/security-insights.md §2.5.
 *
 * Off by default. Per §2.5, the actual exploit (newline-injecting fake log
 * lines, ANSI smuggling) is real but rarely material. The PII / secret
 * variants — produced by `pii-leak.ts` — are the high-signal split.
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
      targetFilter: isLogSink,
    });
    for (const hit of hits) {
      if (sanitizers && hit.nodes.some((n) => sanitizers.has(n))) continue;
      const sinkNode = graph.byId.get(hit.nodes[hit.nodes.length - 1]!);
      if (!sinkNode || !isExpressionNode(sinkNode)) continue;

      const score = COMPONENT_SCORE["http-input-to-log"];
      out.push({
        pattern: "http-input-to-log",
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
          note: "user input reaches a log sink (informational only — see pii-to-log / secret-to-log for high-severity splits)",
        },
        suppressionKey: suppressionKey(
          "http-input-to-log",
          handlerId,
          sinkNode.id,
        ),
      });
    }
  }
  return out;
}

function isLogSink(n: Node): boolean {
  if (!isExpressionNode(n)) return false;
  const e = n as ExpressionNode;
  return e.sink?.flavor === "log";
}
