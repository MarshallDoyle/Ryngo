import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { Node as IRNode } from '../lib/load-ir';

export function NodeExpression({ data, selected }: NodeProps<{ node: IRNode } & Record<string, unknown>>) {
  const n = (data as { node: IRNode }).node;
  return (
    <div
      className={
        'min-w-32 rounded-sm border px-2 py-1 shadow-sm ' +
        'border-rose-400 bg-rose-50 text-rose-950 ' +
        'dark:bg-rose-950 dark:text-rose-50 ' +
        (selected ? 'ring-2 ring-rose-400' : '')
      }
    >
      <div className="text-[9px] font-medium uppercase tracking-wider text-rose-600 dark:text-rose-300">
        expr
      </div>
      <div className="truncate font-mono text-xs">{n.name}</div>
      <Handle type="target" position={Position.Left} className="!bg-rose-400" />
      <Handle type="source" position={Position.Right} className="!bg-rose-400" />
    </div>
  );
}
