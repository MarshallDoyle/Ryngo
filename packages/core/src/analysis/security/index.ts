/**
 * `@codegraph/core/analysis/security` — built-in security pattern detector.
 *
 * Public entry point: `runSecurityAnalysis(ir, opts)` returns a deterministic
 * `SecurityResult` per `design/security-insights.md`. Each individual pattern
 * lives under `./patterns/*` as `detect(ctx)`; this module is the orchestrator
 * that builds the shared `DetectorContext`, runs every enabled pattern, and
 * deduplicates findings (the §8.3 secret-vs-unknown-near-sink overlap).
 */
import {
  isExpressionNode,
  isFunctionNode,
  type ExpressionNode,
  type IR,
  type Node,
  type NodeId,
} from "../../ir/types.js";
import {
  buildAuthTracker,
  type AuthTracker,
  type AuthTrackerOptions,
} from "./auth-tracker.js";
import {
  buildGraphIndex,
  bfsAllTargets,
  isUnknownEdgeType,
  type GraphIndex,
} from "./graph-index.js";
import {
  buildPiiRegistry,
  type PiiTypeRegistry,
  type PiiTypeRegistryOptions,
} from "./pii-types.js";
import {
  COMPONENT_SCORE,
  compareFindings,
  severityFromScore,
  suppressionKey,
  type Finding,
  type PatternLabel,
  type SecurityResult,
} from "./findings.js";
import * as sqli from "./patterns/sqli.js";
import * as traversal from "./patterns/traversal.js";
import * as rce from "./patterns/rce.js";
import * as ssrf from "./patterns/ssrf.js";
import * as logInj from "./patterns/log-injection.js";
import * as piiLeak from "./patterns/pii-leak.js";
import * as idor from "./patterns/idor.js";

// --- public exports --------------------------------------------------------

export type {
  Finding,
  PatternLabel,
  PathStep,
  Severity,
  SecurityResult,
  FindingEvidence,
} from "./findings.js";
export { COMPONENT_SCORE, severityFromScore } from "./findings.js";
export type { AuthTracker, AuthState, RouteAuthInfo } from "./auth-tracker.js";
export type { PiiTypeRegistry, PiiTag } from "./pii-types.js";

// --- options ---------------------------------------------------------------

export interface SecurityAnalysisOptions {
  /** Per-pattern toggle. Default = §9 config-surface defaults. */
  patterns?: Partial<Record<PatternLabel, boolean>>;
  auth?: AuthTrackerOptions;
  pii?: PiiTypeRegistryOptions;
  /** Node IDs (or fully-qualified function symbols) of configured sanitizers. */
  sanitizers?: ReadonlyArray<NodeId | string>;
  /** Hostnames legitimately allowed to receive secrets (Stripe, Slack, ...). */
  knownOkOutbounds?: ReadonlyArray<string>;
}

const DEFAULT_PATTERN_ENABLED: Record<PatternLabel, boolean> = {
  "http-input-to-raw-sql": true,
  "http-input-to-fs-path": true,
  "http-input-to-exec": true,
  "http-input-to-outbound-url": true,
  "http-input-to-log": false, // §2.5 — off by default
  "pii-to-log": true,
  "secret-to-log": true,
  "secret-to-network": true,
  "secret-to-exec": true,
  "secret-to-response": true,
  "pii-to-response": true,
  "db-read-to-response-no-auth": true,
  "unauth-sink": true,
  "unknown-near-sink": true,
};

// --- DetectorContext (shared across every pattern) -------------------------

export interface DetectorContext {
  ir: IR;
  graph: GraphIndex;
  authTracker: AuthTracker;
  piiRegistry: PiiTypeRegistry;
  /** Sanitizer node-id set; pattern detectors short-circuit when a path crosses one. */
  sanitizers: ReadonlySet<string>;
  knownOkOutbounds: ReadonlySet<string>;
  /** Render a route's human-readable label, e.g. "POST /api/feedback". */
  labelForRoute(handlerId: NodeId): string;
  /** Render a sink expression's human-readable label, e.g. "db.feedback.insert". */
  labelForSink(sink: ExpressionNode): string;
  /** Render any node's name + path. Generic fallback. */
  labelForNode(nodeId: NodeId): string;
}

// --- entry point -----------------------------------------------------------

