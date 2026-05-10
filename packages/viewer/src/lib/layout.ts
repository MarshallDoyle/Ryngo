/**
 * ELK-based hierarchical layout for the codegraph IR.
 *
 * The viewer renders a compound graph: services contain modules contain types
 * contain functions (per `design/nested-nodes.md` §0). React Flow encodes that
 * containment via `parentId`, with child positions expressed *relative to*
 * the parent (§3.1). ELK's `layered` algorithm with
 * `elk.hierarchyHandling: INCLUDE_CHILDREN` lays compound graphs out natively,
 * which is why we use it over flat alternatives like Dagre.
 *
 * Performance: per design §9, the viewer must stay 60fps on 1000+ node graphs.
 * ELK on the main thread routinely costs 200ms+ on large inputs, which would
 * stall every animation. We push layout into a dedicated worker
 * (`./layout-worker.ts`) and memoize results in `./layout-cache.ts`. Repeated
 * expand/collapse is then free.
 *
 * The public surface is two things:
 *
 *   - `layout(nodes, edges, options)` — the imperative entry point. Resolves
 *     to positioned nodes, an unchanged edge array, and the bounding size of
 *     the laid-out canvas.
 *   - `useLayout(graph)` — a React hook that schedules layout when the IR
 *     changes and exposes the latest positioned graph + a pending flag.
 *
 * The legacy `computeLayout(ir)` export is preserved so the existing
 * `Graph.tsx` keeps working while the rest of the viewer migrates.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Edge as IREdge, IR, Node as IRNode, Tier } from './load-ir';
import {
  getCached,
  hashLayoutOptions,
  makeCacheKey,
  setCached,
  type LayoutCacheEntry,
} from './layout-cache';

// ---------- public types ----------

export type Pos = { x: number; y: number };

/**
 * IR node augmented with layout output.
 *
 * `position` is *parent-relative* whenever `parentId` is set, matching React
 * Flow's nested-node convention (§3.1). `width` and `height` are the
 * dimensions ELK used / produced — callers can pass them straight into the
 * React Flow `style` prop.
 */
export type PositionedNode = IRNode & {
  position: Pos;
  width: number;
  height: number;
};

export type LayoutOptions = {
  /** ELK direction. Default `DOWN` matches the design's vertical hierarchy. */
  direction?: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT';
  /** Spacing between nodes within the same layer. Default 40. */
  spacingNodeNode?: number;
  /** Spacing between layers. Default 60. */
  spacingBetweenLayers?: number;
  /** Padding inside a parent container. Default 24 on all sides. */
  padding?: number;
  /**
   * If false, force inline (non-worker) layout. Mostly for tests + SSR. The
   * worker path is the default in the browser.
   */
  useWorker?: boolean;
};

export type LayoutResult = {
  nodes: PositionedNode[];
  edges: IREdge[];
  width: number;
  height: number;
};

// ---------- node sizing ----------

// Per `design/nested-nodes.md` §1, every tier has a fixed visual archetype.
// These are the *collapsed* dimensions — what a leaf at that tier occupies on
// the canvas. ELK uses them to lay out siblings; React Flow renders them via
// the matching `Node*.tsx` component's CSS.
const TIER_SIZE: Record<Tier, { width: number; height: number }> = {
  service: { width: 480, height: 280 },
  module: { width: 280, height: 160 },
  type: { width: 220, height: 140 },
  function: { width: 160, height: 60 },
  expression: { width: 160, height: 24 },
};

const FALLBACK_SIZE = { width: 180, height: 60 };

function sizeOf(node: IRNode): { width: number; height: number } {
  return TIER_SIZE[node.tier] ?? FALLBACK_SIZE;
}

// ---------- ELK glue ----------

// Minimal shape we hand to / receive from ELK. We avoid importing elkjs's
// types into the main bundle (the package's d.ts pull a few MB of declaration
// merging that we don't need here).
type ElkNodeIn = {
  id: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNodeIn[];
  edges?: ElkEdgeIn[];
};
type ElkEdgeIn = { id: string; sources: string[]; targets: string[] };
type ElkGraphIn = ElkNodeIn;

type ElkNodeOut = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNodeOut[];
};
type ElkGraphOut = ElkNodeOut;

