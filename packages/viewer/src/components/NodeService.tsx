import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { Node as IRNode } from '../lib/load-ir';
import {
  EDGE_COLOR,
  LANGUAGE_HEADER_TINT,
  PURE_BORDER,
  PURE_TEXT,
  SELECTION_RING,
  TIER_SIZE,
  readBoundaries,
  readLanguage,
  readNumber,
} from './nodes.shared';

type Data = { node: IRNode };

/**
 * Service tier — large card (480 x 280).
 *
 * Layout (nested-nodes.md §1.1):
 *   - Header strip tinted by language family. Holds the runtime badge and is
 *     the click target for selecting an expanded service.
 *   - Stats row: module / function / edge counts plus cycle warning.
 *   - Boundary chips: HTTP / DB / Queue:* — adapter-extracted, only signal
 *     visible when the service is collapsed.
 *   - Inbound ports on the left edge, outbound ports on the right edge.
 */
export function NodeService({
  data,
  selected,
}: NodeProps<{ node: IRNode } & Record<string, unknown>>) {
  const n = (data as Data).node;
  const lang = readLanguage(n);
  const moduleCount = readNumber(n, 'moduleCount');
  const functionCount = readNumber(n, 'functionCount');
  const edgeCount = readNumber(n, 'edgeCount');
  const cycleCount = readNumber(n, 'cycleCount');
  const runtime = n.attributes?.['runtime'];
  const boundaries = readBoundaries(n);

  return (
    <div
      data-cg-tier="service"
      data-cg-handle="card"
      style={{
        width: TIER_SIZE.service.width,
        minHeight: TIER_SIZE.service.height,
        borderColor: PURE_BORDER,
        color: PURE_TEXT,
        boxShadow: '0 6px 20px -8px rgba(0,0,0,0.25), 0 2px 4px rgba(0,0,0,0.06)',
        outline: selected ? `2px solid ${SELECTION_RING}` : 'none',
        outlineOffset: 2,
      }}
      className="relative flex flex-col overflow-hidden rounded-xl border-2 bg-white dark:bg-neutral-950"
      title={n.id}
    >
      {/* Header strip — clickable as the parent-selection handle (§3.2). */}
      <div
        data-cg-handle="parent"
        className="flex items-center justify-between px-4 py-2 text-white"
        style={{ backgroundColor: LANGUAGE_HEADER_TINT[lang], height: 32 }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="text-base leading-none">▣</span>
          <span className="truncate text-sm font-semibold">{n.name}</span>
        </div>
        {typeof runtime === 'string' && (
          <span className="rounded bg-black/25 px-1.5 py-0.5 text-[10px] font-medium tracking-wide">
            {runtime}
          </span>
        )}
      </div>

      {/* Provenance line (path under repo root). */}
      {n.provenance?.file && (
        <div className="truncate border-b px-4 py-1 font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
          {n.provenance.file}
        </div>
      )}

      {/* Stats row. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[11px] text-neutral-700 dark:text-neutral-300">
        {moduleCount != null && (
          <span>
            <span aria-hidden>◆</span> {moduleCount} modules
          </span>
        )}
        {functionCount != null && (
          <span>
            <span aria-hidden>ƒ</span> {functionCount} functions
          </span>
        )}
        {edgeCount != null && (
          <span>
            <span aria-hidden>↔</span> {edgeCount} edges
          </span>
        )}
        {cycleCount != null && cycleCount > 0 && (
          <span className="text-amber-700 dark:text-amber-400">
            <span aria-hidden>⚠</span> {cycleCount} {cycleCount === 1 ? 'cycle' : 'cycles'}
          </span>
        )}
      </div>

      <div className="flex-1" />

      {/* Boundary chips. */}
      {boundaries.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t px-4 py-2">
          {boundaries.map((b, i) => {
            const c = EDGE_COLOR[b.category];
            return (
              <span
                key={i}
                className="rounded border px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  borderColor: c.light,
                  color: c.light,
                  backgroundColor: 'rgba(255,255,255,0.6)',
                }}
              >
                {b.label}
              </span>
            );
          })}
        </div>
      )}

      {/* Ports: inbound left, outbound right. ELK targets these directly. */}
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        style={{ background: '#94A3B8', width: 8, height: 16, borderRadius: 2 }}
      />
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        style={{ background: '#94A3B8', width: 8, height: 16, borderRadius: 2 }}
      />
    </div>
  );
}
