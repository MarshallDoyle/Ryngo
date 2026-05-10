/**
 * Heuristic, post-hoc rename detection (function tier only).
 *
 * Mirrors `design/diff-algorithm.md` §4 — fingerprint-based matching, no
 * merging into the IR layer. Hints are advisory; the underlying graph still
 * carries both the removed-from-base and added-in-head nodes.
 *
 * Modes (`opts.renameDetection`):
 *   - `off`              — emit no hints
 *   - `structural`       — fingerprint must match exactly (default)
 *   - `structural+name`  — `parentId` allowed to differ when name Levenshtein
 *                          ≤ 3; medium confidence
 *
 * `type`-tier renames are deferred per design §4 (last paragraph).
 */

import type {
  Edge,
  ExpressionNode,
  FunctionNode,
  Node,
  NodeId,
} from "../ir/types.js";
import {
  isExpressionNode,
  isFunctionNode,
} from "../ir/types.js";
import type {
  AddedNode,
  IncidenceIndex,
  RemovedNode,
  RenameDetectionMode,
  RenameHint,
} from "./types.js";

// =============================================================================
// Fingerprint
// =============================================================================

/**
 * The fingerprint object is JSON-stringified with sorted keys to give a stable
 * string. Two fingerprints are equal iff their canonical strings are equal.
 *
 * `parentId` is included by default (`structural` mode). For `structural+name`
 * we recompute the fingerprint without `parentId` and add a Levenshtein gate.
 */
export interface FunctionFingerprint {
  parentId: NodeId | null;
  arity: number;
  paramTypes: string[];      // sorted ascending
  returnType: string;
  inEdges: string[];         // sorted "category:tier" pairs
  outEdges: string[];
  sinks: string[];           // sorted multiset (duplicates kept)
  leaves: string[];
}

/** Build the fingerprint of a function node on its side of the diff. */
export function fingerprint(
  fn: FunctionNode,
  side: { nodes: Map<NodeId, Node>; incidence: IncidenceIndex },
): FunctionFingerprint {
  const inEdges = side.incidence.in.get(fn.id) ?? [];
  const outEdges = side.incidence.out.get(fn.id) ?? [];

  const tierOf = (id: NodeId): string => side.nodes.get(id)?.tier ?? "?";

  const paramTypes = fn.params.map(
    (p) => p.type?.display ?? "unknown",
  );
  paramTypes.sort();

  const inE = inEdges.map((e) => `${e.category}:${tierOf(e.sourceId)}`);
  inE.sort();
  const outE = outEdges.map((e) => `${e.category}:${tierOf(e.targetId)}`);
  outE.sort();

  // Descendant expression flavors. Same iteration as severity.ts but kept
  // local so each module stays cohesive.
  const sinks: string[] = [];
  const leaves: string[] = [];
  for (const n of side.nodes.values()) {
    if (!isExpressionNode(n)) continue;
    if (!hasAncestor(n, fn.id, side.nodes)) continue;
    const e = n as ExpressionNode;
    if (e.sink) sinks.push(e.sink.flavor);
    if (e.leaf) leaves.push(e.leaf.flavor);
  }
  sinks.sort();
  leaves.sort();

  return {
    parentId: fn.parentId ?? null,
    arity: fn.params.length,
    paramTypes,
    returnType: fn.returnType?.display ?? "unknown",
    inEdges: inE,
    outEdges: outE,
    sinks,
    leaves,
  };
}

function hasAncestor(
  start: Node,
  ancestorId: NodeId,
  nodes: Map<NodeId, Node>,
): boolean {
  let cursor: NodeId | undefined = (start as { parentId?: NodeId }).parentId;
  for (let i = 0; i < 16 && cursor; i++) {
    if (cursor === ancestorId) return true;
    const p = nodes.get(cursor);
    if (!p) return false;
    cursor = (p as { parentId?: NodeId }).parentId;
  }
  return false;
}

// =============================================================================
// Canonical string form (JSON with sorted keys)
// =============================================================================

export function fingerprintKey(
  fp: FunctionFingerprint,
  withParent: boolean,
): string {
  const obj: Record<string, unknown> = {
    arity: fp.arity,
    inEdges: fp.inEdges,
    leaves: fp.leaves,
    outEdges: fp.outEdges,
    paramTypes: fp.paramTypes,
    returnType: fp.returnType,
    sinks: fp.sinks,
  };
  if (withParent) obj.parentId = fp.parentId;
  return JSON.stringify(obj, sortedKeys(obj));
}

