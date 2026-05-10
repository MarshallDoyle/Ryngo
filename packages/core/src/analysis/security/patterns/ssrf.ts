/**
 * `http-input-to-outbound-url` — design/security-insights.md §2.4.
 *
 * Reachability from a route handler to a `network` sink. URL passthrough is
 * common (proxies, webhooks), so we de-rank when the route literal names a
 * known upstream and the sink URL begins with a static hostname.
 */
import {
  isExpressionNode,
  type ExpressionNode,
  type Node,
  type SinkNetwork,
} from "../../../ir/types.js";
import { bfsAllTargets } from "../graph-index.js";
import type { DetectorContext } from "../index.js";
import {
  COMPONENT_SCORE,
  severityFromScore,
  suppressionKey,
  type Finding,
  type PathStep,
} from "../findings.js";

const PROXY_ROUTE_RE = /\/(?:proxy|webhook|forward)\//i;

export function detect(ctx: DetectorContext): Finding[] {
  const { graph, authTracker, sanitizers } = ctx;
  const out: Finding[] = [];

  for (const handlerId of graph.routeHandlers) {
    const auth = authTracker.forHandler(handlerId);
    const hits = bfsAllTargets(graph, handlerId, {
      targetFilter: isNetworkSink,
    });
    for (const hit of hits) {
      if (sanitizers && hit.nodes.some((n) => sanitizers.has(n))) continue;
      const sinkNode = graph.byId.get(hit.nodes[hit.nodes.length - 1]!);
      if (!sinkNode || !isExpressionNode(sinkNode)) continue;
      const sink = sinkNode.sink as SinkNetwork | undefined;

      let score = COMPONENT_SCORE["http-input-to-outbound-url"];
      const routeLabel = ctx.labelForRoute(handlerId);
      const hostname = staticHostname(sink?.url);
      if (hostname && PROXY_ROUTE_RE.test(routeLabel)) {
        score = Math.max(score - 30, 30); // de-rank obvious proxy
      }

      out.push({
        pattern: "http-input-to-outbound-url",
        severity: severityFromScore(score),
        componentScore: score,
        source: handlerId,
        sink: sinkNode.id,
        path: hit.nodes.map((nodeId, i) => ({
          nodeId,
          edgeCategory: i === 0 ? undefined : hit.edges[i - 1]!.category,
        })) satisfies PathStep[],
        evidence: {
          sourceLabel: routeLabel,
          sinkLabel: sink?.url ?? ctx.labelForSink(sinkNode),
          routeAuth: auth?.auth,
          note: hostname
            ? `static hostname prefix detected: ${hostname}`
            : "URL argument flows from user input to outbound request",
        },
        suppressionKey: suppressionKey(
          "http-input-to-outbound-url",
          handlerId,
          sinkNode.id,
        ),
      });
    }
  }
  return out;
}

function isNetworkSink(n: Node): boolean {
  if (!isExpressionNode(n)) return false;
  const e = n as ExpressionNode;
  return e.sink?.flavor === "network";
}

function staticHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/^https?:\/\/([^/?#"]+)/i);
  return m ? m[1] : undefined;
}
