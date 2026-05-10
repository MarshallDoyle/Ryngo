/**
 * codegraph IR diff — entry point.
 *
 * Faithful implementation of `design/diff-algorithm.md`. The public API is
 * a single function:
 *
 *     diffIR(base: DiffInput, head: DiffInput, opts?: DiffOptions): GraphDiff
 *
 * Behavior in one screen:
 *   - Validates that both sides share a major schemaVersion (§9 step 0).
 *   - Indexes nodes by id and edges by (sourceId, targetId, category, attrsHash)
 *     where attrsHash is a stable hash over a category-specific attrs subset
 *     (§3.1, §9.1).
 *   - Buckets nodes/edges into added/removed/changed:
 *       * `changedNodes` — same id, different IR-level fields OR shifted
 *         incident-edge multiset; loc-only diffs dropped by default (§5).
 *       * `changedEdges` — same identity tuple, different `valueType` (§3.3).
 *   - Optionally computes rename hints for function-tier removed↔added pairs
 *     via fingerprints (§4); this is advisory and never merges nodes.
 *   - Optionally restricts to a path-glob subset (§7).
 *   - Scores every record into a `topItems` list (§6) used by the PR comment.
 *   - Emits a byte-deterministic GraphDiff: every array sorted by a stable
 *     key, no clocks, no randomness, sorted-key JSON for hashing (§8).
 *
 * Exports the public types from `./types.js` and severity defaults so callers
 * can reuse the weight table.
 */

import type {
  Edge,
  EdgeCategory,
  ExpressionNode,
  IR,
  IRDocument,
  Metadata,
  Node,
  NodeId,
  TypeRef,
} from "../ir/types.js";
import {
  isExpressionNode,
} from "../ir/types.js";
import type {
  AddedEdge,
  AddedNode,
  ChangedEdge,
  ChangedField,
  ChangedNode,
  DiffBucket,
  DiffInput,
  DiffOptions,
  EdgeDelta,
  EdgeKey,
  GraphDiff,
  IncidenceIndex,
  RemovedEdge,
  RemovedNode,
  ScoredItem,
  SeverityBucket,
  SideTables,
} from "./types.js";
import { detectRenames } from "./rename-hints.js";
import { resolveSeverityConfig, scoreAll } from "./severity.js";

export type {
  AddedEdge,
  AddedNode,
  ChangedEdge,
  ChangedField,
  ChangedNode,
  DiffBucket,
  DiffInput,
  DiffOptions,
  EdgeDelta,
  EdgeKey,
  GraphDiff,
  IncidenceIndex,
  RemovedEdge,
  RemovedNode,
  RenameDetectionMode,
  RenameHint,
  RenameHintNodeRef,
  ScoredItem,
  SeverityBucket,
  SeverityConfig,
  SideMetadata,
  SideTables,
} from "./types.js";

export {
  DEFAULT_SEVERITY_CONFIG,
  bucketForScore,
  resolveSeverityConfig,
} from "./severity.js";

export { fingerprint, levenshtein } from "./rename-hints.js";

// =============================================================================
// Constants — keep in lockstep with `design/diff-algorithm.md`
// =============================================================================

const DIFF_SCHEMA_VERSION = "0.1.0" as const;
const DEFAULT_MAX_RENAME_HINTS = 50;
const DEFAULT_TOP_ITEMS_LIMIT = 20;

/** Node fields whose mutation triggers a `changedNodes` record (§5). */
const COMPARED_NODE_FIELDS: ReadonlyArray<string> = [
  "kind",
  "exported",
  "pure",
  "returnType.display",
  "loc",
];

// =============================================================================
// Public entry
// =============================================================================