/** Replacer that emits keys in lexicographic order. */
function sortedKeys(top: Record<string, unknown>) {
  return (key: string, value: unknown): unknown => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (value === top) return value;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
}

// =============================================================================
// Levenshtein (small inputs; iterative DP)
// =============================================================================

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const m = a.length;
  const n = b.length;
  // two-row DP
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,        // delete
        curr[j - 1]! + 1,    // insert
        prev[j - 1]! + cost, // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

// =============================================================================
// Matching procedure — §4.3
// =============================================================================

export interface DetectOptions {
  mode: RenameDetectionMode;
  maxHints: number;
}

export function detectRenames(
  removed: RemovedNode[],
  added: AddedNode[],
  base: { nodes: Map<NodeId, Node>; incidence: IncidenceIndex },
  head: { nodes: Map<NodeId, Node>; incidence: IncidenceIndex },
  opts: DetectOptions,
): RenameHint[] {
  if (opts.mode === "off") return [];

  const removedFns = removed.filter(
    (r): r is RemovedNode & { node: FunctionNode } => isFunctionNode(r.node),
  );
  const addedFns = added.filter(
    (a): a is AddedNode & { node: FunctionNode } => isFunctionNode(a.node),
  );
  if (removedFns.length === 0 || addedFns.length === 0) return [];

  // Pre-compute fingerprints for added side. Strict `structural` keys index
  // by (with-parent) string; `structural+name` falls back to a parent-free
  // key when no strict match exists.
  const strictBuckets = new Map<string, typeof addedFns>();
  const looseBuckets = new Map<string, typeof addedFns>();
  for (const a of addedFns) {
    const fp = fingerprint(a.node, head);
    push(strictBuckets, fingerprintKey(fp, true), a);
    push(looseBuckets, fingerprintKey(fp, false), a);
  }

  // Track which added candidates have already been claimed so we never report
  // the same target twice.
  const claimed = new Set<NodeId>();

  const hints: RenameHint[] = [];
  // Iterate removedFns in id order so the output of the rename phase is
  // deterministic before the final sort.
  removedFns.sort((x, y) => cmpId(x.id, y.id));

  for (const r of removedFns) {
    if (hints.length >= opts.maxHints) break;
    const rfp = fingerprint(r.node, base);

    // Strict pass: same fingerprint with parent included.
    const strictKey = fingerprintKey(rfp, true);
    let cands = (strictBuckets.get(strictKey) ?? []).filter(
      (c) => !claimed.has(c.id),
    );

    if (cands.length === 1) {
      claim(claimed, hints, r, cands[0]!, "high",
        "identical fingerprint (parent, arity, types, edge kinds, sinks, leaves)");
      continue;
    }

    if (opts.mode === "structural+name") {
      // Loose: same fingerprint ignoring parentId.
      const looseKey = fingerprintKey(rfp, false);
      cands = (looseBuckets.get(looseKey) ?? []).filter(
        (c) => !claimed.has(c.id),
      );
      if (cands.length >= 1) {
        // Pick by smallest Levenshtein, with `id` ascending as a tie-breaker.
        const ranked = cands
          .map((c) => ({
            c,
            dist: levenshtein(r.node.name ?? "", c.node.name ?? ""),
          }))
          .filter((x) => x.dist <= 3)
          .sort((x, y) =>
            x.dist - y.dist || cmpId(x.c.id, y.c.id),
          );
        if (ranked.length > 0) {
          const best = ranked[0]!;
          claim(claimed, hints, r, best.c, "medium",
            `name Levenshtein ${best.dist}; ` +
            `fingerprint matches modulo parent (cross-file rename)`);
        }
      }
    }
  }

  if (hints.length > opts.maxHints) {
    return hints.slice(0, opts.maxHints);
  }
  return hints;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

function cmpId(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function claim(
  claimed: Set<NodeId>,
  out: RenameHint[],
  from: { id: NodeId; node: FunctionNode },
  to: { id: NodeId; node: FunctionNode },
  confidence: "high" | "medium",
  reason: string,
): void {
  claimed.add(to.id);
  out.push({
    from: { id: from.id, name: from.node.name },
    to:   { id: to.id,   name: to.node.name },
    confidence,
    reason,
  });
}

// re-exports
export type { Edge };
