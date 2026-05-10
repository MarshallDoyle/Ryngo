import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { Node as IRNode } from '../lib/load-ir';

export function NodeFunction({ data, selected }: NodeProps<{ node: IRNode } & Record<string, unknown>>) {
  const n = (data as { node: IRNode }).node;
  const sig = n.signature ?? '';
  return (
    <div
      className={
        'min-w-40 rounded-md border px-3 py-2 shadow-sm ' +
        'border-amber-500 bg-amber-50 text-amber-950 ' +
        'dark:bg-amber-950 dark:text-amber-50 ' +
        (selected ? 'ring-2 ring-amber-400' : '')
      }
    >
      <div className="text-[10px] font-medium uppercase tracking-wider text-amber-600 dark:text-amber-300">
        function
      </div>
      <div className="truncate font-mono text-sm">{n.name}()</div>
      {sig && (
        <div className="truncate font-mono text-[10px] text-amber-800 dark:text-amber-200">
          {sig}
        </div>
      )}
      <Handle type="target" position={Position.Left} className="!bg-amber-500" />
      <Handle type="source" position={Position.Right} className="!bg-amber-500" />
    </div>
  );
}
