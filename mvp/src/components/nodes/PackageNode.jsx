/**
 * PackageNode — small pill that represents an external dependency
 * (npm/pypi). One handle on the left so other nodes can call into it,
 * one on the right for completeness (rarely used, since packages don't
 * call into local code).
 */
import { memo } from "react";
import { Handle, Position } from "reactflow";

function PackageNode({ data }) {
  return (
    <div className="rfn-pkg">
      <Handle type="target" position={Position.Left} className="rfn-handle rfn-handle-pkg" />
      <span className="rfn-pkg-icon" aria-hidden="true">⬢</span>
      <span className="rfn-pkg-name mono">{data?.label}</span>
      <Handle type="source" position={Position.Right} className="rfn-handle rfn-handle-pkg" />
    </div>
  );
}

export default memo(PackageNode);