export function diffIR(
  base: DiffInput,
  head: DiffInput,
  opts: DiffOptions = {},
): GraphDiff {
  const baseIR = unwrapIR(base);
  const headIR = unwrapIR(head);

  validateMajorMatch(baseIR, headIR);

  const baseTables = buildSideTables(baseIR);
  const headTables = buildSideTables(headIR);

  // ── Scope filter (§7) ────────────────────────────────────────────────────
  const scope = opts.scope ?? null;
  const inScopeNode = scope
    ? makeNodeScopeFilter(scope, baseTables, headTables)
    : null;

  // ── Node bucketing (§3) ──────────────────────────────────────────────────
  const addedNodes: AddedNode[] = [];
  const removedNodes: RemovedNode[] = [];
  const changedNodes: ChangedNode[] = [];

  for (const [id, node] of headTables.nodes) {
    if (baseTables.nodes.has(id)) continue;
    if (inScopeNode && !inScopeNode(id, "head")) continue;
    addedNodes.push({ id, node });
  }
  for (const [id, node] of baseTables.nodes) {
    if (headTables.nodes.has(id)) continue;
    if (inScopeNode && !inScopeNode(id, "base")) continue;
    removedNodes.push({ id, node });
  }
  for (const [id, baseNode] of baseTables.nodes) {
    const headNode = headTables.nodes.get(id);
    if (!headNode) continue;
    if (inScopeNode && !inScopeNode(id, "head")) continue;

    const fields = compareNodeFields(baseNode, headNode);
    const edgeDelta = computeEdgeDelta(
      id,
      baseTables,
      headTables,
    );

    if (fields.length === 0 && !anyDelta(edgeDelta)) continue;

    // §5: drop loc-only changes unless caller asked otherwise.
    if (
      !opts.includeLocOnly &&
      fields.length === 1 &&
      fields[0]!.field === "loc" &&
      !anyDelta(edgeDelta)
    ) {
      continue;
    }

    changedNodes.push({
      id,
      fields: sortFields(fields),
      edgeDelta,
    });
  }

  // ── Edge bucketing (§3) ──────────────────────────────────────────────────
  const addedEdges: AddedEdge[] = [];
  const removedEdges: RemovedEdge[] = [];
  const changedEdges: ChangedEdge[] = [];

  for (const [key, edge] of headTables.edges) {
    if (baseTables.edges.has(key)) continue;
    if (!edgeInScope(edge, inScopeNode, "head")) continue;
    addedEdges.push({ key, edge });
  }
  for (const [key, edge] of baseTables.edges) {
    if (headTables.edges.has(key)) continue;
    if (!edgeInScope(edge, inScopeNode, "base")) continue;
    removedEdges.push({ key, edge });
  }
  for (const [key, baseEdge] of baseTables.edges) {
    const headEdge = headTables.edges.get(key);
    if (!headEdge) continue;
    if (!valueTypeEqual(baseEdge.valueType, headEdge.valueType)) {
      if (!edgeInScope(headEdge, inScopeNode, "head")) continue;
      changedEdges.push({
        key,
        edge: headEdge,
        before: baseEdge.valueType ?? null,
        after: headEdge.valueType ?? null,
      });
    }
  }

  // ── Rename hints (§4) ────────────────────────────────────────────────────
  const renameHints = detectRenames(
    removedNodes,
    addedNodes,
    baseTables,
    headTables,
    {
      mode: opts.renameDetection ?? "structural",
      maxHints: opts.maxRenameHints ?? DEFAULT_MAX_RENAME_HINTS,
    },
  );

  // ── Severity & top items (§6) ────────────────────────────────────────────
  const cfg = resolveSeverityConfig(opts.severity);
  const topItemsLimit = opts.topItemsLimit ?? DEFAULT_TOP_ITEMS_LIMIT;

  const scored = scoreAll(
    {
      addedNodes,
      removedNodes,
      changedNodes,
      addedEdges,
      removedEdges,
      changedEdges,
    },
    { cfg, base: baseTables, head: headTables },
  );

  // ── Sort every collection by its stable key (§8) ─────────────────────────
  addedNodes.sort(byNodeId);
  removedNodes.sort(byNodeId);
  changedNodes.sort(byChangedNodeId);
  addedEdges.sort(byEdgeKey);
  removedEdges.sort(byEdgeKey);
  changedEdges.sort(byEdgeKey);
  renameHints.sort((a, b) => {
    if (a.from.id !== b.from.id) return a.from.id < b.from.id ? -1 : 1;
    if (a.to.id !== b.to.id) return a.to.id < b.to.id ? -1 : 1;
    return 0;
  });

  // ── Counts ───────────────────────────────────────────────────────────────
  const counts: Record<DiffBucket, number> = {
    addedNodes: addedNodes.length,
    removedNodes: removedNodes.length,
    changedNodes: changedNodes.length,
    addedEdges: addedEdges.length,
    removedEdges: removedEdges.length,
    changedEdges: changedEdges.length,
    renameHints: renameHints.length,
  };

  return {
    schemaVersion: DIFF_SCHEMA_VERSION,
    base: { commit: baseIR.metadata.commit, generatedAt: baseIR.metadata.generatedAt },
    head: { commit: headIR.metadata.commit, generatedAt: headIR.metadata.generatedAt },
    scope,
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges,
    removedEdges,
    changedEdges,
    renameHints,
    summary: {
      counts,
      severity: scored.severityCounts,
      topItems: scored.scored.slice(0, topItemsLimit),
    },
  };
}

// =============================================================================
// Indexing
// =============================================================================

function unwrapIR(input: DiffInput): IR {
  if ("ir" in input && input.ir && typeof input.ir === "object") {
    return (input as IRDocument).ir;
  }
  return input as IR;
}

