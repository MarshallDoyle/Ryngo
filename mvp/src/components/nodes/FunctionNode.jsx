/**
 * FunctionNode — ComfyUI-style typed-port function box.
 *
 * Default state: COLLAPSED (header only). Click the chevron to expand
 * and see the signature line + per-param ports + return port. Layout
 * uses collapsed height by default for tight packing; expanding briefly
 * overflows the parent file container until the next layout pass.
 */
import { memo, useState } from "react";
import { Handle, Position } from "reactflow";
import { typeColor, typeLabel } from "../../lib/type-color.js";

const MAX_VISIBLE_PARAMS = 4;
const HEADER_H = 22;
const SIG_H = 14;
const PORT_H = 14;
const RETURN_BAND_H = 14;

export const fnNodeHeight = (params, hasReturnType, expanded = false) => {
  if (!expanded) return HEADER_H + 2;
  const visible = Math.min(params?.length || 0, MAX_VISIBLE_PARAMS);
  const portsH = visible > 0 ? visible * PORT_H + 4 : PORT_H + 4;
  return HEADER_H + SIG_H + portsH + (hasReturnType ? RETURN_BAND_H : 4) + 4;
};

function paramSignature(params) {
  if (!params || !params.length) return "()";
  const pieces = params.map((p) => {
    let s = p.name || "_";
    if (p.optional) s += "?";
    if (p.typeDisplay) s += `: ${p.typeDisplay}`;
    return s;
  });
  return `(${pieces.join(", ")})`;
}

function FunctionNode({ data, selected }) {
  const [expanded, setExpanded] = useState(false);
  const params = data?.params || [];
  const visible = params.slice(0, MAX_VISIBLE_PARAMS);
  const hidden = params.length - visible.length;
  const returnType = data?.returnType?.display || data?.returnType || null;
  const sig = `${paramSignature(params)}${returnType ? ` → ${returnType}` : ""}`;

  return (
    <div
      className={`rfn-fn ${selected ? "rfn-fn-selected" : ""} ${
        expanded ? "rfn-fn-expanded" : "rfn-fn-collapsed"
      }`}
    >
      <button
        type="button"
        className="rfn-fn-header"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
        title={expanded ? "Collapse" : "Expand to see params + return type"}
      >
        <span className="rfn-disclosure" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="rfn-fn-icon" aria-hidden="true">ƒ</span>
        <span className="rfn-fn-name mono">{data?.label}</span>
      </button>

      {/* Always render at least one default-position handle so call edges
          attach somewhere even when collapsed. Both sides for symmetry. */}
      <Handle id="default-in" type="target" position={Position.Left} className="rfn-handle" />
      <Handle id="default-out" type="source" position={Position.Right} className="rfn-handle" />

      {expanded && (
        <>
          <div className="rfn-fn-sig mono" title={sig}>
            {sig}
          </div>

          <div className="rfn-fn-ports rfn-fn-ports-in">
            {visible.length === 0 && (
              <PortRow id="default" side="left" label="" type={null} placeholder />
            )}
            {visible.map((p, i) => (
              <PortRow
                key={`p-${i}`}
                id={`p-${i}`}
                side="left"
                label={`${p.rest ? "…" : ""}${p.name}${p.optional ? "?" : ""}`}
                type={p.typeDisplay}
              />
            ))}
            {hidden > 0 && (
              <div className="rfn-fn-ellipsis mono">+{hidden} more</div>
            )}
          </div>

          <div className="rfn-fn-return">
            <PortRow id="return" side="right" label={returnType || "→"} type={returnType} />
          </div>
        </>
      )}
    </div>
  );
}

function PortRow({ id, side, label, type, placeholder }) {
  const color = placeholder ? "var(--muted)" : typeColor(type);
  const tooltip = type ? typeLabel(type) : "untyped";
  return (
    <div className={`rfn-port-row rfn-port-${side}`}>
      <Handle
        id={id}
        type={side === "left" ? "target" : "source"}
        position={side === "left" ? Position.Left : Position.Right}
        className="rfn-handle"
        style={{ background: color, borderColor: color }}
        title={tooltip}
      />
      {label && (
        <span
          className="rfn-port-label mono"
          title={tooltip}
          style={side === "right" ? { color } : undefined}
        >
          {label}
        </span>
      )}
    </div>
  );
}

export default memo(FunctionNode);
