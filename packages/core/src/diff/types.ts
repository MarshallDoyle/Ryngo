/**
 * codegraph Graph-Diff — public types (schema v0.1.0)
 *
 * Faithful TypeScript projection of the `GraphDiff` shape defined in
 * `design/diff-algorithm.md` §1.2. The runtime that produces these values
 * lives in `./index.ts`; severity scoring in `./severity.ts`; rename
 * detection in `./rename-hints.ts`.
 *
 * Every collection in `GraphDiff` is sorted by a deterministic key (see
 * `design/diff-algorithm.md` §8). Output is suitable for snapshot tests.
 */

import type {
  Edge,
  EdgeCategory,
  IR,
  IRDocument,
  Metadata,
  Node,
  NodeId,
  TypeRef,
} from "../ir/types.js";

// =============================================================================
// Inputs
// =============================================================================

/**
 * Either an `IRDocument` (root-level wrapper with `schemaVersion` + `ir`) or a
 * bare `IR` (just `metadata`/`nodes`/`edges`). The diff engine accepts both;
 * the snapshot fixtures and the worked examples use the bare form for brevity.
 */
export type DiffInput = IR | IRDocument;

export type RenameDetectionMode = "off" | "structural" | "structural+name";

export interface DiffOptions {
  /** Restrict diff to a path-glob subset; see design §7. POSIX globs. */
  scope?: string[];

  /** Default `"structural"`. See design §4. */
  renameDetection?: RenameDetectionMode;

  /** Severity weights override; see design §6. */
  severity?: SeverityConfig;

  /** Cap on `renameHints.length`. Default 50. */
  maxRenameHints?: number;

  /** Cap on `summary.topItems.length`. Default 20. */
  topItemsLimit?: number;

  /** When true, surface `loc`-only changed nodes. Default false. */
  includeLocOnly?: boolean;
}

/**
 * Severity weights, overridable per-repo. Defaults live in `./severity.ts`
 * (`DEFAULT_SEVERITY_CONFIG`) and mirror design §6.1.
 */
export interface SeverityConfig {
  newNetworkSink?: number;
  newCrossServiceEdge?: number;
  newDbWriteSink?: number;
  newExecSink?: number;
  newFsWriteSink?: number;
  newHttpRoute?: number;
  changedValueTypeSensitive?: number;
  changedValueTypeOther?: number;
  newEdgeIntoTaggedNode?: number;
  removedHttpRoute?: number;
  newEffectfulFunctionWithSink?: number;
  newPureFunction?: number;
  newDeadFunction?: number;
  otherAdd?: number;
  otherRemove?: number;
  locOnly?: number;

  /** Substring matched (case-insensitive) against `valueType.display`. */
  securitySensitiveTypes?: string[];

  /** Tags treated as "auth/payment-class" for the tagged-node bonus. */
  sensitiveNodeTags?: string[];
}

// =============================================================================
// Output buckets
// =============================================================================

/** Discriminator for `summary.counts`. */
export type DiffBucket =
  | "addedNodes"
  | "removedNodes"
  | "changedNodes"
  | "addedEdges"
  | "removedEdges"
  | "changedEdges"
  | "renameHints";

export type SeverityBucket = "low" | "medium" | "high" | "critical";

export interface AddedNode {
  id: NodeId;
  node: Node;
}

export interface RemovedNode {
  id: NodeId;
  node: Node;
}

/** A node whose `id` is present on both sides but whose IR-level fields or
 *  incident-edge multiset shifted. See design §5. */
export interface ChangedNode {
  id: NodeId;
  /** Sorted by `field` (lex). Each entry is one IR-level scalar diff. */
  fields: ChangedField[];
  edgeDelta: EdgeDelta;
}

export interface ChangedField {
  field: string;
  before: unknown;
  after: unknown;
}

export interface EdgeDelta {
  added: number;
  removed: number;
  changed: number;
}

/** Stable string form of `(sourceId, targetId, category, attrsHash)`. */
export type EdgeKey = string;

export interface AddedEdge {
  key: EdgeKey;
  edge: Edge;
}

export interface RemovedEdge {
  key: EdgeKey;
  edge: Edge;
}

/** An edge with the same identity tuple on both sides but a different
 *  `valueType`. See design §3.3. */
export interface ChangedEdge {
  key: EdgeKey;
  /** The head edge (source/target/category/attrs are stable across sides). */
  edge: Edge;
  before: TypeRef | null;
  after: TypeRef | null;
}

export interface RenameHintNodeRef {
  id: NodeId;
  name: string;
}

export interface RenameHint {
  from: RenameHintNodeRef;
  to: RenameHintNodeRef;
  confidence: "high" | "medium";
  reason: string;
}

// =============================================================================
// Summary
// =============================================================================

export interface ScoredItem {
  /** Stable, addressable handle. `node:<id>` or `edge:<key>`. */
  ref: string;
  score: number;
  severity: SeverityBucket;
}

export interface DiffSummary {
  counts: Record<DiffBucket, number>;
  severity: Record<SeverityBucket, number>;
  /** Sorted by `(score desc, ref asc)`. Capped at `topItemsLimit`. */
  topItems: ScoredItem[];
}

export interface SideMetadata {
  commit: string;
  generatedAt: string;
}

// =============================================================================
// Top-level GraphDiff
// =============================================================================

export interface GraphDiff {
  schemaVersion: "0.1.0";

  base: SideMetadata;
  head: SideMetadata;
  scope: string[] | null;

  addedNodes: AddedNode[];
  removedNodes: RemovedNode[];
  changedNodes: ChangedNode[];

  addedEdges: AddedEdge[];
  removedEdges: RemovedEdge[];
  changedEdges: ChangedEdge[];

  renameHints: RenameHint[];

  summary: DiffSummary;
}

// =============================================================================
// Internal helpers exported for `severity.ts` / `rename-hints.ts`
// =============================================================================

/** Map of node id → its incoming/outgoing edges. Used for §5 edge deltas
 *  and §4 rename fingerprints. */
export interface IncidenceIndex {
  in: Map<NodeId, Edge[]>;
  out: Map<NodeId, Edge[]>;
}

/** Carries the side-specific lookups severity needs. */
export interface SideTables {
  meta: Metadata;
  nodes: Map<NodeId, Node>;
  edges: Map<EdgeKey, Edge>;
  incidence: IncidenceIndex;
}

/** Runtime helpers re-exported from the diff entry point. */
export type EdgeCategoryAttrs = {
  category: EdgeCategory;
  attrs: Record<string, unknown>;
};
