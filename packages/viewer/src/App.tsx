import { useEffect, useMemo, useState } from 'react';
import { Graph } from './components/Graph';
import { Inspector } from './components/Inspector';
import { loadIR } from './lib/load-ir';
import { useGraphStore } from './state/graph';
import type { Node as IRNode } from './lib/load-ir';

/**
 * Top-level layout:
 *
 *   +-------------------------------------------------------+
 *   | header (title, IR source picker)                      |
 *   +----------+--------------------------------+-----------+
 *   |          |                                |           |
 *   | sidebar  |          graph canvas          | inspector |
 *   | (search/ |        (React Flow v12)        | (selected |
 *   | filters) |                                |  node)    |
 *   |          |                                |           |
 *   +----------+--------------------------------+-----------+
 *
 * The sidebar and inspector both read from the Zustand store; the canvas
 * receives nodes/edges as props so React Flow can own its viewport state.
 */
export default function App() {
  const ir = useGraphStore((s) => s.ir);
  const setIR = useGraphStore((s) => s.setIR);
  const filters = useGraphStore((s) => s.filters);
  const setFilter = useGraphStore((s) => s.setFilter);
  const selectedId = useGraphStore((s) => s.selectedId);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // On mount, try to fetch the dev IR from /ir.json. Failing that is fine —
  // the user can still pick a URL or a local file from the sidebar.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadIR('/ir.json')
      .then((loaded) => {
        if (!cancelled) setIR(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setIR]);

  const filteredNodes: IRNode[] = useMemo(() => {
    if (!ir) return [];
    const q = filters.query.trim().toLowerCase();
    return ir.nodes.filter((n) => {
      if (filters.tiers.size > 0 && !filters.tiers.has(n.tier)) return false;
      if (q && !n.name.toLowerCase().includes(q) && !n.id.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [ir, filters]);

  const selected = useMemo(
    () => (ir && selectedId ? ir.nodes.find((n) => n.id === selectedId) ?? null : null),
    [ir, selectedId],
  );

  return (
    <div className="flex h-full w-full flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 px-4 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <span className="font-semibold">codegraph</span>
          <span className="text-xs text-neutral-500">viewer</span>
        </div>
        <IRSourcePicker
          onLoad={async (src) => {
            setLoading(true);
            setLoadError(null);
            try {
              const loaded = await loadIR(src);
              setIR(loaded);
            } catch (err) {
              setLoadError(err instanceof Error ? err.message : String(err));
            } finally {
              setLoading(false);
            }
          }}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800">
          <div className="border-b border-neutral-200 p-3 dark:border-neutral-800">
            <input
              type="search"
              placeholder="search nodes…"
              value={filters.query}
              onChange={(e) => setFilter({ query: e.target.value })}
              className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </div>
          <div className="border-b border-neutral-200 p-3 dark:border-neutral-800">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
              tiers
            </div>
            <div className="flex flex-wrap gap-1">
              {(['service', 'module', 'type', 'function', 'expression'] as const).map((t) => {
                const active = filters.tiers.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      const next = new Set(filters.tiers);
                      if (active) next.delete(t);
                      else next.add(t);
                      setFilter({ tiers: next });
                    }}
                    className={
                      'rounded-md border px-2 py-0.5 text-xs ' +
                      (active
                        ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                        : 'border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300')
                    }
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
              nodes ({filteredNodes.length})
            </div>
            <ul className="space-y-0.5">
              {filteredNodes.slice(0, 500).map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => useGraphStore.getState().selectNode(n.id)}
                    className={
                      'w-full truncate rounded px-2 py-1 text-left text-sm ' +
                      (selectedId === n.id
                        ? 'bg-neutral-200 dark:bg-neutral-800'
                        : 'hover:bg-neutral-100 dark:hover:bg-neutral-900')
                    }
                    title={n.id}
                  >
                    <span className="text-xs text-neutral-500">{n.tier}</span>{' '}
                    <span>{n.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* Canvas */}
        <main className="relative min-w-0 flex-1">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60 text-sm text-neutral-600 dark:bg-neutral-950/60 dark:text-neutral-300">
              loading IR…
            </div>
          )}
          {loadError && !ir && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 p-6 text-center">
              <div className="text-sm font-medium">No IR loaded.</div>
              <div className="max-w-md text-xs text-neutral-500">{loadError}</div>
              <div className="text-xs text-neutral-500">
                Drop an <code>ir.json</code> in <code>public/</code>, paste a URL, or pick a file.
              </div>
            </div>
          )}
          {ir && <Graph ir={ir} visibleNodeIds={new Set(filteredNodes.map((n) => n.id))} />}
        </main>

        {/* Inspector */}
        <aside className="w-80 shrink-0 border-l border-neutral-200 dark:border-neutral-800">
          <Inspector node={selected} ir={ir} />
        </aside>
      </div>
    </div>
  );
}

function IRSourcePicker({ onLoad }: { onLoad: (src: string | File) => void | Promise<void> }) {
  const [url, setUrl] = useState('');
  return (
    <div className="flex items-center gap-2 text-sm">
      <input
        type="url"
        placeholder="ir.json URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="w-64 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
      />
      <button
        type="button"
        onClick={() => url && onLoad(url)}
        className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        load
      </button>
      <label className="cursor-pointer rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800">
        file…
        <input
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onLoad(f);
          }}
        />
      </label>
    </div>
  );
}
