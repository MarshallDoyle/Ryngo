/**
 * CellNode — Jupyter cell. Expanded by default so source previews are
 * visible immediately and hovering can keep the source pane anchored.
 */
import { memo, useState } from "react";
import { Handle, Position } from "reactflow";
import { emitSourceLine } from "./source-nav.js";

const PREVIEW_LINES = 3;

function CellNode({ data }) {
  const [expanded, setExpanded] = useState(true);
  const sourceLines = String(data?.source || "").split("\n");
  const visible = sourceLines.slice(0, PREVIEW_LINES);
  return (
    <div
      className={`rfn-cell ${expanded ? "rfn-cell-expanded" : "rfn-cell-collapsed"}`}
      onMouseEnter={() => emitSourceLine(data)}
      onFocus={() => emitSourceLine(data)}
    >
      <Handle type="target" position={Position.Left} className="rfn-handle rfn-handle-cell" />
      <button
        type="button"
        className="rfn-cell-header"
        onClick={(e) => {
          emitSourceLine(data);
          setExpanded((v) => !v);
        }}
        title={expanded ? "Collapse preview" : "Expand preview"}
      >
        <span className="rfn-disclosure" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="rfn-cell-icon" aria-hidden="true">▢</span>
        <span className="rfn-cell-label mono">{data?.label}</span>
        {data?.line && <span className="rfn-node-line mono">L{data.line}</span>}
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
