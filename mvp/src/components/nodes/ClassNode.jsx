/**
 * ClassNode — ComfyUI-style class box, header-only by default. Click
 * the chevron to expand and see base classes (left handles), methods
 * (right handles), and inline field rows.
 */
import { memo, useState } from "react";
import { Handle, Position } from "reactflow";
import { typeColor, typeLabel } from "../../lib/type-color.js";

const HEADER_H = 22;
const ROW_H = 14;
const MAX_VISIBLE_METHODS = 5;
const MAX_VISIBLE_FIELDS = 4;
const MAX_VISIBLE_BASES = 3;

export const classNodeHeight = (members, baseClasses, expanded = false) => {
  if (!expanded) return HEADER_H + 2;
  const methods = Math.min(members?.methods?.length || 0, MAX_VISIBLE_METHODS);
  const fields = Math.min(members?.fields?.length || 0, MAX_VISIBLE_FIELDS);
  const bases = Math.min(baseClasses?.length || 0, MAX_VISIBLE_BASES);
  const rows = Math.max(methods + fields, bases);
  return HEADER_H + Math.max(rows * ROW_H + 6, ROW_H + 6) + 6;
};

function ClassNode({ data, selected }) {
  const [expanded, setExpanded] = useState(false);
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
    >
      <button
        type="button"
        className="rfn-cls-header"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
        title={expanded ? "Collapse" : "Expand to see members + base classes"}
      >
        <span className="rfn-disclosure" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="rfn-cls-icon" aria-hidden="true">C</span>
        <span className="rfn-cls-name mono">{data?.label}</span>
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
          {bases.map((b, i) => (
            <div key={`b-${i}`} className="rfn-port-row rfn-port-left">
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
            <div key={`f-${i}`} className="rfn-cls-field mono" title={`${f.name}: ${f.typeDisplay || "any"}${f.default ? ` = ${f.default}` : ""}`}>
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
                title={ret ? `${m.name}() → ${typeLabel(ret)}` : `${m.name}()`}
              >
                <span
                  className="rfn-port-label rfn-cls-method mono"
                  style={{ color }}
                >
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
