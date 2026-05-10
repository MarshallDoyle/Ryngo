/**
 * Severity scoring for the graph diff.
 *
 * Mirrors `design/diff-algorithm.md` §6:
 *   - per-record signal weights (§6.1, table)
 *   - score → bucket (§6.2: >=10 critical, >=6 high, >=3 medium, else low)
 *   - severity is an ordering hint for `summary.topItems`, not a verdict (§6.3)
 *
 * The output of severity scoring is byte-deterministic. Ties on score are
 * broken by `ref` ascending — see `compareScored` below.
 */

import type {
  Edge,
  ExpressionNode,
  FunctionNode,
  Node,
  NodeId,
  TypeRef,
} from "../ir/types.js";
import {
  isExpressionNode,
  isFunctionNode,
} from "../ir/types.js";
import type {
  AddedEdge,
  AddedNode,
  ChangedEdge,
  ChangedNode,
  RemovedEdge,
  RemovedNode,
  ScoredItem,
  SeverityBucket,
  SeverityConfig,
  SideTables,
} from "./types.js";

// =============================================================================
// Defaults — §6.1
// =============================================================================

export const DEFAULT_SEVERITY_CONFIG: Required<SeverityConfig> = {
  newNetworkSink: 6,
  newCrossServiceEdge: 6,
  newDbWriteSink: 5,
  newExecSink: 7,
  newFsWriteSink: 4,
  newHttpRoute: 5,
  changedValueTypeSensitive: 6,
  changedValueTypeOther: 1,
  newEdgeIntoTaggedNode: 5,
  removedHttpRoute: 4,
  newEffectfulFunctionWithSink: 2,
  newPureFunction: 0,
  newDeadFunction: 1,
  otherAdd: 1,
  otherRemove: 1,
  locOnly: 0,

  securitySensitiveTypes: [
    "User", "Session", "Credentials",
    "ApiKey", "Token", "Payment",
    "Card", "BankAccount", "SSN",
  ],

  sensitiveNodeTags: ["auth", "payment"],
};

/** Resolve user overrides against the defaults. Missing keys fall through. */
export function resolveSeverityConfig(
  partial?: SeverityConfig,
): Required<SeverityConfig> {
  if (!partial) return DEFAULT_SEVERITY_CONFIG;
  return { ...DEFAULT_SEVERITY_CONFIG, ...partial };
}

// =============================================================================
// Bucketing — §6.2
// =============================================================================

export function bucketForScore(score: number): SeverityBucket {
  if (score >= 10) return "critical";
  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  return "low";
}

// =============================================================================
// Scoring helpers
// =============================================================================

function typeRefMentionsSensitive(
  t: TypeRef | null | undefined,
  sensitive: readonly string[],
): boolean {
  if (!t) return false;
  const display = t.display.toLowerCase();
  for (const s of sensitive) {
    if (display.includes(s.toLowerCase())) return true;
  }
  return false;
}

/**
 * Walk up the node parent chain to find the enclosing `service` tier id.
 * Used by the cross-service-edge weight. Stops at the first `service` node;
 * returns null if the chain doesn't reach a service (e.g. an `x-` tier).
 */
function serviceIdOf(nodeId: NodeId, nodes: Map<NodeId, Node>): NodeId | null {
  let cursor: NodeId | undefined = nodeId;
  // Bound the walk; the IR is strictly tiered (≤ 5 hops).
  for (let i = 0; i < 16; i++) {
    if (!cursor) return null;
    const n = nodes.get(cursor);
    if (!n) return null;
    if (n.tier === "service") return n.id;
    // `parentId` is optional only for service tier; otherwise required.
    cursor = (n as { parentId?: NodeId }).parentId;
  }
  return null;
}

/** Has this node a tag the user marked sensitive (default: auth/payment). */
function nodeIsTagSensitive(
  node: Node,
  sensitiveTags: readonly string[],
): boolean {
  const tags = (node as { tags?: string[] }).tags;
  if (!tags || tags.length === 0) return false;
  for (const t of tags) {
    if (sensitiveTags.includes(t)) return true;
  }
  return false;
}