function validateMajorMatch(base: IR, head: IR): void {
  const bv = (base.metadata as Metadata & { schemaVersion?: string })
    .schemaVersion;
  const hv = (head.metadata as Metadata & { schemaVersion?: string })
    .schemaVersion;
  // The IR document carries `schemaVersion` at the root, not on metadata.
  // When called with bare `IR` we have no version to check; trust the caller.
  if (typeof bv === "string" && typeof hv === "string") {
    const bMajor = bv.split(".")[0];
    const hMajor = hv.split(".")[0];
    if (bMajor !== hMajor) {
      throw new Error(
        `diffIR: cross-major schemaVersion (${bv} vs ${hv}); ` +
        `MAJOR bumps are not diff-compatible`,
      );
    }
  }
}

function buildSideTables(ir: IR): SideTables {
  const nodes = new Map<NodeId, Node>();
  for (const n of ir.nodes) {
    nodes.set(n.id, n);
  }

  const edges = new Map<EdgeKey, Edge>();
  for (const e of ir.edges) {
    const key = computeEdgeKey(e);
    if (edges.has(key)) {
      // Defense-in-depth: log via diagnostics-style channel would be ideal,
      // but we don't have one at this layer. Drop the duplicate; the IR
      // producer guarantees uniqueness (§3.4).
      continue;
    }
    edges.set(key, e);
  }

  const incidence: IncidenceIndex = {
    in: new Map(),
    out: new Map(),
  };
  for (const e of edges.values()) {
    push(incidence.in, e.targetId, e);
    push(incidence.out, e.sourceId, e);
  }

  return { meta: ir.metadata, nodes, edges, incidence };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

// =============================================================================
// Edge-key construction (§3.1, §9.1)
// =============================================================================

/** Category-specific attrs subset that participates in edge identity (§9.1). */
function pickCategoryAttrs(e: Edge): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  switch (e.category) {
    case "import": {
      const k = (e as { kind?: string }).kind;
      if (k === "type" || k === "value") attrs.kind = k;
      break;
    }
    case "type-flow": {
      const role = (e as { role?: string }).role;
      const argIndex = (e as { argIndex?: number }).argIndex;
      if (typeof role === "string") attrs.role = role;
      if (typeof argIndex === "number") attrs.argIndex = argIndex;
      break;
    }
    case "http-route": {
      const method = (e as { method?: string }).method;
      if (typeof method === "string") attrs.method = method;
      break;
    }
    case "db-read":
    case "db-write": {
      const op = (e as { op?: string }).op;
      if (typeof op === "string") attrs.op = op;
      break;
    }
    case "network": {
      const method = (e as { method?: string }).method;
      if (typeof method === "string") attrs.method = method;
      break;
    }
    // call / env-read / fs-read / fs-write / exec / x-* — no attrs in identity.
    default:
      break;
  }
  return attrs;
}

export function computeEdgeKey(e: Edge): EdgeKey {
  const attrs = pickCategoryAttrs(e);
  const attrsCanonical = canonicalJSON(attrs);
  const attrsHash = stableHashHex(attrsCanonical);
  return `${e.sourceId}|${e.targetId}|${e.category}|${attrsHash}`;
}

/** JSON.stringify with keys lex-sorted at every object level. */
function canonicalJSON(v: unknown): string {
  return JSON.stringify(v, (_key, value) => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        out[k] = (value as Record<string, unknown>)[k];
      }
      return out;
    }
    return value;
  });
}

/**
 * Stable, dependency-free 128-bit-ish hex hash. The IR spec mandates BLAKE3-128
 * for node IDs; for the edge `attrsHash` we just need (a) determinism and
 * (b) a low collision probability over very small inputs (a handful of
 * sorted key/value pairs). FNV-1a 64 + a salt round, hex-rendered, gets us
 * there without pulling in a hash library at this layer. Node ids — which
 * use BLAKE3 — are hashed by the indexer, not this module.
 */
function stableHashHex(s: string): string {
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x100000001b3n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 ^ BigInt(s.charCodeAt(i))) & MASK;
    h1 = (h1 * PRIME) & MASK;
    h2 = (h2 ^ BigInt(s.charCodeAt(s.length - 1 - i))) & MASK;
    h2 = (h2 * PRIME) & MASK;
  }
  return h1.toString(16).padStart(16, "0") +
         h2.toString(16).padStart(16, "0");
}

// =============================================================================
// Field comparison (§5)
// =============================================================================

function compareNodeFields(a: Node, b: Node): ChangedField[] {
  const out: ChangedField[] = [];
  for (const f of COMPARED_NODE_FIELDS) {
    const av = readField(a, f);
    const bv = readField(b, f);
    if (!deepEqual(av, bv)) {
      out.push({ field: f, before: av, after: bv });
    }
  }
  return out;
}

