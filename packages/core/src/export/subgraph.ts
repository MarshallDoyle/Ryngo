/**
 * Subgraph selector — shared trimmer for every export emitter.
 *
 * Spec: design/exports.md §1.
 *
 * The selector is the single trimmer that feeds every format-specific
 * emitter. Determinism flows from this discipline: the same sub-IR maps
 * to the same bytes in every target format.
 *
 * Selection composes in the order:
 *   1. `--root` chooses an entry set (defaults to all `service`-tier nodes)
 *   2. `--depth` bounds BFS hop traversal (default ∞)
 *   3. `--filter` removes nodes/edges that fail predicates (post-traversal,
 *      so reachability is unaffected — a filtered-out node still served as
 *      a hop)
 *   4. `--include-parents` (default true) drags tier ancestors into the result
 *
 * Type-only imports against `@codegraph/ir` keep this file dependency-free;
 * if the types ever drift from the real schema, downstream `validateIR` will
 * catch it on load.
 */

import type {
  IR,
  IRDocument,
  Node as IRNode,
  Edge as IREdge,
  NodeId,
  Tier,
  EdgeCategory,
  Lang,
} from "@codegraph/ir";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Direction = "out" | "in" | "both";

export interface SelectSubgraphOptions {
  /** Repeatable root node ids. Empty / omitted → all `service`-tier nodes. */
  roots?: ReadonlyArray<string>;
  /** BFS hop limit (≥0). `undefined` ⇒ unbounded. */
  depth?: number;
  /** Edge-following direction during BFS. Default: "out". */
  direction?: Direction;
  /** Filter expression strings (see §1.3). All must pass. */
  filter?: ReadonlyArray<string>;
  /** Default: true — include tier ancestors of selected nodes. */
  includeParents?: boolean;
  /** Override the timestamp stamped into metadata.selection. Tests pin this. */
  selectedAt?: string;
  /** Selector implementation version, written into metadata.selection. */
  selectorVersion?: string;
}

/**
 * The selector returns a structurally-valid IR document with filtered
 * `nodes`/`edges`, the same `schemaVersion`, and a synthetic
 * `metadata.selection` block recording the flags used.
 */