/** True if any descendant `expression` of `fn` carries a sink. We approximate
 *  "descendant" as "expression node whose ancestor chain contains `fn.id`",
 *  computed iteratively from the parent map. */
function functionHasDescendantSink(
  fn: FunctionNode,
  nodes: Map<NodeId, Node>,
): boolean {
  // Build a children list keyed by parentId on demand. For correctness we walk
  // every expression once — cheap because expressions dominate the count and
  // we are only consulted for the (usually small) set of newly-added functions.
  for (const n of nodes.values()) {
    if (!isExpressionNode(n)) continue;
    if (!hasAncestor(n, fn.id, nodes)) continue;
    if ((n as ExpressionNode).sink) return true;
  }
  return false;
}

function hasAncestor(
  start: Node,
  ancestorId: NodeId,
  nodes: Map<NodeId, Node>,
): boolean {
  let cursor: NodeId | undefined = (start as { parentId?: NodeId }).parentId;
  for (let i = 0; i < 16 && cursor; i++) {
    if (cursor === ancestorId) return true;
    const p: Node | undefined = nodes.get(cursor);
    if (!p) return false;
    cursor = (p as { parentId?: NodeId }).parentId;
  }
  return false;
}

// =============================================================================
// Per-bucket scorers
// =============================================================================

export interface ScoreContext {
  cfg: Required<SeverityConfig>;
  base: SideTables;
  head: SideTables;
}

function scoreAddedNode(rec: AddedNode, ctx: ScoreContext): number {
  const { cfg } = ctx;
  const node = rec.node;

  if (isFunctionNode(node)) {
    if (node.pure === true) {
      return cfg.newPureFunction;
    }
    // pure:false → check for descendant sink
    if (functionHasDescendantSink(node, ctx.head.nodes)) {
      // Plus a "dead function" bonus if no incoming edges land on it.
      const hasIncoming = (ctx.head.incidence.in.get(node.id)?.length ?? 0) > 0;
      const dead = hasIncoming ? 0 : cfg.newDeadFunction;
      return cfg.newEffectfulFunctionWithSink + dead;
    }
    // pure:false with no descendant sink — treat as "other add" + maybe dead.
    const hasIncoming = (ctx.head.incidence.in.get(node.id)?.length ?? 0) > 0;
    return cfg.otherAdd + (hasIncoming ? 0 : cfg.newDeadFunction);
  }

  return cfg.otherAdd;
}

function scoreRemovedNode(_rec: RemovedNode, ctx: ScoreContext): number {
  return ctx.cfg.otherRemove;
}

function scoreChangedNode(rec: ChangedNode, ctx: ScoreContext): number {
  const { cfg } = ctx;
  // §5: a node whose only field is `loc` is dropped upstream; if it slips
  // through (opts.includeLocOnly) it scores `locOnly`.
  if (
    rec.fields.length === 1 &&
    rec.fields[0]!.field === "loc" &&
    rec.edgeDelta.added === 0 &&
    rec.edgeDelta.removed === 0 &&
    rec.edgeDelta.changed === 0
  ) {
    return cfg.locOnly;
  }

  // Look for a returnType.display delta involving a sensitive type — design
  // §6.1 doesn't explicitly weight this, but the worked example in §10.3
  // expects the function-node change to land at score 6 ("high") because
  // `User` is in the post type. We mirror that: a single `returnType.display`
  // change to a sensitive type uses the `changedValueTypeSensitive` weight.
  for (const f of rec.fields) {
    if (
      f.field === "returnType.display" &&
      typeof f.after === "string" &&
      typeRefMentionsSensitive(
        { lang: "none", display: f.after },
        cfg.securitySensitiveTypes,
      )
    ) {
      return cfg.changedValueTypeSensitive;
    }
  }

  return cfg.otherAdd; // generic non-zero so changed nodes appear in topItems
}

