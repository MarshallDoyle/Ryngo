/**
 * `http-input-to-fs-path` — design/security-insights.md §2.2.
 *
 * Path traversal heuristic: a `type-flow`/`call` reachability path from a
 * route handler to an `fs` sink. Severity is de-ranked one bucket if the path
 * crosses a function whose name matches `^(sanitize|normalize|safe|resolve|validate)Path$`.
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

const PATH_SANITIZER_NAME = /^(sanitize|normalize|safe|resolve|validate)Path$/i;

export function detect(ctx: DetectorContext): Finding[] {
  const { graph, authTracker, sanitizers } = ctx;
  const out: Finding[] = [];

  for (const handlerId of graph.routeHandlers) {
    const auth = authTracker.forHandler(handlerId);
    const hits = bfsAllTargets(graph, handlerId, {
      targetFilter: isFsSink,
    });
    for (const hit of hits) {
      const sinkNode = graph.byId.get(hit.nodes[hit.nodes.length - 1]!);
      if (!sinkNode || !isExpressionNode(sinkNode)) continue;
      // Configured sanitizer wipes the finding entirely.
      if (sanitizers && hit.nodes.some((n) => sanitizers.has(n))) continue;

      const crossesNamedSanitizer = hit.nodes.some((id) => {
        const node = graph.byId.get(id);
        return node?.tier === "function" && PATH_SANITIZER_NAME.test(node.name ?? "");
      });
      let score = COMPONENT_SCORE["http-input-to-fs-path"];
      if (crossesNamedSanitizer) score = Math.max(score - 20, 50);

      out.push({
        pattern: "http-input-to-fs-path",
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
          note: crossesNamedSanitizer
            ? "path crosses a name-matched sanitizer (heuristic, not a guarantee); severity de-ranked"
            : "user-controlled value reaches a filesystem path argument",
        },
        suppressionKey: suppressionKey(
          "http-input-to-fs-path",
          handlerId,
          sinkNode.id,
        ),
      });
    }
  }
  return out;
}

function isFsSink(n: Node): boolean {
  if (!isExpressionNode(n)) return false;
  const e = n as ExpressionNode;
  return e.sink?.flavor === "fs";
}