export interface SelectSubgraphResult {
  doc: IRDocument;
  /** Selected node ids in the order the BFS visited them (pre-filter). */
  reachedNodeIds: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Filter expression grammar (§1.3)
// ---------------------------------------------------------------------------

type FilterOp = "eq" | "neq";

interface FilterPredicate {
  key: string;
  op: FilterOp;
  /** OR'd values (`a|b|c`). */
  values: ReadonlyArray<string>;
}

const NODE_KEYS = new Set(["tier", "lang", "pure", "service"]);
const EDGE_KEYS = new Set(["category", "valueType"]);

/**
 * Parses one or more comma-separated `key=value` (or `key!=value`)
 * predicates. Throws on malformed input — the CLI surfaces the error.
 */
export function parseFilters(
  exprs: ReadonlyArray<string>,
): ReadonlyArray<FilterPredicate> {
  const out: FilterPredicate[] = [];
  for (const raw of exprs) {
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const expr = part.trim();
      if (!expr) continue;
      // Note: order matters — `!=` must be tested before `=`.
      const neqIdx = expr.indexOf("!=");
      let key: string;
      let op: FilterOp;
      let valueStr: string;
      if (neqIdx >= 0) {
        key = expr.slice(0, neqIdx).trim();
        valueStr = expr.slice(neqIdx + 2).trim();
        op = "neq";
      } else {
        const eqIdx = expr.indexOf("=");
        if (eqIdx < 0) {
          throw new Error(
            `codegraph: invalid filter expression "${expr}" — expected key=value or key!=value.`,
          );
        }
        key = expr.slice(0, eqIdx).trim();
        valueStr = expr.slice(eqIdx + 1).trim();
        op = "eq";
      }
      if (!key) {
        throw new Error(`codegraph: filter expression "${expr}" has empty key.`);
      }
      if (!NODE_KEYS.has(key) && !EDGE_KEYS.has(key)) {
        throw new Error(
          `codegraph: filter key "${key}" is not supported. ` +
            `Known keys: ${[...NODE_KEYS, ...EDGE_KEYS].join(", ")}.`,
        );
      }
      const values = valueStr.split("|").map((v) => v.trim()).filter((v) => v.length > 0);
      if (values.length === 0) {
        throw new Error(`codegraph: filter "${expr}" has empty value list.`);
      }
      out.push({ key, op, values });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Predicate evaluation
// ---------------------------------------------------------------------------

function nodeMatchesFilter(
  node: IRNode,
  preds: ReadonlyArray<FilterPredicate>,
  serviceLookup: ReadonlyMap<string, string>,
): boolean {
  for (const p of preds) {
    if (!NODE_KEYS.has(p.key)) continue; // edge predicates don't apply to nodes
    const actual = nodeFieldValue(node, p.key, serviceLookup);
    const matched = actual !== undefined && p.values.includes(actual);
    if (p.op === "eq" && !matched) return false;
    if (p.op === "neq" && matched) return false;
  }
  return true;
}

function edgeMatchesFilter(
  edge: IREdge,
  preds: ReadonlyArray<FilterPredicate>,
): boolean {
  for (const p of preds) {
    if (!EDGE_KEYS.has(p.key)) continue;
    const actual = edgeFieldValue(edge, p.key);
    const matched = actual !== undefined && p.values.includes(actual);
    if (p.op === "eq" && !matched) return false;
    if (p.op === "neq" && matched) return false;
  }
  return true;
}

function nodeFieldValue(
  node: IRNode,
  key: string,
  serviceLookup: ReadonlyMap<string, string>,
): string | undefined {
  const n = node as Record<string, unknown>;
  switch (key) {
    case "tier":
      return typeof n.tier === "string" ? (n.tier as string) : undefined;
    case "lang":
      return typeof n.lang === "string" ? (n.lang as Lang as string) : undefined;
    case "pure":
      return typeof n.pure === "boolean" ? String(n.pure) : undefined;
    case "service": {
      const svc = serviceLookup.get(node.id as string);
      return svc;
    }
    default:
      return undefined;
  }
}

function edgeFieldValue(edge: IREdge, key: string): string | undefined {
  const e = edge as Record<string, unknown>;
  switch (key) {
    case "category":
      return typeof e.category === "string" ? (e.category as EdgeCategory as string) : undefined;
    case "valueType": {
      const vt = e.valueType as { display?: string } | undefined;
      return vt?.display;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Containment helpers
// ---------------------------------------------------------------------------

/** Walks parentId chain up to the nearest service-tier node, recording the path. */
function buildAncestry(
  nodes: ReadonlyArray<IRNode>,
): {
  byId: Map<string, IRNode>;
  parents: Map<string, ReadonlyArray<string>>; // node id → ancestor ids (root last)
  serviceOfNode: Map<string, string>; // node id → enclosing service path string
} {
  const byId = new Map<string, IRNode>();
  for (const n of nodes) byId.set(n.id as string, n);

  const parents = new Map<string, ReadonlyArray<string>>();
  const serviceOfNode = new Map<string, string>();

  for (const n of nodes) {
    const chain: string[] = [];
    let cur: IRNode | undefined = n;
    const seen = new Set<string>();
    while (cur) {
      const pid = (cur as { parentId?: NodeId }).parentId as string | undefined;
      if (!pid || seen.has(pid)) break;
      seen.add(pid);
      chain.push(pid);
      cur = byId.get(pid);
    }
    parents.set(n.id as string, chain);

    // Walk the chain (plus self) to find the nearest service.
    const probe: IRNode[] = [n, ...chain.map((id) => byId.get(id)).filter((x): x is IRNode => !!x)];
    for (const p of probe) {
      if (p.tier === "service") {
        const svcPath = (p as { path?: string }).path ?? (p as { name?: string }).name ?? p.id;
        serviceOfNode.set(n.id as string, String(svcPath));
        break;
      }
    }
  }

  return { byId, parents, serviceOfNode };
}

// ---------------------------------------------------------------------------
// BFS traversal
// ---------------------------------------------------------------------------

interface Adjacency {
  outgoing: Map<string, ReadonlyArray<{ edge: IREdge; other: string }>>;
  incoming: Map<string, ReadonlyArray<{ edge: IREdge; other: string }>>;
}

function buildAdjacency(edges: ReadonlyArray<IREdge>): Adjacency {
  const outgoing = new Map<string, { edge: IREdge; other: string }[]>();
  const incoming = new Map<string, { edge: IREdge; other: string }[]>();
  for (const e of edges) {
    const s = e.sourceId as string;
    const t = e.targetId as string;
    if (!outgoing.has(s)) outgoing.set(s, []);
    outgoing.get(s)!.push({ edge: e, other: t });
    if (!incoming.has(t)) incoming.set(t, []);
    incoming.get(t)!.push({ edge: e, other: s });
  }
  return { outgoing, incoming };
}

function bfs(
  rootIds: ReadonlyArray<string>,
  depth: number | undefined,
  direction: Direction,
  adj: Adjacency,
  nodeIds: ReadonlySet<string>,
): { reached: Set<string>; order: string[] } {
  const reached = new Set<string>();
  const order: string[] = [];
  // Frontier holds [nodeId, hopCount]. Hop 0 is the root itself.
  const frontier: Array<[string, number]> = [];
  for (const r of rootIds) {
    if (!nodeIds.has(r)) continue;
    if (reached.has(r)) continue;
    reached.add(r);
    order.push(r);
    frontier.push([r, 0]);
  }
  while (frontier.length > 0) {
    const next = frontier.shift()!;
    const [cur, hop] = next;
    if (depth !== undefined && hop >= depth) continue;
    const neighbors: Array<{ edge: IREdge; other: string }> = [];
    if (direction === "out" || direction === "both") {
      for (const n of adj.outgoing.get(cur) ?? []) neighbors.push(n);
    }
    if (direction === "in" || direction === "both") {
      for (const n of adj.incoming.get(cur) ?? []) neighbors.push(n);
    }
    for (const { other } of neighbors) {
      if (!nodeIds.has(other)) continue;
      if (reached.has(other)) continue;
      reached.add(other);
      order.push(other);
      frontier.push([other, hop + 1]);
    }
  }
  return { reached, order };
}

// ---------------------------------------------------------------------------
// Public selector
// ---------------------------------------------------------------------------

const DEFAULT_SELECTOR_VERSION = "0.1.0";

export function selectSubgraph(
  input: IRDocument,
  opts: SelectSubgraphOptions = {},
): SelectSubgraphResult {
  const includeParents = opts.includeParents ?? true;
  const direction: Direction = opts.direction ?? "out";
  const depth = opts.depth;

  const ir = input.ir;
  const nodes = ir.nodes;
  const edges = ir.edges;

  // 1. Resolve roots. Empty list → all service-tier nodes.
  const allIds = new Set<string>(nodes.map((n) => n.id as string));
  let roots: string[];
  if (opts.roots && opts.roots.length > 0) {
    roots = resolveRoots(opts.roots, nodes);
  } else {
    roots = nodes
      .filter((n) => n.tier === "service")
      .map((n) => n.id as string);
  }

  // 2. BFS traversal — bounded by `depth`, walking along `direction`.
  const adj = buildAdjacency(edges);
  const { reached, order } = bfs(roots, depth, direction, adj, allIds);

  // 3. include-parents: drag tier ancestors of every reached node in.
  const ancestry = buildAncestry(nodes);
  if (includeParents) {
    for (const id of [...reached]) {
      for (const pid of ancestry.parents.get(id) ?? []) {
        reached.add(pid);
      }
    }
  }

  // 4. Apply the filter — POST-traversal, so reachability is unchanged.
  const preds = parseFilters(opts.filter ?? []);
  const finalNodeIds = new Set<string>();
  for (const id of reached) {
    const node = ancestry.byId.get(id);
    if (!node) continue;
    if (nodeMatchesFilter(node, preds, ancestry.serviceOfNode)) {
      finalNodeIds.add(id);
    }
  }

  // Edges survive only if BOTH endpoints survived AND the edge passes
  // its own predicates.
  const filteredEdges: IREdge[] = [];
  for (const e of edges) {
    const s = e.sourceId as string;
    const t = e.targetId as string;
    if (!finalNodeIds.has(s) || !finalNodeIds.has(t)) continue;
    if (!edgeMatchesFilter(e, preds)) continue;
    filteredEdges.push(e);
  }

  // Materialize the surviving nodes in their original order to keep
  // emitter output stable when callers don't pre-sort.
  const filteredNodes: IRNode[] = [];
  for (const n of nodes) {
    if (finalNodeIds.has(n.id as string)) filteredNodes.push(n);
  }

  // 5. Stamp the synthetic metadata.selection block.
  const selection = {
    roots,
    depth: depth ?? null,
    direction,
    filters: [...(opts.filter ?? [])],
    includeParents,
    selectedAt: opts.selectedAt ?? new Date().toISOString(),
    selectorVersion: opts.selectorVersion ?? DEFAULT_SELECTOR_VERSION,
  };

  const newMetadata = {
    ...ir.metadata,
    selection,
  } as IR["metadata"];

  const subDoc: IRDocument = {
    schemaVersion: input.schemaVersion,
    ir: {
      metadata: newMetadata,
      nodes: filteredNodes,
      edges: filteredEdges,
      ...(ir.diagnostics ? { diagnostics: ir.diagnostics } : {}),
    },
  };

  return { doc: subDoc, reachedNodeIds: order };
}

/**
 * Accepts full ids OR an unambiguous hex prefix. Errors out if the prefix
 * is ambiguous so the user catches typos early.
 */
function resolveRoots(
  inputs: ReadonlyArray<string>,
  nodes: ReadonlyArray<IRNode>,
): string[] {
  const ids = new Set(nodes.map((n) => n.id as string));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of inputs) {
    const r = raw.trim();
    if (!r) continue;
    let resolved: string | undefined;
    if (ids.has(r)) {
      resolved = r;
    } else {
      const matches = nodes.filter((n) => (n.id as string).startsWith(r));
      if (matches.length === 0) {
        throw new Error(`codegraph: --root "${r}" did not match any node id.`);
      }
      if (matches.length > 1) {
        throw new Error(
          `codegraph: --root "${r}" is ambiguous (matches ${matches.length} nodes); ` +
            `provide more characters of the id.`,
        );
      }
      resolved = matches[0]!.id as string;
    }
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers re-exported for renderers (tier counting, ancestry lookup).
// ---------------------------------------------------------------------------

/**
 * Counts nodes by tier across the sub-IR. Renderers (e.g. Mermaid)
 * use this to choose between flowchart/classDiagram flavors.
 */
export function tierHistogram(ir: IR): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of ir.nodes) {
    const t = n.tier as string;
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

/**
 * Picks the dominant tier (most nodes; ties break toward the earlier
 * entry of `priority`). Used by Mermaid flavor auto-selection.
 */
export function dominantTier(
  ir: IR,
  priority: ReadonlyArray<string> = ["service", "module", "type", "function", "expression"],
): string | undefined {
  const hist = tierHistogram(ir);
  let best: string | undefined;
  let bestCount = -1;
  for (const t of priority) {
    const c = hist[t] ?? 0;
    if (c > bestCount) {
      best = t;
      bestCount = c;
    }
  }
  // If no priority-tier had any nodes, fall back to whatever's there.
  if (bestCount <= 0) {
    for (const [t, c] of Object.entries(hist)) {
      if (c > bestCount) {
        best = t;
        bestCount = c;
      }
    }
  }
  return best;
}

/**
 * Sorted snapshot of nodes/edges for deterministic emission.
 * - Nodes: lexicographic by id.
 * - Edges: by (sourceId, targetId, category).
 */
export function sortedForEmission(ir: IR): { nodes: IRNode[]; edges: IREdge[] } {
  const nodes = [...ir.nodes].sort((a, b) =>
    (a.id as string).localeCompare(b.id as string),
  );
  const edges = [...ir.edges].sort((a, b) => {
    const sa = a.sourceId as string;
    const sb = b.sourceId as string;
    if (sa !== sb) return sa.localeCompare(sb);
    const ta = a.targetId as string;
    const tb = b.targetId as string;
    if (ta !== tb) return ta.localeCompare(tb);
    return (a.category as string).localeCompare(b.category as string);
  });
  return { nodes, edges };
}

/**
 * Returns the parentId chain for a node (nearest parent first, root last).
 * Provided as a cheap helper for renderers that walk containment.
 */
export function ancestryOf(
  ir: IR,
  nodeId: string,
): ReadonlyArray<string> {
  const byId = new Map<string, IRNode>();
  for (const n of ir.nodes) byId.set(n.id as string, n);
  const out: string[] = [];
  let cur = byId.get(nodeId);
  const seen = new Set<string>();
  while (cur) {
    const pid = (cur as { parentId?: NodeId }).parentId as string | undefined;
    if (!pid || seen.has(pid)) break;
    seen.add(pid);
    out.push(pid);
    cur = byId.get(pid);
  }
  return out;
}

/** Re-exports kept narrow on purpose. */
export type { IR, IRDocument, IRNode, IREdge, Tier, EdgeCategory };
