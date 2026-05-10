import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { Node as IRNode } from '../lib/load-ir';

export function NodeModule({ data, selected }: NodeProps<{ node: IRNode } & Record<string, unknown>>) {
  const n = (data as { node: IRNode }).node;
  return (
    <div
      className={
        'min-w-44 rounded-md border px-3 py-2 shadow-sm ' +
        'border-sky-500 bg-sky-50 text-sky-950 ' +
        'dark:bg-sky-950 dark:text-sky-50 ' +
        (selected ? 'ring-2 ring-sky-400' : '')
      }
    >
      <div className="text-[10px] font-medium uppercase tracking-wider text-sky-600 dark:text-sky-300">
        module
      </div>
      <div className="truncate text-sm font-medium">{n.name}</div>
      {n.provenance?.file && (
        <div className="truncate text-[10px] text-sky-700 dark:text-sky-300">
          {n.provenance.file}
        </div>
      )}
      <Handle type="target" position={Position.Top} className="!bg-sky-500" />
      <Handle type="source" position={Position.Bottom} className="!bg-sky-500" />
    </div>
  );
}
