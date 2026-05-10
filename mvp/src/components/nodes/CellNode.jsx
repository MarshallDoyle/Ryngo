/**
 * CellNode — Jupyter cell. Shows the cell index + label header, then the
 * first few lines of source as a monospace preview. One left/right handle
 * (cells call out to imported packages and back).
 */
import { memo } from "react";
import { Handle, Position } from "reactflow";

const PREVIEW_LINES = 3;

function CellNode({ data }) {
  const lines = String(data?.source || "")
    .split("\n")
    .slice(0, PREVIEW_LINES);
  return (
    <div className="rfn-cell">
      <Handle type="target" position={Position.Left} className="rfn-handle rfn-handle-cell" />
      <div className="rfn-cell-header">
        <span className="rfn-cell-icon" aria-hidden="true">▢</span>
        <span className="rfn-cell-label mono">{data?.label}</span>
      </div>
      <pre className="rfn-cell-preview mono">
        {lines.join("\n")}
        {String(data?.source || "").split("\n").length > PREVIEW_LINES ? "\n…" : ""}
      </pre>
      <Handle type="source" position={Position.Right} className="rfn-handle rfn-handle-cell" />
    </div>
  );
}

export default memo(CellNode);
