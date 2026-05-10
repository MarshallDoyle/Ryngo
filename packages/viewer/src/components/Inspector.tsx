import { useMemo } from 'react';
import type { IR, Node as IRNode } from '../lib/load-ir';
import { useGraphStore } from '../state/graph';

type InspectorProps = {
  node: IRNode | null;
  ir: IR | null;
};

/**
 * Right-hand panel: provenance + edges + raw type info for the selected node.
 *
 * Edges are listed in two groups (incoming / outgoing), with each row clickable
 * to jump selection to the other endpoint.
 */
export function Inspector({ node, ir }: InspectorProps) {
  const selectNode = useGraphStore((s) => s.selectNode);

  const { incoming, outgoing } = useMemo(() => {
    if (!node || !ir) return { incoming: [], outgoing: [] };
    const incoming = ir.edges.filter((e) => e.target === node.id);
    const outgoing = ir.edges.filter((e) => e.source === node.id);
    return { incoming, outgoing };
  }, [node, ir]);

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">
        Select a node to inspect.
      </div>
    );
  }

  const nodeById = (id: string) => ir?.nodes.find((n) => n.id === id);

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3">
        <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          {node.tier}
        </div>
        <div className="break-all font-semibold">{node.name}</div>
        <div className="break-all text-xs text-neutral-500">{node.id}</div>
      </div>

      {node.provenance && (
        <Section title="Provenance">
          <div className="break-all font-mono text-xs">
            {node.provenance.file}
            {node.provenance.startLine != null && (
              <>
                :{node.provenance.startLine}
                {node.provenance.endLine != null && node.provenance.endLine !== node.provenance.startLine
                  ? `-${node.provenance.endLine}`
                  : ''}
              </>
            )}
          </div>
        </Section>
      )}

      {node.signature && (
        <Section title="Signature">
          <pre className="overflow-x-auto rounded bg-neutral-100 p-2 font-mono text-xs dark:bg-neutral-900">
            {node.signature}
          </pre>
        </Section>
      )}

      <Section title={`Outgoing (${outgoing.length})`}>
        <EdgeList edges={outgoing} otherEnd="target" resolve={nodeById} onPick={selectNode} />
      </Section>

      <Section title={`Incoming (${incoming.length})`}>
        <EdgeList edges={incoming} otherEnd="source" resolve={nodeById} onPick={selectNode} />
      </Section>

      {node.attributes && Object.keys(node.attributes).length > 0 && (
        <Section title="Attributes">
          <pre className="overflow-x-auto rounded bg-neutral-100 p-2 font-mono text-[11px] dark:bg-neutral-900">
            {JSON.stringify(node.attributes, null, 2)}
          </pre>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        {title}
      </div>
      {children}
    </div>
  );
}

function EdgeList({
  edges,
  otherEnd,
  resolve,
  onPick,
}: {
  edges: { id: string; source: string; target: string; kind: string }[];
  otherEnd: 'source' | 'target';
  resolve: (id: string) => IRNode | undefined;
  onPick: (id: string) => void;
}) {
  if (edges.length === 0) {
    return <div className="text-xs text-neutral-500">none</div>;
  }
  return (
    <ul className="space-y-0.5">
      {edges.map((e) => {
        const otherId = e[otherEnd];
        const other = resolve(otherId);
        return (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => onPick(otherId)}
              className="w-full truncate rounded px-1 py-0.5 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
              title={otherId}
            >
              <span className="text-neutral-500">{e.kind}</span>{' '}
              <span className="font-mono">{other ? other.name : otherId}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
