/**
 * FunctionNode — ComfyUI-style typed-port function box (Phase 4.2b/c).
 *
 * Layout:
 *   ┌────────────────────────────────────┐
 *   │ ƒ  bar                             │  ← header
 *   │ (a: number, b: string) → boolean   │  ← signature line
 *   ●─ a: number                         │  ← param port (left)
 *   ●─ b: string                         │  ← param port (left)
 *   │                                    ─●  ← return port (right)
 *   └────────────────────────────────────┘
 *
 * Ports are color-coded by their type via `lib/type-color.js`. Hover a
 * port → tooltip with the full type string. Click → (future: highlight
 * every edge in the graph carrying the same type).
 *
 * If a function has no extracted params (untyped JS, or the parser
 * couldn't pick them up), we still render a single default left handle
 * so call edges have somewhere to attach.
 */
import { memo } from "react";
import { Handle, Position } from "reactflow";
import { typeColor, typeLabel } from "../../lib/type-color.js";

const MAX_VISIBLE_PARAMS = 4;
const HEADER_H = 18;
const SIG_H = 14;
const PORT_H = 14;
const RETURN_BAND_H = 14;

export const fnNodeHeight = (params, hasReturnType) => {
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
  const params = data?.params || [];
  const visible = params.slice(0, MAX_VISIBLE_PARAMS);
  const hidden = params.length - visible.length;
  const returnType = data?.returnType?.display || data?.returnType || null;
  const sig = `${paramSignature(params)}${returnType ? ` → ${returnType}` : ""}`;

  return (
    <div className={`rfn-fn ${selected ? "rfn-fn-selected" : ""}`}>
      <div className="rfn-fn-header">
        <span className="rfn-fn-icon" aria-hidden="true">ƒ</span>
        <span className="rfn-fn-name mono">{data?.label}</span>
      </div>
      <div className="rfn-fn-sig mono" title={sig}>
        {sig}
      </div>

      {/* Left side: one port per param (capped). When there are no params
          we still render one default handle so call-edges have a target. */}
      <div className="rfn-fn-ports rfn-fn-ports-in">
        {visible.length === 0 && (
          <PortRow
            id="default"
            side="left"
            label=""
            type={null}
            placeholder
          />
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

      {/* Right side: a single return port. Color picks up the return type. */}
      <div className="rfn-fn-return">
        <PortRow
          id="return"
          side="right"
          label={returnType || "→"}
          type={returnType}
        />
      </div>
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
