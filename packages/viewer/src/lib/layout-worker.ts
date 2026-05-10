/**
 * Layout web worker.
 *
 * Per `design/nested-nodes.md` §9 (performance), ELK layout for a 1000+ node
 * graph can stall the main thread for hundreds of ms. We push the work into a
 * dedicated worker so the canvas keeps animating (drag, zoom, fade) while a
 * fresh subtree layout is being computed.
 *
 * Message shape:
 *
 *   in:  { id: number, graph: ElkGraphIn }
 *   out: { id: number, ok: true,  result: ElkGraphOut }
 *      | { id: number, ok: false, error: string }
 *
 * The `id` is opaque and round-trips so the caller can match responses to its
 * pending requests (multiple in-flight layouts is supported — useful when the
 * user expands several containers in quick succession).
 *
 * Vite picks this up via `new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' })`
 * which the consumer (`layout.ts`) handles. No build wiring beyond that.
 */

// We deliberately avoid importing app types here — the worker is a leaf module
// so it stays small and swappable. The shapes are documented inline.

type ElkGraphIn = {
  id: string;
  layoutOptions?: Record<string, string>;
  children?: ElkNodeIn[];
  edges?: ElkEdgeIn[];
};
type ElkNodeIn = {
  id: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNodeIn[];
  edges?: ElkEdgeIn[];
};
type ElkEdgeIn = { id: string; sources: string[]; targets: string[] };

type ElkNodeOut = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNodeOut[];
  edges?: ElkEdgeOut[];
};
type ElkEdgeOut = {
  id: string;
  sections?: Array<{
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints?: Array<{ x: number; y: number }>;
  }>;
};
type ElkGraphOut = ElkNodeOut;

type Req = { id: number; graph: ElkGraphIn };
type Res =
  | { id: number; ok: true; result: ElkGraphOut }
  | { id: number; ok: false; error: string };

// elkjs ships ESM; the bundled build is what we want in a worker (it inlines
// the layout algorithms, avoiding a second nested-worker hop). The dynamic
// import keeps startup cheap when the worker spins up but no work has arrived.
let elkPromise: Promise<{ layout: (g: ElkGraphIn) => Promise<ElkGraphOut> }> | null = null;

async function getElk() {
  if (!elkPromise) {
    elkPromise = import('elkjs/lib/elk.bundled.js').then((mod) => {
      const ELK = (mod as unknown as { default: new () => { layout: (g: ElkGraphIn) => Promise<ElkGraphOut> } }).default;
      return new ELK();
    });
  }
  return elkPromise;
}

self.addEventListener('message', async (ev: MessageEvent<Req>) => {
  const { id, graph } = ev.data;
  try {
    const elk = await getElk();
    const result = await elk.layout(graph);
    const res: Res = { id, ok: true, result };
    (self as unknown as { postMessage: (m: Res) => void }).postMessage(res);
  } catch (err) {
    const res: Res = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as { postMessage: (m: Res) => void }).postMessage(res);
  }
});

// Keep TS happy — this file must be a module so the worker spec recognises it
// as `type: 'module'`. The empty export avoids accidental global merging.
export {};
