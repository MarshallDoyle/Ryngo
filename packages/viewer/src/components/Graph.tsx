import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeTypes,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { IR, Node as IRNode, Edge as IREdge } from '../lib/load-ir';
import { computeLayout } from '../lib/layout';
import { useGraphStore } from '../state/graph';
import { NodeService } from './NodeService';
import { NodeModule } from './NodeModule';
import { NodeType } from './NodeType';
import { NodeFunction } from './NodeFunction';
import { NodeExpression } from './NodeExpression';

const nodeTypes: NodeTypes = {
  service: NodeService,
  module: NodeModule,
  type: NodeType,
  function: NodeFunction,
  expression: NodeExpression,
};

type GraphProps = {
  ir: IR;
  visibleNodeIds: Set<string>;
};

/**
 * React Flow canvas. We translate IR nodes/edges to RF's shape, run an ELK
 * layout pass once per IR, and project the visibility filter onto `hidden`.
 *
 * Layout is computed off the unfiltered IR so positions stay stable as the
 * user toggles filters — hidden nodes simply disappear in place.
 */
export function Graph({ ir, visibleNodeIds }: GraphProps) {
  const selectedId = useGraphStore((s) => s.selectedId);
  const selectNode = useGraphStore((s) => s.selectNode);

  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [layoutPending, setLayoutPending] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLayoutPending(true);
    computeLayout(ir)
      .then((pos) => {
        if (!cancelled) {
          setPositions(pos);
          setLayoutPending(false);
        }
      })
      .catch((err) => {
        // Fall back to a naive grid so the canvas isn't blank on layout error.
        // eslint-disable-next-line no-console
        console.error('codegraph: layout failed, using grid fallback', err);
        if (!cancelled) {
          setPositions(gridFallback(ir.nodes));
          setLayoutPending(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ir]);

  const rfNodes: RFNode[] = useMemo(
    () =>
      ir.nodes.map((n) => {
        const p = positions.get(n.id) ?? { x: 0, y: 0 };
        return {
          id: n.id,
          type: n.tier,
          position: p,
          data: { node: n },
          hidden: !visibleNodeIds.has(n.id),
          selected: n.id === selectedId,
          ...(n.parentId && positions.has(n.parentId) ? { parentId: n.parentId } : {}),
        } satisfies RFNode;
      }),
    [ir.nodes, positions, visibleNodeIds, selectedId],
  );

  const rfEdges: RFEdge[] = useMemo(
    () =>
      ir.edges.map((e: IREdge) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.kind,
        hidden: !visibleNodeIds.has(e.source) || !visibleNodeIds.has(e.target),
        animated: e.kind === 'calls',
        data: { edge: e },
      })),
    [ir.edges, visibleNodeIds],
  );

  const onSelectionChange = ({ nodes }: OnSelectionChangeParams) => {
    const first = nodes[0];
    selectNode(first ? first.id : null);
  };

  return (
    <div className="h-full w-full">
      {layoutPending && (
        <div className="absolute right-4 top-4 z-10 rounded-md bg-white/80 px-2 py-1 text-xs text-neutral-700 shadow dark:bg-neutral-900/80 dark:text-neutral-200">
          laying out…
        </div>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onSelectionChange={onSelectionChange}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.05}
        maxZoom={2}
      >
        <Background gap={24} />
        <Controls position="bottom-right" />
        <MiniMap pannable zoomable position="bottom-left" />
      </ReactFlow>
    </div>
  );
}

function gridFallback(nodes: IRNode[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  nodes.forEach((n, i) => {
    out.set(n.id, { x: (i % cols) * 220, y: Math.floor(i / cols) * 120 });
  });
  return out;
}