export function runSecurityAnalysis(
  ir: IR,
  opts: SecurityAnalysisOptions = {},
): SecurityResult {
  const graph = buildGraphIndex(ir);
  const authTracker = buildAuthTracker(ir, opts.auth ?? {});
  const piiRegistry = buildPiiRegistry(ir, opts.pii ?? {});
  const sanitizers = new Set<string>(opts.sanitizers ?? []);
  const knownOkOutbounds = new Set<string>(
    (opts.knownOkOutbounds ?? []).map((h) => h.toLowerCase()),
  );

  const ctx: DetectorContext = {
    ir,
    graph,
    authTracker,
    piiRegistry,
    sanitizers,
    knownOkOutbounds,
    labelForRoute: (id) => labelForRoute(graph, authTracker, id),
    labelForSink: (sink) => labelForSink(sink),
    labelForNode: (id) => labelForNode(graph, id),
  };

  const enabled = mergePatterns(opts.patterns);
  const findings: Finding[] = [];

  if (enabled["http-input-to-raw-sql"]) findings.push(...sqli.detect(ctx));
  if (enabled["http-input-to-fs-path"]) findings.push(...traversal.detect(ctx));
  if (enabled["http-input-to-exec"]) findings.push(...rce.detect(ctx));
  if (enabled["http-input-to-outbound-url"]) findings.push(...ssrf.detect(ctx));
  if (enabled["http-input-to-log"]) findings.push(...logInj.detect(ctx));
  // pii-leak emits all six §5.2 patterns; filter by per-pattern toggles.
  for (const f of piiLeak.detect(ctx)) if (enabled[f.pattern]) findings.push(f);
  if (enabled["db-read-to-response-no-auth"]) findings.push(...idor.detect(ctx));
  if (enabled["unauth-sink"]) findings.push(...detectUnauthSink(ctx));

  // §4: unknown-typed edges within 2 hops of an effect-warm sink.
  let unknownEdges: Finding[] = [];
  let unknownNearSinkCount = 0;
  if (enabled["unknown-near-sink"]) {
    const r = detectUnknownNearSink(ctx);
    unknownEdges = r.findings;
    unknownNearSinkCount = r.count;
  }
  findings.push(...unknownEdges);

  // §8.3: when the same edge triggers BOTH a Secret-leak finding and an
  // unknown-near-sink finding, the more specific one (Secret) wins.
  const deduped = dedupe(findings);

  deduped.sort(compareFindings);
  return { findings: deduped, unknownNearSinkCount };
}

function mergePatterns(
  override: SecurityAnalysisOptions["patterns"],
): Record<PatternLabel, boolean> {
  if (!override) return { ...DEFAULT_PATTERN_ENABLED };
  return { ...DEFAULT_PATTERN_ENABLED, ...override };
}

// --- §3.2 unauth-sink ------------------------------------------------------

const EFFECT_SINK_FLAVORS = new Set(["db-write", "exec", "fs"]); // fs covers fs-write per IR sink shape

function detectUnauthSink(ctx: DetectorContext): Finding[] {
  const findings: Finding[] = [];
  for (const route of ctx.authTracker.routes()) {
    if (route.auth === "required") continue; // gated route → not interesting
    const hits = bfsAllTargets(ctx.graph, route.handlerId, {
      targetFilter: (n) =>
        isExpressionNode(n) && !!n.sink && EFFECT_SINK_FLAVORS.has(n.sink.flavor),
    });
    for (const hit of hits) {
      const sinkNode = ctx.graph.byId.get(hit.nodes[hit.nodes.length - 1]!);
      if (!sinkNode || !isExpressionNode(sinkNode)) continue;
      const sinkFlavor = sinkNode.sink?.flavor;
      let score = COMPONENT_SCORE["unauth-sink"];
      if (route.auth === "unknown") score = 60;
      // §3.2: high when auth=none and sink is db-write or exec.
      if (route.auth === "none" && (sinkFlavor === "db-write" || sinkFlavor === "exec")) {
        score = 75;
      }
      findings.push({
        pattern: "unauth-sink",
        severity: severityFromScore(score),
        componentScore: score,
        source: route.handlerId,
        sink: sinkNode.id,
        path: hit.nodes.map((nodeId, i) => ({
          nodeId,
          edgeCategory: i === 0 ? undefined : hit.edges[i - 1]!.category,
        })),
        evidence: {
          sourceLabel: ctx.labelForRoute(route.handlerId),
          sinkLabel: ctx.labelForSink(sinkNode),
          routeAuth: route.auth,
          note:
            route.auth === "none"
              ? "no auth middleware detected; route is not in publicRoutes"
              : "route auth unknown — middleware role could not be inferred",
        },
        suppressionKey: suppressionKey(
          "unauth-sink",
          route.handlerId,
          sinkNode.id,
        ),
      });
    }
  }
  return findings;
}

// --- §4 unknown-near-sink --------------------------------------------------

