import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { Node as IRNode } from '../lib/load-ir';

export function NodeType({ data, selected }: NodeProps<{ node: IRNode } & Record<string, unknown>>) {
  const n = (data as { node: IRNode }).node;
  return (
    <div
      className={
        'min-w-40 rounded-md border px-3 py-2 shadow-sm ' +
        'border-emerald-500 bg-emerald-50 text-emerald-950 ' +
        'dark:bg-emerald-950 dark:text-emerald-50 ' +
        (selected ? 'ring-2 ring-emerald-400' : '')
      }
    >
      <div className="text-[10px] font-medium uppercase tracking-wider text-emerald-600 dark:text-emerald-300">
        type
      </div>
      <div className="truncate font-mono text-sm">{n.name}</div>
      <Handle type="target" position={Position.Left} className="!bg-emerald-500" />
      <Handle type="source" position={Position.Right} className="!bg-emerald-500" />
    </div>
  );
}
