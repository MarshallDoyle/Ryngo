/**
 * LayerNode — macro-view super-container (Phase 4.4).
 *
 * Renders a colored region for one stack layer (Frontend / Backend /
 * Data / Infra / Tests / Config / Other). The header shows the layer
 * name + summary stats (file count, routes, db models, env reads).
 * Children = file chips placed inside by the layout.
 *
 * Click the header → drill into that layer (filter Files view to its
 * members). Behavior wired in App.jsx.
 */
import { memo } from "react";
import { Handle, Position } from "reactflow";

const LAYER_GLYPH = {
  frontend: "▲",
  backend: "■",
  data: "●",
  infra: "✦",
  tests: "✓",
  config: "⚙",
  other: "·",
};

function LayerNode({ data }) {
  const layer = data.layer;
  const stats = [];
  if (data.routes) stats.push(`${data.routes} route${data.routes === 1 ? "" : "s"}`);
  if (data.dbModels) stats.push(`${data.dbModels} model${data.dbModels === 1 ? "" : "s"}`);
  if (data.envReads) stats.push(`${data.envReads} env`);
  if (data.defs && layer !== "config") stats.push(`${data.defs} def${data.defs === 1 ? "" : "s"}`);
  if (data.cells) stats.push(`${data.cells} cell${data.cells === 1 ? "" : "s"}`);
  return (
    <div className={`rfn-layer rfn-layer-${layer}`}>
      <Handle id="in"  type="target" position={Position.Left}  className="rfn-handle rfn-handle-layer" />
      <Handle id="out" type="source" position={Position.Right} className="rfn-handle rfn-handle-layer" />
      <div className="rfn-layer-header">
        <span className="rfn-layer-glyph" aria-hidden="true">
          {LAYER_GLYPH[layer]}
        </span>
        <span className="rfn-layer-name">{data.label}</span>
        <span className="rfn-layer-count mono">
          {data.fileCount} file{data.fileCount === 1 ? "" : "s"}
        </span>
        {stats.length > 0 && (
          <span className="rfn-layer-stats mono">
            {" · "}
            {stats.join(" · ")}
          </span>
        )}
      </div>
    </div>
  );
}

export default memo(LayerNode);