function scoreAddedEdge(rec: AddedEdge, ctx: ScoreContext): number {
  const { cfg, head } = ctx;
  const e = rec.edge;
  let score = 0;

  // (a) cross-service?
  const srcSvc = serviceIdOf(e.sourceId, head.nodes);
  const dstSvc = serviceIdOf(e.targetId, head.nodes);
  if (srcSvc && dstSvc && srcSvc !== dstSvc) {
    score += cfg.newCrossServiceEdge;
  }

  // (b) sink-flavored categories.
  switch (e.category) {
    case "network":
      score += cfg.newNetworkSink;
      break;
    case "db-write":
      score += cfg.newDbWriteSink;
      break;
    case "exec":
      score += cfg.newExecSink;
      break;
    case "fs-write":
      score += cfg.newFsWriteSink;
      break;
    case "http-route":
      score += cfg.newHttpRoute;
      break;
    default:
      break;
  }

  // (c) tagged-target bonus.
  const dst = head.nodes.get(e.targetId);
  if (dst && nodeIsTagSensitive(dst, cfg.sensitiveNodeTags)) {
    score += cfg.newEdgeIntoTaggedNode;
  }

  if (score === 0) score = cfg.otherAdd;
  return score;
}

function scoreRemovedEdge(rec: RemovedEdge, ctx: ScoreContext): number {
  const { cfg } = ctx;
  if (rec.edge.category === "http-route") return cfg.removedHttpRoute;
  return cfg.otherRemove;
}

function scoreChangedEdge(rec: ChangedEdge, ctx: ScoreContext): number {
  const { cfg } = ctx;
  const sensitive =
    typeRefMentionsSensitive(rec.before, cfg.securitySensitiveTypes) ||
    typeRefMentionsSensitive(rec.after, cfg.securitySensitiveTypes);
  return sensitive
    ? cfg.changedValueTypeSensitive
    : cfg.changedValueTypeOther;
}

// =============================================================================
// Build the scored list
// =============================================================================

export interface ScoredAggregate {
  scored: ScoredItem[];
  severityCounts: Record<SeverityBucket, number>;
}

export function scoreAll(
  buckets: {
    addedNodes: AddedNode[];
    removedNodes: RemovedNode[];
    changedNodes: ChangedNode[];
    addedEdges: AddedEdge[];
    removedEdges: RemovedEdge[];
    changedEdges: ChangedEdge[];
  },
  ctx: ScoreContext,
): ScoredAggregate {
  const items: ScoredItem[] = [];
  const sev: Record<SeverityBucket, number> = {
    low: 0, medium: 0, high: 0, critical: 0,
  };

  const push = (ref: string, score: number): void => {
    const bucket = bucketForScore(score);
    sev[bucket]++;
    items.push({ ref, score, severity: bucket });
  };

  for (const r of buckets.addedNodes)   push(`node:${r.id}`,   scoreAddedNode(r, ctx));
  for (const r of buckets.removedNodes) push(`node:${r.id}`,   scoreRemovedNode(r, ctx));
  for (const r of buckets.changedNodes) push(`node:${r.id}`,   scoreChangedNode(r, ctx));
  for (const r of buckets.addedEdges)   push(`edge:${r.key}`,  scoreAddedEdge(r, ctx));
  for (const r of buckets.removedEdges) push(`edge:${r.key}`,  scoreRemovedEdge(r, ctx));
  for (const r of buckets.changedEdges) push(`edge:${r.key}`,  scoreChangedEdge(r, ctx));

  items.sort(compareScored);
  return { scored: items, severityCounts: sev };
}

/**
 * Deterministic ordering: score desc, then `ref` ascending. The `ref` fallback
 * is what makes the diff byte-stable when many records share a score (e.g.
 * "all other adds" at +1 in a churn-heavy PR).
 */
export function compareScored(a: ScoredItem, b: ScoredItem): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.ref < b.ref) return -1;
  if (a.ref > b.ref) return 1;
  return 0;
}

// (re-exports for external scoring tests)
export const _internal = {
  scoreAddedNode,
  scoreRemovedNode,
  scoreChangedNode,
  scoreAddedEdge,
  scoreRemovedEdge,
  scoreChangedEdge,
  serviceIdOf,
};

// satisfy the type checker for unused side imports in some compiler modes
export type { Edge };
