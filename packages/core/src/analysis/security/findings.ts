/**
 * Structured `Finding` type emitted by every security pattern detector, plus
 * the small helpers used by `index.ts` and individual pattern files.
 *
 * Shape is governed by `design/security-insights.md` §6 — the PR-comment
 * renderer (`packages/core/src/pr-comment`) consumes `SecurityResult.findings`
 * and groups them under the "Security insights" section. Severity numbers
 * come from §6.2's component-score table.
 */
import type { EdgeCategory, NodeId } from "../../ir/types.js";

export type Severity = "low" | "medium" | "high" | "critical";

/** Pattern-label union — matches the §2 / §6.2 tables. */
export type PatternLabel =
  | "http-input-to-raw-sql"
  | "http-input-to-fs-path"
  | "http-input-to-exec"
  | "http-input-to-outbound-url"
  | "http-input-to-log"
  | "pii-to-log"
  | "secret-to-log"
  | "secret-to-network"
  | "secret-to-exec"
  | "secret-to-response"
  | "pii-to-response"
  | "db-read-to-response-no-auth"
  | "unauth-sink"
  | "unknown-near-sink";

export interface PathStep {
  nodeId: NodeId;
  /** Category of the edge that landed on this node from the previous step. */
  edgeCategory?: EdgeCategory;
  /** True when this hop traversed an `unknown`-typed edge (per §4). */
  unknownEdge?: boolean;
}

export interface FindingEvidence {
  /** Human-readable source label, e.g. "POST /api/feedback" or "req.query.q". */
  sourceLabel: string;
  /** Human-readable sink label, e.g. "db.feedback.insert" or "logger.info". */
  sinkLabel: string;
  /** Auth state of the entry route, when applicable. */
  routeAuth?: "required" | "optional" | "none" | "unknown";
  /** SQL classification on the sink site, when applicable. */
  classification?: "raw-sql" | "parameterized" | "unknown";
  /** Free-form note for the renderer (e.g. "no sanitizer on path"). */
  note?: string;
}

export interface Finding {
  pattern: PatternLabel;
  severity: Severity;
  /** Component score from §6.2 — drives the PR header severity rollup. */
  componentScore: number;
  source: NodeId;
  sink: NodeId;
  /** Ordered nodes from source to sink, inclusive on both ends. */
  path: PathStep[];
  /** Tag carried along the path: "Secret" | "Pii" | type display string. */
  typeCarried?: string;
  evidence: FindingEvidence;
  /** §2.6 — IDOR-style heuristic findings are explicitly low-confidence. */
  lowConfidence?: boolean;
  /** Stable key used by suppression UI: `${pattern}|${sourceId}|${sinkId}`. */
  suppressionKey: string;
}

export interface SecurityResult {
  findings: Finding[];
  /** Count of `unknown`-typed edges within 2 hops of an effect-warm sink (§4). */
  unknownNearSinkCount: number;
}

/** Build a stable suppression key. Renderer uses it for "dismiss" links. */
export function suppressionKey(
  pattern: PatternLabel,
  sourceId: NodeId,
  sinkId: NodeId,
): string {
  return `${pattern}|${sourceId}|${sinkId}`;
}

/** §6.2 component-score lookup. Single source of truth for the rubric. */
export const COMPONENT_SCORE: Record<PatternLabel, number> = {
  "http-input-to-raw-sql": 80,
  "http-input-to-fs-path": 75,
  "http-input-to-exec": 95,
  "http-input-to-outbound-url": 70,
  "http-input-to-log": 30,
  "pii-to-log": 60,
  "secret-to-log": 90,
  "secret-to-network": 90,
  "secret-to-exec": 95,
  "secret-to-response": 90,
  "pii-to-response": 60,
  "db-read-to-response-no-auth": 55,
  "unauth-sink": 75,
  "unknown-near-sink": 50,
};

/** Map a component score to a severity label (rough buckets per §6.2). */
export function severityFromScore(score: number): Severity {
  if (score >= 90) return "critical";
  if (score >= 70) return "high";
  if (score >= 50) return "medium";
  return "low";
}

/**
 * Total ordering used by `index.ts` to keep `findings` deterministic. Two runs
 * over the same IR must produce byte-identical result envelopes (per the
 * project-wide determinism rule).
 */
export function compareFindings(a: Finding, b: Finding): number {
  if (a.componentScore !== b.componentScore) {
    return b.componentScore - a.componentScore; // highest first
  }
  if (a.pattern !== b.pattern) return a.pattern < b.pattern ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.sink !== b.sink) return a.sink < b.sink ? -1 : 1;
  return 0;
}
