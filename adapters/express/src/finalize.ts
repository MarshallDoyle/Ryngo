/**
 * `finalize` phase for the Express adapter.
 *
 * Last call per spec §3.6. We use it for two narrow jobs:
 *
 *   1. Emit a single `express.summary` node with run-level counters
 *      (route count, router count, orphans). Downstream tools — viewer
 *      legend, CLI summary line, GitHub Action annotation — read this
 *      instead of recomputing the totals.
 *
 *   2. Convert any deferred handler refs the resolver couldn't pin to a
 *      concrete symbol into `unresolved-edge` diagnostics. The host
 *      already turns un-resolved deferred refs into placeholder edges by
 *      default; we add a typed diagnostic so the viewer's "Issues" panel
 *      and the GitHub Action annotation stream get adapter-specific
 *      messaging instead of the host's generic one.
 *
 * No new IR-graph topology is emitted here — only the summary node and
 * diagnostics. Per §6.4 / §3.6 this phase is bounded to ~100ms.
 */

import type { FinalizeContext } from "@codegraph/adapter-sdk";

import {
  DIAG_UNRESOLVED_HANDLER,
  NODE_KIND_FILE_MOUNTS,
  NODE_KIND_ROUTE,
  NODE_KIND_ROUTER,
  NODE_KIND_SUMMARY,
} from "./types.js";
import type { RouteNodeData, RouterNodeData, SummaryNodeData } from "./types.js";

export async function finalize(ctx: FinalizeContext): Promise<void> {
  if (ctx.signal.aborted) return;

  // ---- Counters --------------------------------------------------------
  // We count composed routes (those with `fullPath`) for `routes` because
  // that's what users care about — a router mounted at two prefixes is
  // genuinely two reachable endpoints.
  const allRoutes = ctx.own.nodes<RouteNodeData>(NODE_KIND_ROUTE);
  let routes = 0;
  let orphan = 0;
  for (const r of allRoutes) {
    if (r.data.ownerKind === "app" || r.data.fullPath !== undefined) {
      routes++;
    }
    if (r.data.orphan === true) orphan++;
  }

  const routers = ctx.own.nodes<RouterNodeData>(NODE_KIND_ROUTER).length;

  // ---- Summary node ----------------------------------------------------
  const summaryId = ctx.id.mint({
    path: ctx.config.repoRoot,
    localId: "summary",
  });
  const summaryData: SummaryNodeData = {
    routes,
    routers,
    orphanRouters: orphan,
  };
  ctx.emit({
    id: summaryId,
    kind: NODE_KIND_SUMMARY,
    label: `Express: ${routes} routes, ${routers} routers`,
    data: summaryData,
    provenance: undefined as never,
  });

  // ---- Adapter-specific messaging on still-unresolved refs ------------
  // The host will create generic placeholders for these even if we say
  // nothing. We just upgrade the diagnostic with a hint.
  for (const ref of ctx.stillUnresolved) {
    if (ref.ref.kind !== "match-symbol" && ref.ref.kind !== "match-dotted-symbol") {
      continue;
    }
    ctx.diagnostic({
      severity: "unresolved-edge",
      code: DIAG_UNRESOLVED_HANDLER,
      message: `Express route handler could not be resolved to a host-language symbol`,
      data: { query: ref.ref.query, edgeId: ref.edgeId, endpoint: ref.endpoint },
      hint: "Ensure the handler is declared in scope and exported — see also DIAG_UNRESOLVED_HANDLER docs.",
    });
  }

  // The synthetic per-file mounts carriers were a transport-only mechanism
  // for the resolver. They live in the merged IR (the host doesn't drop
  // adapter nodes for us), but flagging them here keeps the count line
  // honest and lets future viewers hide them via kind.
  void NODE_KIND_FILE_MOUNTS;
}