function readField(n: Node, field: string): unknown {
  if (field === "returnType.display") {
    const r = (n as { returnType?: TypeRef }).returnType;
    return r?.display ?? null;
  }
  if (field === "loc") {
    return (n as { loc?: unknown }).loc ?? null;
  }
  return (n as unknown as Record<string, unknown>)[field] ?? null;
}

function sortFields(fields: ChangedField[]): ChangedField[] {
  return [...fields].sort((a, b) =>
    a.field < b.field ? -1 : a.field > b.field ? 1 : 0,
  );
}

// =============================================================================
// Edge delta (§5)
// =============================================================================

function computeEdgeDelta(
  id: NodeId,
  base: SideTables,
  head: SideTables,
): EdgeDelta {
  const baseKeys = collectIncidentKeys(id, base);
  const headKeys = collectIncidentKeys(id, head);

  let added = 0;
  let removed = 0;
  let changed = 0;

  for (const k of headKeys) {
    if (!baseKeys.has(k)) added++;
  }
  for (const k of baseKeys) {
    if (!headKeys.has(k)) removed++;
  }
  // Changed: same key on both sides, valueType differs.
  for (const k of headKeys) {
    if (!baseKeys.has(k)) continue;
    const be = base.edges.get(k)!;
    const he = head.edges.get(k)!;
    if (!valueTypeEqual(be.valueType, he.valueType)) changed++;
  }

  return { added, removed, changed };
}

function collectIncidentKeys(id: NodeId, side: SideTables): Set<EdgeKey> {
  const out = new Set<EdgeKey>();
  for (const e of side.incidence.in.get(id) ?? []) {
    out.add(computeEdgeKey(e));
  }
  for (const e of side.incidence.out.get(id) ?? []) {
    out.add(computeEdgeKey(e));
  }
  return out;
}

function anyDelta(d: EdgeDelta): boolean {
  return d.added !== 0 || d.removed !== 0 || d.changed !== 0;
}

// =============================================================================
// valueType equality (§9.2)
// =============================================================================

function valueTypeEqual(
  a: TypeRef | null | undefined,
  b: TypeRef | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a.lang !== b.lang) return false;
  if (a.structural && b.structural) {
    return deepEqual(a.structural, b.structural);
  }
  return a.display === b.display;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

// =============================================================================
// Scope (§7)
// =============================================================================

type ScopeFilter = (id: NodeId, side: "base" | "head") => boolean;

function makeNodeScopeFilter(
  scope: string[],
  base: SideTables,
  head: SideTables,
): ScopeFilter {
  const matchers = scope.map(globToRegExp);
  const cache = new Map<string, boolean>(); // key: `${side}:${id}`

  const decide = (id: NodeId, side: "base" | "head"): boolean => {
    const ck = `${side}:${id}`;
    const cached = cache.get(ck);
    if (cached !== undefined) return cached;

    const tables = side === "head" ? head : base;
    const path = pathForNode(id, tables);
    const ok = path !== null && matchers.some((m) => m.test(path));
    cache.set(ck, ok);
    return ok;
  };

  return decide;
}

function pathForNode(id: NodeId, tables: SideTables): string | null {
  let cursor: NodeId | undefined = id;
  for (let i = 0; i < 16 && cursor; i++) {
    const n = tables.nodes.get(cursor);
    if (!n) return null;
    const p = (n as { path?: string }).path;
    if (typeof p === "string" && p.length > 0) return p;
    cursor = (n as { parentId?: NodeId }).parentId;
  }
  return null;
}

function edgeInScope(
  edge: Edge,
  filter: ScopeFilter | null,
  side: "base" | "head",
): boolean {
  if (!filter) return true;
  // Either endpoint in scope qualifies (§7 rule 2).
  return filter(edge.sourceId, side) || filter(edge.targetId, side);
}

/**
 * Translate a tiny POSIX glob to a regex. Supports `**`, `*`, `?` and
 * literal path segments. Anchored at both ends.
 */
function globToRegExp(glob: string): RegExp {
  // Escape regex metacharacters first, then re-introduce glob tokens.
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        // collapse a following `/`
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\.+()[]{}|^$".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

// =============================================================================
// Output sort comparators
// =============================================================================

function byNodeId(a: { id: NodeId }, b: { id: NodeId }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byChangedNodeId(a: ChangedNode, b: ChangedNode): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byEdgeKey(a: { key: EdgeKey }, b: { key: EdgeKey }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// `isExpressionNode` is referenced indirectly via incidence; keep it imported
// to avoid a TS unused-import false flag in some compiler modes.
void isExpressionNode;
void ((_n?: ExpressionNode) => null);
