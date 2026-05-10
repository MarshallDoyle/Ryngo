/**
 * CellNode — Jupyter cell. Header-only by default; click the chevron
 * to expand and see the source preview. Layout uses the COLLAPSED
 * height as the size hint, so collapsed nodes pack tightly and
 * expanding briefly overflows (acceptable for v1).
 */
import { memo, useState } from "react";
import { Handle, Position } from "reactflow";

const PREVIEW_LINES = 3;

function CellNode({ data }) {
  const [expanded, setExpanded] = useState(false);
  const sourceLines = String(data?.source || "").split("\n");
  const visible = sourceLines.slice(0, PREVIEW_LINES);
  return (
    <div
      className={`rfn-cell ${expanded ? "rfn-cell-expanded" : "rfn-cell-collapsed"}`}
    >
      <Handle type="target" position={Position.Left} className="rfn-handle rfn-handle-cell" />
      <button
        type="button"
        className="rfn-cell-header"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
        title={expanded ? "Collapse" : "Expand"}
      >
        <span className="rfn-disclosure" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="rfn-cell-icon" aria-hidden="true">▢</span>
        <span className="rfn-cell-label mono">{data?.label}</span>
      </button>
      {expanded && (
        <pre className="rfn-cell-preview mono">
          {visible.join("\n")}
          {sourceLines.length > PREVIEW_LINES ? "\n…" : ""}
        </pre>
      )}
      <Handle type="source" position={Position.Right} className="rfn-handle rfn-handle-cell" />
    </div>
  );
}

export default memo(CellNode);
