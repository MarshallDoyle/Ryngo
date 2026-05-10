/**
 * finalize — last call before the IR is sealed.
 *
 *   - Emits a `http.module` summary node for the whole adapter run with
 *     route/router/app/orphan counts, so the viewer's "Adapters" panel can
 *     show a cheap headline number without scanning the full IR.
 *   - Downgrades any deferred refs that survived `resolve` into
 *     adapter-namespaced `unresolved-edge` diagnostics. The host has its
 *     own generic fallback for this; we override it so the message is
 *     specific to FastAPI cross-service edges.
 */
import type { FinalizeContext } from "@codegraph/adapter-sdk";
import {
  type AdapterState,
  type ModuleSummaryData,
  type RouteData,
  K,
} from "./types.js";

export async function finalize(
  ctx: FinalizeContext,
  state: AdapterState,
): Promise<void> {
  // ----- Counts ----------------------------------------------------------
  const routes = ctx.own.nodes<RouteData>(K.route);
  let routeCount = 0;
  let orphanCount = 0;
  for (const r of routes) {
    routeCount++;
    if (r.data.orphan === true) orphanCount++;
  }
  let appCount = 0;
  let routerCount = 0;
  const seenBindings = new Set<string>();
  for (const fs of state.perFile.values()) {
    for (const [name, b] of fs.bindings) {
      const key = `${fs.file}::${name}`;
      if (seenBindings.has(key)) continue;
      seenBindings.add(key);
      if (b.kind === "app") appCount++;
      else routerCount++;
    }
  }

  ctx.emit({
    id: ctx.id.mint({ path: "<adapter>", localId: "module::fastapi" }),
    kind: K.module,
    label: `FastAPI: ${routeCount} routes`,
    data: {
      framework: "fastapi",
      routeCount,
      routerCount,
      appCount,
      orphanCount,
    } satisfies ModuleSummaryData,
    provenance: {
      file: "<adapter>",
      range: { startByte: 0, endByte: 0, startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
      adapter: "fastapi",
      version: "0.0.0",
    },
  });

  // ----- Surface still-unresolved cross-service refs --------------------
  // Today this list is normally empty: resolve() emits `http.calls` edges
  // eagerly without going through the deferred-ref path. We keep this
  // hook in place because future cross-resolve strategies (e.g. matching
  // a client call to a route via OpenAPI tag) may use deferred refs, and
  // we want the diagnostic shape stable regardless of strategy.
  for (const u of ctx.stillUnresolved) {
    ctx.diagnostic({
      severity: "unresolved-edge",
      code: "fastapi/unresolved-cross-service-edge",
      message: `Could not resolve ${u.ref.kind} for endpoint ${u.endpoint} of edge ${u.edgeId}.`,
      data: u.ref.query as Record<string, unknown>,
    });
  }
}