function defaultOptions(opts: LayoutOptions): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': opts.direction ?? 'DOWN',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.layered.spacing.nodeNodeBetweenLayers': String(opts.spacingBetweenLayers ?? 60),
    'elk.spacing.nodeNode': String(opts.spacingNodeNode ?? 40),
    'elk.padding': padding(opts.padding ?? 24),
    // Edges that route through container boundaries — needed because nested
    // edges in our IR routinely cross tiers.
    'elk.layered.crossingMinimization.semiInteractive': 'true',
  };
}

function padding(n: number): string {
  return `[top=${n},left=${n},bottom=${n},right=${n}]`;
}

// ---------- worker plumbing ----------

// One worker per page. Created lazily on first use so SSR / tests don't pay
// for it. The worker module is `./layout-worker.ts`; Vite recognises the
// `new URL(...)` + `import.meta.url` pattern and emits it as a separate chunk.

let workerSingleton: Worker | null = null;
let workerReqId = 0;
const pendingByReqId = new Map<
  number,
  { resolve: (v: ElkGraphOut) => void; reject: (err: Error) => void }
>();

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (workerSingleton) return workerSingleton;
  try {
    const w = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('message', (ev: MessageEvent) => {
      const data = ev.data as
        | { id: number; ok: true; result: ElkGraphOut }
        | { id: number; ok: false; error: string };
      const pending = pendingByReqId.get(data.id);
      if (!pending) return;
      pendingByReqId.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else pending.reject(new Error(data.error));
    });
    w.addEventListener('error', (ev) => {
      // Bubble up to whoever's waiting; otherwise the promise hangs.
      for (const p of pendingByReqId.values()) p.reject(new Error(ev.message || 'layout worker error'));
      pendingByReqId.clear();
    });
    workerSingleton = w;
    return w;
  } catch {
    // Construction can fail in test envs without DOM. Fall back to inline.
    return null;
  }
}

function runInWorker(graph: ElkGraphIn): Promise<ElkGraphOut> {
  const w = ensureWorker();
  if (!w) return runInline(graph);
  const id = ++workerReqId;
  return new Promise<ElkGraphOut>((resolve, reject) => {
    pendingByReqId.set(id, { resolve, reject });
    w.postMessage({ id, graph });
  });
}

async function runInline(graph: ElkGraphIn): Promise<ElkGraphOut> {
  const mod = await import('elkjs/lib/elk.bundled.js');
  const ELK = (mod as unknown as { default: new () => { layout: (g: ElkGraphIn) => Promise<ElkGraphOut> } }).default;
  const elk = new ELK();
  return elk.layout(graph);
}

// ---------- public: layout() ----------

/**
 * Lay out the given IR nodes + edges.
 *
 * Returns parent-relative positions for every node (matching React Flow's
 * nested-node convention) plus the overall canvas size. Edges are returned
 * unchanged — ELK's edge routing exists but we don't consume it yet; React
 * Flow's default routing is good enough for v1, and synthesising orthogonal
 * routes from ELK sections is a separate concern.
 */
