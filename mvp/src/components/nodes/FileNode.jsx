/**
 * FileNode — file container, shown as a React Flow `type: 'group'` so its
 * children (functions, classes, cells) layout inside.
 *
 * Visually: a header strip with the basename + lang tag, then the body is
 * just empty area where children render. The visual styling (border, fill,
 * inert dashed) comes from the layout function's inline `style` so the
 * theme can change without re-rendering the component.
 */
import { memo } from "react";

function FileNode({ data }) {
  const lang = data?.lang || "";
  const path = data?.path || data?.label || "";
  const inert = data?.analyzable === false;
  return (
    <div className={`rfn-file ${inert ? "rfn-file-inert" : ""}`}>
      <div className="rfn-file-header">
        <span className="rfn-file-icon" aria-hidden="true">▦</span>
        <span className="rfn-file-name mono">{data?.label || path}</span>
        {lang && <span className="rfn-file-lang">{lang}</span>}
      </div>
    </div>
  );
}

export default memo(FileNode);
