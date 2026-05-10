/**
 * ClassNode — ComfyUI-style class box. Expanded by default so bases,
 * methods, fields, and source line anchors are visible immediately.
 */
import { memo, useState } from "react";
import { Handle, Position } from "reactflow";
import { typeColor, typeLabel } from "../../lib/type-color.js";
import { emitSourceLine, lineLabel } from "./source-nav.js";

const HEADER_H = 30;
const META_H = 18;
const ROW_H = 18;
const MAX_VISIBLE_METHODS = 5;
const MAX_VISIBLE_FIELDS = 4;
const MAX_VISIBLE_BASES = 3;

export const classNodeHeight = (members, baseClasses, expanded = true) => {
  if (!expanded) return HEADER_H + 2;
  const methods = Math.min(members?.methods?.length || 0, MAX_VISIBLE_METHODS);
  const fields = Math.min(members?.fields?.length || 0, MAX_VISIBLE_FIELDS);
  const bases = Math.min(baseClasses?.length || 0, MAX_VISIBLE_BASES);
  const rows = Math.max(methods + fields, bases);
  return HEADER_H + META_H + Math.max(rows * ROW_H + 8, ROW_H + 8) + 8;
};

function ClassNode({ data, selected }) {
  const [expanded, setExpanded] = useState(true);
  const members = data?.members || {};
  const methods = (members.methods || []).slice(0, MAX_VISIBLE_METHODS);
  const fields = (members.fields || []).slice(0, MAX_VISIBLE_FIELDS);
  const bases = (data?.baseClasses || []).slice(0, MAX_VISIBLE_BASES);
  const hiddenMethods = (members.methods?.length || 0) - methods.length;
  const hiddenFields = (members.fields?.length || 0) - fields.length;

  return (
    <div
      className={`rfn-cls ${selected ? "rfn-cls-selected" : ""} ${
        expanded ? "rfn-cls-expanded" : "rfn-cls-collapsed"
      }`}
      onMouseEnter={() => emitSourceLine(data)}
      onFocus={() => emitSourceLine(data)}
    >
      <button
        type="button"
        className="rfn-cls-header"
        onClick={(e) => {
          emitSourceLine(data);
          setExpanded((v) => !v);
        }}
        title={expanded ? "Collapse details" : "Expand details"}
      >
        <span className="rfn-disclosure" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="rfn-cls-icon" aria-hidden="true">C</span>
        <span className="rfn-cls-name mono">{data?.label}</span>
        {data?.line && (
          <span className="rfn-node-line mono" title={lineLabel(data)}>
            L{data.line}
          </span>
        )}
        {bases.length > 0 && expanded && (
          <span className="rfn-cls-bases mono" title={bases.join(", ")}>
            : {bases.map((b) => b.split(/[<\[]/)[0]).join(", ")}
          </span>
        )}
      </button>

      <Handle id="default-in" type="target" position={Position.Left} className="rfn-handle" />
      <Handle id="default-out" type="source" position={Position.Right} className="rfn-handle" />

      {expanded && (
        <div className="rfn-cls-body">
          <div
            className="rfn-node-meta-row mono"
            title={lineLabel(data) || "source line unknown"}
            onMouseEnter={() => emitSourceLine(data)}
          >
            <span>{data?.file?.split("/").slice(-1)[0] || "source"}</span>
            <span>{members.methods?.length || 0} method{members.methods?.length === 1 ? "" : "s"}</span>
            <span>{members.fields?.length || 0} field{members.fields?.length === 1 ? "" : "s"}</span>
          </div>
          {bases.map((b, i) => (
            <div
              key={`b-${i}`}
              className="rfn-port-row rfn-port-left"
              onMouseEnter={() => emitSourceLine(data)}
              title={`${data?.label} extends ${b}${lineLabel(data) ? ` · ${lineLabel(data)}` : ""}`}
            >
              <Handle
                id={`base-${i}`}
                type="target"
                position={Position.Left}
                className="rfn-handle"
                style={{ background: typeColor(b), borderColor: typeColor(b), top: 14 + i * ROW_H }}
                title={`extends ${b}`}
              />
              <span className="rfn-port-label rfn-port-base mono">extends {b.split(/[<\[]/)[0]}</span>
            </div>
          ))}

          {fields.map((f, i) => (
            <div
              key={`f-${i}`}
              className="rfn-cls-field mono"
              title={`${f.name}: ${f.typeDisplay || "any"}${f.default ? ` = ${f.default}` : ""}${f.line ? ` · ${data?.file}:${f.line}` : ""}`}
              onMouseEnter={() => emitSourceLine(data, { line: f.line, label: f.name, kind: "field" })}
            >
              {f.line && <span className="rfn-member-line">L{f.line}</span>}
              <span className="rfn-cls-field-name">{f.name}</span>
              {f.typeDisplay && (
                <>
                  <span className="rfn-cls-field-sep">:</span>
                  <span
                    className="rfn-cls-field-type"
                    style={{ color: typeColor(f.typeDisplay) }}
                  >
                    {f.typeDisplay}
                  </span>
                </>
              )}
            </div>
          ))}
          {hiddenFields > 0 && (
            <div className="rfn-cls-ellipsis mono">+{hiddenFields} more fields</div>
          )}

          {methods.map((m, i) => {
            const ret = m.returnType?.display || m.returnType || null;
            const color = typeColor(ret);
            return (
              <div
                key={`m-${i}`}
                className="rfn-port-row rfn-port-right"
                title={`${ret ? `${m.name}() → ${typeLabel(ret)}` : `${m.name}()`}${m.line ? ` · ${data?.file}:${m.line}` : ""}`}
                onMouseEnter={() => emitSourceLine(data, { line: m.line, label: m.name, kind: "method" })}
              >
                <span
                  className="rfn-port-label rfn-cls-method mono"
                  style={{ color }}
                >
                  {m.line && <span className="rfn-member-line">L{m.line}</span>}
                  {m.name}()
                </span>
                <Handle
                  id={`m-${i}`}
                  type="source"
                  position={Position.Right}
                  className="rfn-handle"
                  style={{ background: color, borderColor: color, top: 14 + (bases.length + fields.length + i) * ROW_H }}
                />
              </div>
            );
          })}
          {hiddenMethods > 0 && (
            <div className="rfn-cls-ellipsis rfn-cls-ellipsis-right mono">+{hiddenMethods} more methods</div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ClassNode);
