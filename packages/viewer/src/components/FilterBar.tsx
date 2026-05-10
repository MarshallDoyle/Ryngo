import { useEffect, useMemo, useRef } from 'react';
import {
  EDGE_CATEGORIES,
  useGraphStore,
  type EdgeCategory,
  type Filters,
  type TypeMatchMode,
} from '../state/graph';
import type { Tier } from '../lib/load-ir';
import {
  CATEGORY_GROUPS,
  edgeCategory,
  edgePassesFilters,
  filtersEqual,
  filtersToParams,
  paramsToFilters,
} from '../lib/filters';

const TIERS: readonly Tier[] = ['service', 'module', 'type', 'function', 'expression'];

/**
 * FilterBar — top-of-canvas chrome. Three controls per design/edge-typing.md §6:
 *
 *   1. Edge-category multi-select. Per the spec there are 13 first-class
 *      categories grouped into "data / control / effect" buckets — we render
 *      them in those groups so a colour-blind / keyboard user can scan them.
 *   2. Tier chips. Cheap multi-select to constrain the view to a single tier
 *      ("show only services") without moving to the sidebar.
 *   3. "Carry type X" input + match mode (exact | structural). Structural is
 *      the spec default because it's what users want most of the time —
 *      `User` should also light up `Promise<User>` and `User[]`.
 *
 * State lives in the Zustand store; we sync it bidirectionally with the URL
 * so the canvas view is shareable. The match mode + type query is the bit
 * that most often gets pasted into Slack threads, so it really is worth the
 * extra ~50 lines of history-push logic.
 */
