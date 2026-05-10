/**
 * FunctionNode — ComfyUI-style typed-port function box.
 *
 * Default state: expanded. The node is meant to be a navigation surface:
 * header, signature, ports, return type, warnings, and source location stay
 * visible so a user can understand the function without a second click.
 */
import { memo, useState } from "react";
import { Handle, Position } from "reactflow";
import { typeColor, typeLabel } from "../../lib/type-color.js";
import { emitSourceLine, lineLabel } from "./source-nav.js";

const MAX_VISIBLE_PARAMS = 4;
const HEADER_H = 30;
const META_H = 18;
const SIG_H = 18;
const PORT_H = 18;
const RETURN_BAND_H = 20;

export const fnNodeHeight = (params, hasReturnType, expanded = true) => {
  if (!expanded) return HEADER_H + 2;
  const visible = Math.min(params?.length || 0, MAX_VISIBLE_PARAMS);
  const portsH = visible > 0 ? visible * PORT_H + 6 : PORT_H + 6;
  return HEADER_H + META_H + SIG_H + portsH + (hasReturnType ? RETURN_BAND_H : 6) + 8;
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

function FunctionNode({ id, data, selected }) {
  const [expanded, setExpanded] = useState(true);
  // Phase 11.5 — when the user dismisses a warning, hide it
  // optimistically until the next analyze fetches the suppression-
  // filtered IR. Keyed by warning kind.
  const [dismissed, setDismissed] = useState(() => new Set());
  const [warningsOpen, setWarningsOpen] = useState(false);
  const params = data?.params || [];
  const visible = params.slice(0, MAX_VISIBLE_PARAMS);
  const hidden = params.length - visible.length;
  const returnType = data?.returnType?.display || data?.returnType || null;
  const sig = `${paramSignature(params)}${returnType ? ` → ${returnType}` : ""}`;
  const allWarnings = data?.warnings || [];
  const warnings = allWarnings.filter((w) => !dismissed.has(w.kind));
  const warningSeverity = warnings.length
    ? warnings.some((w) => w.severity === "high")
      ? "high"
      : warnings.some((w) => w.severity === "medium")
        ? "medium"
        : "low"
    : null;

  const dismissWarning = async (kind) => {
    // Optimistic local hide; persist via /api/ryngo-md/suppress.
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(kind);
      return next;
    });
    const repo =
      typeof window !== "undefined" ? window.__ryngoRepo : undefined;
    if (!repo || !id) return;
    try {
      await fetch("/api/ryngo-md/suppress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo,
          nodeId: id,
          kind,
          reason: "dismissed via viewer",
        }),
      });
    } catch {
      /* network failure: badge already hidden locally; refresh restores */
    }
  };

  return (
    <div
      className={`rfn-fn ${selected ? "rfn-fn-selected" : ""} ${
        expanded ? "rfn-fn-expanded" : "rfn-fn-collapsed"
      }${warningSeverity ? ` rfn-fn-warn-${warningSeverity}` : ""}`}
      onMouseEnter={() => emitSourceLine(data)}
      onFocus={() => emitSourceLine(data)}
    >
      <button
        type="button"
        className="rfn-fn-header"
        onClick={(e) => {
          emitSourceLine(data);
          setExpanded((v) => !v);
        }}
        title={expanded ? "Collapse details" : "Expand details"}
      >
        <span className="rfn-disclosure" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="rfn-fn-icon" aria-hidden="true">ƒ</span>
        <span className="rfn-fn-name mono">{data?.label}</span>
        {data?.line && (
          <span className="rfn-node-line mono" title={lineLabel(data)}>
            L{data.line}
          </span>
        )}
        {warnings.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            className={`rfn-warn rfn-warn-${warningSeverity}`}
            title={`${warnings.length} warning${warnings.length === 1 ? "" : "s"} — click to review + dismiss`}
            aria-label={`${warnings.length} warning${warnings.length === 1 ? "" : "s"}, click to review`}
            onClick={(e) => {
              e.stopPropagation();
              setWarningsOpen((v) => !v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                setWarningsOpen((v) => !v);
              }
            }}
          >
            ⚠ {warnings.length}
          </span>
        )}
      </button>
      {warningsOpen && warnings.length > 0 && (
        <div
          className="rfn-warn-panel"
          role="dialog"
          aria-label="Warnings"
          onClick={(e) => e.stopPropagation()}
        >
          {warnings.map((w, i) => (
            <div key={`${w.kind}-${i}`} className={`rfn-warn-row rfn-warn-row-${w.severity}`}>
              <span className="rfn-warn-row-kind mono">{w.kind}</span>
              <span className="rfn-warn-row-msg">{w.message}</span>
              <button
                type="button"
                className="rfn-warn-row-dismiss"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissWarning(w.kind);
                }}
                title="Dismiss this warning · saves to Ryngo.md"
                aria-label={`Dismiss ${w.kind}`}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="rfn-warn-panel-foot">
            Dismissals are saved to <code>Ryngo.md</code>.
          </div>
        </div>
      )}

      {/* Always render at least one default-position handle so call edges
          attach somewhere even when collapsed. Both sides for symmetry. */}
      <Handle id="default-in" type="target" position={Position.Left} className="rfn-handle" />
      <Handle id="default-out" type="source" position={Position.Right} className="rfn-handle" />

      {expanded && (
        <>
          <div
            className="rfn-node-meta-row mono"
            title={lineLabel(data) || "source line unknown"}
            onMouseEnter={() => emitSourceLine(data)}
          >
            <span>{data?.file?.split("/").slice(-1)[0] || data?.path || "source"}</span>
            <span>{params.length} param{params.length === 1 ? "" : "s"}</span>
            <span>{returnType ? "returns" : "no return type"}</span>
          </div>
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
                data={data}
              />
            ))}
            {hidden > 0 && (
              <div className="rfn-fn-ellipsis mono">+{hidden} more</div>
            )}
          </div>

          <div className="rfn-fn-return">
            <PortRow id="return" side="right" label={returnType || "→"} type={returnType} data={data} />
          </div>
        </>
      )}
    </div>
  );
}

function PortRow({ id, side, label, type, placeholder, data }) {
  const color = placeholder ? "var(--muted)" : typeColor(type);
  const tooltip = type ? typeLabel(type) : "untyped";
  return (
    <div
      className={`rfn-port-row rfn-port-${side}`}
      onMouseEnter={() => emitSourceLine(data)}
      title={`${label || "value"} · ${tooltip}${lineLabel(data) ? ` · ${lineLabel(data)}` : ""}`}
    >
      <Handle
        id={id}
        type={side === "left" ? "target" : "source"}
        position={side === "left" ? Position.Left : Position.Right}
        className="rfn-handle"
        style={{ background: color, borderColor: color }}
        title={`${tooltip}${lineLabel(data) ? ` · ${lineLabel(data)}` : ""}`}
      />
      {label && (
        <span
          className="rfn-port-label mono"
          title={`${tooltip}${lineLabel(data) ? ` · ${lineLabel(data)}` : ""}`}
          style={side === "right" ? { color } : undefined}
        >
          {label}
        </span>
      )}
    </div>
  );
}

export default memo(FunctionNode);
