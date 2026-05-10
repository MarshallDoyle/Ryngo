/**
 * ClassNode — ComfyUI-style class box (Phase 4.2b).
 *
 * Layout:
 *   ┌──────────────────────────────────┐
 *   │ C  ClassName : Base, IFoo        │  ← header (with bases)
 *   ●─ extends Base                    │  ← left port for base class
 *   │  fields:                         ─●  method1
 *   │  - x: string                     ─●  method2
 *   │  - y: number = 0                 ─●  method3
 *   └──────────────────────────────────┘
 *
 * - Base classes appear as left-side handles (this class extends them).
 * - Methods appear as right-side handles (other code calls into them).
 * - Fields are inline rows in the body (no handle — fields are storage,
 *   not calls).
 */
import { memo } from "react";
import { Handle, Position } from "reactflow";
import { typeColor, typeLabel } from "../../lib/type-color.js";

const HEADER_H = 18;
const ROW_H = 14;
const MAX_VISIBLE_METHODS = 5;
const MAX_VISIBLE_FIELDS = 4;
const MAX_VISIBLE_BASES = 3;

export const classNodeHeight = (members, baseClasses) => {
  const methods = Math.min(members?.methods?.length || 0, MAX_VISIBLE_METHODS);
  const fields = Math.min(members?.fields?.length || 0, MAX_VISIBLE_FIELDS);
  const bases = Math.min(baseClasses?.length || 0, MAX_VISIBLE_BASES);
  const rows = Math.max(methods + fields, bases);
  return HEADER_H + Math.max(rows * ROW_H + 6, ROW_H + 6) + 6;
};

function ClassNode({ data, selected }) {
  const members = data?.members || {};
  const methods = (members.methods || []).slice(0, MAX_VISIBLE_METHODS);
  const fields = (members.fields || []).slice(0, MAX_VISIBLE_FIELDS);
  const bases = (data?.baseClasses || []).slice(0, MAX_VISIBLE_BASES);
  const hiddenMethods = (members.methods?.length || 0) - methods.length;
  const hiddenFields = (members.fields?.length || 0) - fields.length;

  return (
    <div className={`rfn-cls ${selected ? "rfn-cls-selected" : ""}`}>
      <div className="rfn-cls-header">
        <span className="rfn-cls-icon" aria-hidden="true">C</span>
        <span className="rfn-cls-name mono">{data?.label}</span>
        {bases.length > 0 && (
          <span className="rfn-cls-bases mono" title={bases.join(", ")}>
            : {bases.map((b) => b.split(/[<\[]/)[0]).join(", ")}
          </span>
        )}
      </div>

      <div className="rfn-cls-body">
        {/* Base-class handles on the left */}
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
        {bases.length === 0 && (
          /* default left handle so calls into the class can still resolve */
          <Handle id="default" type="target" position={Position.Left} className="rfn-handle" />
        )}

        {/* Field rows (no handles — these are properties) */}
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

        {/* Method handles on the right */}
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

      {/* Always include a fallback right handle for the default routing when
          methods aren't present or callers don't specify a sourceHandle. */}
      {methods.length === 0 && (
        <Handle id="default-out" type="source" position={Position.Right} className="rfn-handle" />
      )}
    </div>
  );
}

export default memo(ClassNode);