export function FilterBar() {
  const filters = useGraphStore((s) => s.filters);
  const setFilter = useGraphStore((s) => s.setFilter);
  const ir = useGraphStore((s) => s.ir);

  // Match-count badge: when the user types a "carry type", we show
  // `42 edges carry User` next to the input. This is the §6 affordance and
  // is also a useful sanity check that the filter actually matched anything.
  const matchedEdgeCount = useMemo(() => {
    if (!ir) return 0;
    if (!filters.type.trim() && filters.categories.size === 0) return ir.edges.length;
    return ir.edges.reduce((acc, e) => (edgePassesFilters(e, filters) ? acc + 1 : acc), 0);
  }, [ir, filters]);

  useUrlSync(filters, setFilter);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-white/95 px-3 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95">
      <TierChips filters={filters} setFilter={setFilter} />

      <div className="h-5 w-px bg-neutral-200 dark:bg-neutral-800" />

      <CategoryMultiSelect filters={filters} setFilter={setFilter} />

      <div className="h-5 w-px bg-neutral-200 dark:bg-neutral-800" />

      <TypeSearch
        filters={filters}
        setFilter={setFilter}
        matchedEdgeCount={matchedEdgeCount}
        totalEdgeCount={ir?.edges.length ?? 0}
      />

      {(filters.query ||
        filters.type ||
        filters.tiers.size > 0 ||
        filters.categories.size > 0) && (
        <button
          type="button"
          onClick={() => useGraphStore.getState().resetFilters()}
          className="ml-auto rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          clear filters
        </button>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Tier chips
// -----------------------------------------------------------------------------

function TierChips({
  filters,
  setFilter,
}: {
  filters: Filters;
  setFilter: (patch: Partial<Filters>) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        tier
      </span>
      {TIERS.map((t) => {
        const active = filters.tiers.has(t);
        return (
          <button
            key={t}
            type="button"
            aria-pressed={active}
            onClick={() => {
              const next = new Set(filters.tiers);
              if (active) next.delete(t);
              else next.add(t);
              setFilter({ tiers: next });
            }}
            className={
              'rounded-full border px-2 py-0.5 text-xs transition-colors ' +
              (active
                ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800')
            }
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Category multi-select (grouped)
// -----------------------------------------------------------------------------

function CategoryMultiSelect({
  filters,
  setFilter,
}: {
  filters: Filters;
  setFilter: (patch: Partial<Filters>) => void;
}) {
  const all = filters.categories.size === 0;
  const ir = useGraphStore((s) => s.ir);

  // Per-category edge counts let the picker show "(0)" next to categories
  // that don't appear in the loaded IR, so users don't waste a click filtering
  // by a category that won't match anything.
  const counts = useMemo(() => {
    const out = new Map<EdgeCategory, number>();
    if (!ir) return out;
    for (const e of ir.edges) {
      const c = edgeCategory(e);
      if (c) out.set(c, (out.get(c) ?? 0) + 1);
    }
    return out;
  }, [ir]);

  return (
    <details className="relative">
      <summary
        className={
          'flex cursor-pointer list-none items-center gap-1 rounded-md border px-2 py-1 text-xs ' +
          (all
            ? 'border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900'
            : 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900')
        }
      >
        <span className="text-[10px] font-medium uppercase tracking-wider opacity-80">
          edges
        </span>
        <span>{all ? 'all categories' : `${filters.categories.size} categories`}</span>
        <span aria-hidden className="text-[10px] opacity-60">▾</span>
      </summary>
      <div className="absolute left-0 z-20 mt-1 w-72 rounded-md border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
        {Object.entries(CATEGORY_GROUPS).map(([group, cats]) => (
          <div key={group} className="mb-2 last:mb-0">
            <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-neutral-500">
              <span>{group}</span>
              <button
                type="button"
                onClick={() => {
                  const next = new Set(filters.categories);
                  const allOn = cats.every((c) => next.has(c));
                  if (allOn) cats.forEach((c) => next.delete(c));
                  else cats.forEach((c) => next.add(c));
                  setFilter({ categories: next });
                }}
                className="text-[10px] text-neutral-500 underline-offset-2 hover:underline"
              >
                toggle group
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {cats.map((c) => {
                const active = filters.categories.has(c);
                const count = counts.get(c) ?? 0;
                return (
                  <label
                    key={c}
                    className={
                      'flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs ' +
                      (count === 0
                        ? 'opacity-50 '
                        : 'hover:bg-neutral-100 dark:hover:bg-neutral-900 ')
                    }
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => {
                        const next = new Set(filters.categories);
                        if (active) next.delete(c);
                        else next.add(c);
                        setFilter({ categories: next });
                      }}
                      className="h-3 w-3"
                    />
                    <span className={CATEGORY_SWATCH_CLASS[c]} aria-hidden />
                    <span className="font-mono text-[11px]">{c}</span>
                    <span className="ml-auto text-[10px] text-neutral-500">{count}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
        {filters.categories.size > 0 && (
          <button
            type="button"
            onClick={() => setFilter({ categories: new Set() })}
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            clear category filter
          </button>
        )}
      </div>
    </details>
  );
}

/**
 * Inline colour swatches matching the design/edge-typing.md §3.1 palette.
 * Tailwind doesn't ship the exact hex values from the spec but the canvas
 * renderer does — the swatches here are coarse-grain "this category is in
 * the warm/cool/neutral bucket" markers so the dropdown is scannable.
 */
const CATEGORY_SWATCH_CLASS: Record<EdgeCategory, string> = {
  call: 'inline-block h-2 w-2 rounded-sm bg-slate-500',
  import: 'inline-block h-2 w-2 rounded-sm bg-gray-500',
  'type-flow': 'inline-block h-2 w-2 rounded-sm bg-blue-500',
  'http-route': 'inline-block h-2 w-2 rounded-sm bg-indigo-500',
  'db-read': 'inline-block h-2 w-2 rounded-sm bg-teal-500',
  'db-write': 'inline-block h-2 w-2 rounded-sm bg-red-500',
  'env-read': 'inline-block h-2 w-2 rounded-sm bg-lime-700',
  'fs-read': 'inline-block h-2 w-2 rounded-sm bg-orange-400',
  'fs-write': 'inline-block h-2 w-2 rounded-sm bg-orange-500',
  network: 'inline-block h-2 w-2 rounded-sm bg-amber-500',
  exec: 'inline-block h-2 w-2 rounded-sm bg-amber-700',
  'message-publish': 'inline-block h-2 w-2 rounded-sm bg-red-600',
  'message-consume': 'inline-block h-2 w-2 rounded-sm bg-teal-600',
};

// re-export so the inspector and type-drill panels paint with the same swatches.
export { CATEGORY_SWATCH_CLASS };

// -----------------------------------------------------------------------------
// Type search
// -----------------------------------------------------------------------------

function TypeSearch({
  filters,
  setFilter,
  matchedEdgeCount,
  totalEdgeCount,
}: {
  filters: Filters;
  setFilter: (patch: Partial<Filters>) => void;
  matchedEdgeCount: number;
  totalEdgeCount: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        carries
      </span>
      <input
        type="search"
        placeholder="type, e.g. User"
        value={filters.type}
        onChange={(e) => setFilter({ type: e.target.value })}
        // The "/" hotkey from design/edge-typing.md §7 routes here — the canvas
        // listens for it and focuses this input, hence the data attribute.
        data-focus-key="type-filter"
        className="w-44 rounded-md border border-neutral-300 bg-white px-2 py-1 font-mono text-xs outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
      />
      <div className="flex overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700">
        {(['structural', 'exact'] as TypeMatchMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setFilter({ typeMatch: m })}
            aria-pressed={filters.typeMatch === m}
            className={
              'px-2 py-1 text-xs ' +
              (filters.typeMatch === m
                ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                : 'bg-white text-neutral-700 hover:bg-neutral-100 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800')
            }
          >
            {m}
          </button>
        ))}
      </div>
      {filters.type.trim() && (
        <span className="text-[11px] text-neutral-500">
          {matchedEdgeCount} / {totalEdgeCount} edges
        </span>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// URL <-> filters bidirectional sync
// -----------------------------------------------------------------------------

/**
 * Sync filters with the URL search-params. Two directions:
 *
 *   - On mount, parse the current URL once and seed the store. This is what
 *     makes a `?type=User&match=structural` link reproducible.
 *   - When the store changes, replaceState the URL. We use replace, not push,
 *     because every keystroke in the type search would otherwise pollute the
 *     back/forward stack — the user expects "back" to leave the viewer, not
 *     to undo one filter change at a time.
 *
 * We also listen for `popstate` so browser back/forward navigates filter
 * states the user *did* push (which only happens if they share/open a link).
 */
function useUrlSync(filters: Filters, setFilter: (patch: Partial<Filters>) => void) {
  // Avoid the first-mount writer racing with the first-mount reader.
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const initial = paramsToFilters(new URLSearchParams(window.location.search));
    // Apply only the params that were actually present, so the existing
    // store defaults survive when the URL is empty.
    setFilter(initial);
  }, [setFilter]);

  useEffect(() => {
    const onPop = () => {
      const next = paramsToFilters(new URLSearchParams(window.location.search));
      setFilter(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [setFilter]);

  useEffect(() => {
    if (!seeded.current) return;
    const params = filtersToParams(filters);
    const current = new URLSearchParams(window.location.search);
    // Only write when the relevant params changed — leaves any unrelated
    // params (e.g. `?ir=...`) the rest of the app might care about untouched.
    const ourKeys = ['q', 'tier', 'cat', 'type', 'match'];
    const incoming = paramsToFilters(current);
    if (filtersEqual(incoming, filters)) return;
    for (const k of ourKeys) current.delete(k);
    for (const [k, v] of params) current.set(k, v);
    const search = current.toString();
    const url = `${window.location.pathname}${search ? '?' + search : ''}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', url);
  }, [filters]);
}