function detectUnknownNearSink(
  ctx: DetectorContext,
): { findings: Finding[]; count: number } {
  const findings: Finding[] = [];
  const seenEdgeKeys = new Set<string>();
  let count = 0;

  for (const e of ctx.ir.edges) {
    if (!isUnknownEdgeType(e)) continue;
    if (e.category !== "type-flow" && e.category !== "call") continue;
    // Within 2 hops of any effect-warm sink?
    const hit = bfsAllTargets(ctx.graph, e.targetId, {
      maxHops: 2,
      targetFilter: (n) => isExpressionNode(n) && isEffectWarmSink(n),
    });
    if (hit.length === 0) continue;
    const sinkNode = ctx.graph.byId.get(hit[0]!.nodes[hit[0]!.nodes.length - 1]!);
    if (!sinkNode || !isExpressionNode(sinkNode)) continue;
    const key = `${e.sourceId}->${e.targetId}->${sinkNode.id}`;
    if (seenEdgeKeys.has(key)) continue;
    seenEdgeKeys.add(key);
    count++;
    const score = COMPONENT_SCORE["unknown-near-sink"];
    findings.push({
      pattern: "unknown-near-sink",
      severity: severityFromScore(score),
      componentScore: score,
      source: e.sourceId,
      sink: sinkNode.id,
      path: [
        { nodeId: e.sourceId },
        { nodeId: e.targetId, edgeCategory: e.category, unknownEdge: true },
        ...hit[0]!.nodes
          .slice(1)
          .map((nodeId, i) => ({
            nodeId,
            edgeCategory: hit[0]!.edges[i]!.category,
          })),
      ],
      evidence: {
        sourceLabel: ctx.labelForNode(e.sourceId),
        sinkLabel: ctx.labelForSink(sinkNode),
        note: "unknown-typed edge lands within 2 hops of an effect-warm sink (§4); not proven to trace from user input",
      },
      suppressionKey: suppressionKey(
        "unknown-near-sink",
        e.sourceId,
        sinkNode.id,
      ),
    });
  }
  return { findings, count };
}

function isEffectWarmSink(n: ExpressionNode): boolean {
  const f = n.sink?.flavor;
  return f === "db-write" || f === "fs" || f === "exec" || f === "network" || f === "log";
}

// --- §8.3 dedup ------------------------------------------------------------

const SECRET_LEAK_PATTERNS: ReadonlySet<PatternLabel> = new Set([
  "secret-to-log",
  "secret-to-network",
  "secret-to-exec",
  "secret-to-response",
]);

function dedupe(findings: Finding[]): Finding[] {
  // If a (sink) is reported by both a Secret-leak finding and an
  // unknown-near-sink finding, drop the unknown-near-sink one.
  const secretSinks = new Set<string>();
  for (const f of findings) {
    if (SECRET_LEAK_PATTERNS.has(f.pattern)) secretSinks.add(f.sink);
  }
  return findings.filter(
    (f) => !(f.pattern === "unknown-near-sink" && secretSinks.has(f.sink)),
  );
}

// --- labels ----------------------------------------------------------------

function labelForRoute(
  g: GraphIndex,
  authTracker: AuthTracker,
  handlerId: NodeId,
): string {
  const info = authTracker.forHandler(handlerId);
  if (info?.method && info.routePath) return `${info.method} ${info.routePath}`;
  if (info?.routePath) return info.routePath;
  // Fallback to the route literal node's value.
  const literal = info ? g.byId.get(info.routeLiteralId) : undefined;
  if (literal && isExpressionNode(literal) && literal.leaf?.flavor === "literal") {
    const v = literal.leaf.value;
    if (typeof v === "string") {
      return info?.method ? `${info.method} ${v}` : v;
    }
  }
  const handler = g.byId.get(handlerId);
  return handler && isFunctionNode(handler)
    ? `handler ${handler.name}`
    : `handler ${handlerId}`;
}

function labelForSink(sink: ExpressionNode): string {
  if (sink.name) return sink.name;
  const flavor = sink.sink?.flavor;
  if (flavor === "db-write") {
    const s = sink.sink as { entity?: string; op?: string };
    if (s.entity && s.op) return `${s.op} ${s.entity}`;
    if (s.entity) return `db.${s.entity}`;
  }
  if (flavor === "log") return "logger.info";
  if (flavor === "network") {
    const s = sink.sink as { url?: string; method?: string };
    return s.url ? `${s.method ?? "fetch"} ${s.url}` : "fetch(...)";
  }
  if (flavor === "exec") return "exec(...)";
  if (flavor === "fs") return "fs.write(...)";
  return `expression ${sink.id.slice(0, 8)}`;
}

function labelForNode(g: GraphIndex, id: NodeId): string {
  const n: Node | undefined = g.byId.get(id);
  if (!n) return id;
  if (n.tier === "expression") {
    const e = n as ExpressionNode;
    if (e.leaf?.flavor === "http-input") {
      return `req.${e.leaf.from}.${e.leaf.field ?? ""}`.replace(/\.$/, "");
    }
    return e.name ?? `expr ${id.slice(0, 8)}`;
  }
  return n.name ?? id;
}