export async function layout(
  nodes: ReadonlyArray<IRNode>,
  edges: ReadonlyArray<IREdge>,
  options: LayoutOptions = {},
): Promise<LayoutResult> {
  if (nodes.length === 0) {
    return { nodes: [], edges: [...edges], width: 0, height: 0 };
  }

  const elkOptions = defaultOptions(options);
  const optionsHash = hashLayoutOptions(elkOptions);

  // Cache key spans the entire input. For the v1 single-pass layout this is
  // also the only entry we read/write; subtree-level keys (one per container)
  // become useful when the renderer asks for an incremental relayout — the
  // cache module is structured to support that without changes here.
  const cacheKey = makeCacheKey({
    parentId: null,
    children: nodes.map((n) => ({ id: n.id, ...sizeOf(n) })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    optionsHash,
  });

  let cached = getCached(cacheKey);
  if (!cached) {
    cached = await computeAndCache(nodes, edges, elkOptions, cacheKey);
  }

  // Stitch positions back onto IR nodes.
  const nodeById = new Map<string, IRNode>(nodes.map((n) => [n.id, n]));
  const positioned: PositionedNode[] = nodes.map((n) => {
    const pos = cached!.positions.get(n.id) ?? { x: 0, y: 0 };
    const size = sizeOf(n);
    const out: PositionedNode = {
      ...n,
      position: pos,
      width: size.width,
      height: size.height,
    };
    return out;
  });

  // Filter edges down to those where both endpoints exist in the IR — defensive,
  // but cheap and keeps us aligned with the validated load-ir output.
  const validEdges: IREdge[] = edges.filter((e) => nodeById.has(e.source) && nodeById.has(e.target));

  return {
    nodes: positioned,
    edges: validEdges,
    width: cached.width,
    height: cached.height,
  };
}

async function computeAndCache(
  nodes: ReadonlyArray<IRNode>,
  edges: ReadonlyArray<IREdge>,
  elkOptions: Record<string, string>,
  cacheKey: string,
): Promise<LayoutCacheEntry> {
  const graph = buildElkGraph(nodes, edges, elkOptions);

  const useWorker = typeof Worker !== 'undefined';
  const laid = useWorker ? await runInWorker(graph) : await runInline(graph);

  const positions = new Map<string, Pos>();
  // ELK emits positions relative to the immediate parent for compound graphs
  // when `hierarchyHandling: INCLUDE_CHILDREN` is set. React Flow expects the
  // same convention for nodes with `parentId`, so we just record what ELK
  // gave us and don't accumulate. The exception is root-level nodes, whose
  // "parent" is the synthetic ELK root — those positions are already what RF
  // wants for top-level nodes (no `parentId`).
  walkElk(laid, positions);

  // Defensive: any node ELK didn't position lands at the origin.
  for (const n of nodes) {
    if (!positions.has(n.id)) positions.set(n.id, { x: 0, y: 0 });
  }

  const entry: LayoutCacheEntry = {
    width: laid.width ?? 0,
    height: laid.height ?? 0,
    positions,
  };
  setCached(cacheKey, entry);
  return entry;
}

function walkElk(node: ElkNodeOut, out: Map<string, Pos>): void {
  // The synthetic root has id 'root' and we don't emit a position for it.
  if (node.id !== 'root') {
    out.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  }
  for (const c of node.children ?? []) walkElk(c, out);
}

function buildElkGraph(
  nodes: ReadonlyArray<IRNode>,
  edges: ReadonlyArray<IREdge>,
  layoutOptions: Record<string, string>,
): ElkGraphIn {
  // parent -> direct children. `undefined` key holds the roots (services).
  const childrenOf = new Map<string | undefined, IRNode[]>();
  for (const n of nodes) {
    const key = n.parentId;
    const list = childrenOf.get(key);
    if (list) list.push(n);
    else childrenOf.set(key, [n]);
  }

  // We assign each edge to the lowest container that contains both endpoints
  // ("least common ancestor"). ELK with `INCLUDE_CHILDREN` will route edges
  // hierarchically as long as we put each edge at the correct level — putting
  // a function-to-function edge at the root would force ELK to route it past
  // its parents' boundaries instead of inside them.
  const parentOf = new Map<string, string | undefined>();
  for (const n of nodes) parentOf.set(n.id, n.parentId);
  const edgesByContainer = new Map<string | undefined, ElkEdgeIn[]>();
  for (const e of edges) {
    if (!parentOf.has(e.source) || !parentOf.has(e.target)) continue;
    const lca = leastCommonAncestor(e.source, e.target, parentOf);
    const list = edgesByContainer.get(lca);
    const ee: ElkEdgeIn = { id: e.id, sources: [e.source], targets: [e.target] };
    if (list) list.push(ee);
    else edgesByContainer.set(lca, [ee]);
  }

  const buildNode = (n: IRNode): ElkNodeIn => {
    const size = sizeOf(n);
    const kids = childrenOf.get(n.id);
    const node: ElkNodeIn = {
      id: n.id,
      width: size.width,
      height: size.height,
    };
    if (kids && kids.length > 0) {
      node.children = kids.map(buildNode);
      const containerEdges = edgesByContainer.get(n.id);
      if (containerEdges) node.edges = containerEdges;
    }
    return node;
  };

  const roots = (childrenOf.get(undefined) ?? []).map(buildNode);

  return {
    id: 'root',
    layoutOptions,
    children: roots,
    edges: edgesByContainer.get(undefined) ?? [],
  };
}

function leastCommonAncestor(
  a: string,
  b: string,
  parentOf: Map<string, string | undefined>,
): string | undefined {
  // We need the *parent container* the edge should live on, which is the
  // lowest node that contains both endpoints. ELK requires an edge to be
  // declared on a container that strictly contains its endpoints — so for an
  // edge from a function `f` to its own parent module `m`, the edge goes on
  // `m`'s parent (the service), not on `m` itself.
  //
  // Implementation: collect a's strict ancestor chain (its parents, walking
  // up; not `a` itself), then walk b's strict ancestor chain looking for the
  // first hit. The synthetic root is `undefined` and is the universal common
  // ancestor — top-level edges live there.
  const strictAncestorsOfA = new Set<string | undefined>();
  let cursor = parentOf.get(a);
  while (cursor !== undefined) {
    strictAncestorsOfA.add(cursor);
    cursor = parentOf.get(cursor);
  }
  strictAncestorsOfA.add(undefined);

  cursor = parentOf.get(b);
  while (cursor !== undefined) {
    if (strictAncestorsOfA.has(cursor)) return cursor;
    cursor = parentOf.get(cursor);
  }
  return undefined;
}

// ---------- legacy: computeLayout ----------

/**
 * Backwards-compatible entry point used by `Graph.tsx` today.
 *
 * Returns just the position map so the existing call site can keep working
 * unchanged while the rest of the viewer migrates to the richer `layout()`
 * result. New code should call `layout()` directly.
 */
export async function computeLayout(ir: IR): Promise<Map<string, Pos>> {
  const result = await layout(ir.nodes, ir.edges);
  const out = new Map<string, Pos>();
  for (const n of result.nodes) out.set(n.id, n.position);
  return out;
}

// ---------- public: useLayout() ----------

export type UseLayoutResult = {
  /** The positioned nodes once layout has resolved; empty until then. */
  nodes: PositionedNode[];
  /** Edges, filtered to those whose endpoints are present in `nodes`. */
  edges: IREdge[];
  /** Bounding size of the laid-out canvas. */
  width: number;
  height: number;
  /** True while a layout pass is in flight. */
  pending: boolean;
  /** Last layout error, if any. Resets on successful layout. */
  error: Error | null;
};

type GraphLike = {
  nodes: ReadonlyArray<IRNode>;
  edges: ReadonlyArray<IREdge>;
};

/**
 * React hook: schedule a layout pass when the graph changes.
 *
 * Reruns whenever the *identity* of `graph.nodes` or `graph.edges` changes.
 * The cache makes repeated invocations with equivalent content cheap, so
 * callers don't need to memoize their inputs aggressively. Pass `options` as
 * a stable reference (or omit it) — recreating the options object on every
 * render forces a fresh layout.
 */
export function useLayout(graph: GraphLike | null, options: LayoutOptions = {}): UseLayoutResult {
  const [state, setState] = useState<UseLayoutResult>({
    nodes: [],
    edges: [],
    width: 0,
    height: 0,
    pending: graph !== null,
    error: null,
  });

  // The latest pass id; we use it to ignore stale resolutions when the graph
  // changes mid-flight (StrictMode in dev, fast IR swaps).
  const passRef = useRef(0);

  // Stable serialization of `options` — the hook treats option changes that
  // produce the same ELK key as no-ops.
  const optionsKey = useMemo(
    () =>
      JSON.stringify({
        direction: options.direction,
        spacingNodeNode: options.spacingNodeNode,
        spacingBetweenLayers: options.spacingBetweenLayers,
        padding: options.padding,
      }),
    [options.direction, options.spacingNodeNode, options.spacingBetweenLayers, options.padding],
  );

  useEffect(() => {
    if (!graph) {
      setState({ nodes: [], edges: [], width: 0, height: 0, pending: false, error: null });
      return;
    }
    const myPass = ++passRef.current;
    setState((s) => ({ ...s, pending: true }));

    layout(graph.nodes, graph.edges, options)
      .then((r) => {
        if (passRef.current !== myPass) return;
        setState({
          nodes: r.nodes,
          edges: r.edges,
          width: r.width,
          height: r.height,
          pending: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (passRef.current !== myPass) return;
        setState((s) => ({
          ...s,
          pending: false,
          error: err instanceof Error ? err : new Error(String(err)),
        }));
      });
    // We intentionally depend on graph.nodes / graph.edges by identity rather
    // than deep-equal — see the doc comment above. The serialized optionsKey
    // captures option changes that actually matter to ELK.
  }, [graph?.nodes, graph?.edges, optionsKey]);

  return state;
}
