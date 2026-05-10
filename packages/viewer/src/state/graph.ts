import { create } from 'zustand';
import type { IR, Tier } from '../lib/load-ir';

/**
 * Global viewer state.
 *
 * We picked Zustand over Context+reducer because:
 *   - The store has 3 distinct concerns (IR, selection, filters) read by
 *     components in different parts of the tree. Selector-based subscriptions
 *     mean toggling a filter doesn't re-render the inspector, and clicking a
 *     node doesn't re-layout the canvas.
 *   - It composes cleanly with React 19 — no provider boilerplate.
 *   - `useGraphStore.getState()` is handy for non-React call sites (e.g. the
 *     React Flow `onSelectionChange` handler).
 */

/**
 * Edge categories from design/edge-typing.md §1. The 13 first-class categories
 * adapters are allowed to emit. Listed in spec order.
 */
export const EDGE_CATEGORIES = [
  'call',
  'import',
  'type-flow',
  'http-route',
  'db-read',
  'db-write',
  'env-read',
  'fs-read',
  'fs-write',
  'network',
  'exec',
  'message-publish',
  'message-consume',
] as const;

export type EdgeCategory = (typeof EDGE_CATEGORIES)[number];

export type TypeMatchMode = 'exact' | 'structural';

export type Filters = {
  /** Free-text search over node id + name. */
  query: string;
  /** Tier whitelist. Empty set = no tier filter applied. */
  tiers: Set<Tier>;
  /** Edge-category whitelist. Empty set = all categories pass. */
  categories: Set<EdgeCategory>;
  /** "Carry type" search — highlight edges whose canonical type matches. */
  type: string;
  /** Whether the type filter compares by exact canonical equality or substring. */
  typeMatch: TypeMatchMode;
};

type GraphState = {
  ir: IR | null;
  selectedId: string | null;
  /**
   * Currently drilled-in edge id. When non-null the inspector swaps the
   * node view for the type-drill panel (design/edge-typing.md §5).
   */
  drillEdgeId: string | null;
  filters: Filters;

  setIR: (ir: IR | null) => void;
  selectNode: (id: string | null) => void;
  drillIntoEdge: (id: string | null) => void;
  setFilter: (patch: Partial<Filters>) => void;
  resetFilters: () => void;
};

const defaultFilters = (): Filters => ({
  query: '',
  tiers: new Set<Tier>(),
  categories: new Set<EdgeCategory>(),
  type: '',
  typeMatch: 'structural',
});

export const useGraphStore = create<GraphState>((set) => ({
  ir: null,
  selectedId: null,
  drillEdgeId: null,
  filters: defaultFilters(),

  setIR: (ir) => set({ ir, selectedId: null, drillEdgeId: null }),
  selectNode: (id) => set({ selectedId: id, drillEdgeId: null }),
  drillIntoEdge: (id) => set({ drillEdgeId: id }),
  setFilter: (patch) =>
    set((state) => ({
      filters: { ...state.filters, ...patch },
    })),
  resetFilters: () => set({ filters: defaultFilters() }),
}));
