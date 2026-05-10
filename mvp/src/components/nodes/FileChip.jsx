/**
 * FileChip — small file pill rendered inside a LayerNode in macro view.
 *
 * Compact intentionally: one line, monospace, language icon. The user
 * sees the file exists and roughly where; the def-level detail is one
 * click away in Files view.
 */
import { memo } from "react";
import { Handle, Position } from "reactflow";

const LANG_GLYPH = {
  ts: "TS",
  py: "PY",
  jupyter: "📓",
  go: "GO",
  rust: "RS",
  java: "JV",
  ruby: "RB",
  csharp: "C#",
  c: "C",
  cpp: "C++",
  kotlin: "KT",
  swift: "SW",
};

function FileChip({ data, selected }) {
  const lang = data?.lang || "";
  const inert = data?.analyzable === false;
  return (
    <div
      className={`rfn-chip ${inert ? "rfn-chip-inert" : ""} ${selected ? "rfn-chip-selected" : ""}`}
      title={data?.path || data?.label}
    >
      <Handle id="in"  type="target" position={Position.Left}  className="rfn-handle rfn-handle-chip" />
      <span className="rfn-chip-tag mono">{LANG_GLYPH[lang] || lang || "·"}</span>
      <span className="rfn-chip-name mono">{data?.label}</span>
      <Handle id="out" type="source" position={Position.Right} className="rfn-handle rfn-handle-chip" />
    </div>
  );
}

export default memo(FileChip);
