/**
 * `http-input-to-raw-sql` — design/security-insights.md §2.1.
 *
 * Reachability question: is there a path through `type-flow` / `call` edges
 * from a route handler (or its `http-input` leaf) to a `db-read`/`db-write`
 * sink whose adapter classification is `raw-sql`?
 */
import { isExpressionNode, type ExpressionNode } from "../../../ir/types.js";
import {
  bfsAllTargets,
  pathHasUnknownEdge,
} from "../graph-index.js";
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
      targetFilter: (n) => isRawSqlSink(n),
    });
    for (const hit of hits) {
      // Skip if a configured sanitizer sits on the path.
      if (pathCrossesSanitizer(hit.nodes, sanitizers)) continue;
      const sinkNode = graph.byId.get(hit.nodes[hit.nodes.length - 1]!);
      if (!sinkNode || !isExpressionNode(sinkNode)) continue;
      const path: PathStep[] = hit.nodes.map((nodeId, i) => {
        const edge = i === 0 ? undefined : hit.edges[i - 1];
        return {
          nodeId,
          edgeCategory: edge?.category,
          unknownEdge: edge ? edgeIsUnknown(edge) : false,
        };
      });
      const baseScore = COMPONENT_SCORE["http-input-to-raw-sql"];
      // Severity escalates if any edge on the path is `unknown`.
      const score = pathHasUnknownEdge(hit) ? Math.min(baseScore + 10, 95) : baseScore;
      out.push({
        pattern: "http-input-to-raw-sql",
        severity: severityFromScore(score),
        componentScore: score,
        source: handlerId,
        sink: sinkNode.id,
        path,
        evidence: {
          sourceLabel: ctx.labelForRoute(handlerId),
          sinkLabel: ctx.labelForSink(sinkNode),
          routeAuth: auth?.auth,
          classification: "raw-sql",
          note: "raw SQL string built via concatenation/interpolation; no parameterized binding detected on this path",
        },
        suppressionKey: suppressionKey(
          "http-input-to-raw-sql",
          handlerId,
          sinkNode.id,
        ),
      });
    }
  }

  return out;
}

/** A `db-read` / `db-write` sink whose adapter classification is `raw-sql`. */
function isRawSqlSink(n: import("../../../ir/types.js").Node): boolean {
  if (!isExpressionNode(n)) return false;
  const e = n as ExpressionNode;
  if (!e.sink) return false;
  if (e.sink.flavor !== "db-write" && e.leaf?.flavor !== "db-read") {
    // db-read sinks are encoded as leaves in v0.1; we still surface them via
    // the leaf side. db-write sinks are the sink-side check.
    if (e.sink.flavor !== "db-write") return false;
  }
  return hasTag(e.tags, "classification:raw-sql") || hasTag(e.tags, "raw-sql");
}

function hasTag(tags: string[] | undefined, t: string): boolean {
  return !!tags && tags.includes(t);
}

function pathCrossesSanitizer(
  nodes: readonly import("../../../ir/types.js").NodeId[],
  sanitizers: ReadonlySet<string> | undefined,
): boolean {
  if (!sanitizers || sanitizers.size === 0) return false;
  for (const id of nodes) if (sanitizers.has(id)) return true;
  return false;
}

function edgeIsUnknown(e: import("../../../ir/types.js").Edge): boolean {
  const t = (e as { valueType?: { display?: string } }).valueType;
  const d = t?.display?.toLowerCase();
  return d === "unknown" || d === "any";
}
