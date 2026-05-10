/**
 * React Flow nodeTypes registry — single import surface for App.jsx.
 *
 * The keys here become the `type` field on each rfNode in layoutRepo /
 * layoutFocus. Don't rename without updating the layout call sites.
 */
import FileNode from "./FileNode.jsx";
import FunctionNode, { fnNodeHeight } from "./FunctionNode.jsx";
import ClassNode, { classNodeHeight } from "./ClassNode.jsx";
import CellNode from "./CellNode.jsx";
import PackageNode from "./PackageNode.jsx";
import LayerNode from "./LayerNode.jsx";
import FileChip from "./FileChip.jsx";

export const nodeTypes = {
  rfile: FileNode,
  rfn: FunctionNode,
  rcls: ClassNode,
  rcell: CellNode,
  rpkg: PackageNode,
  rlayer: LayerNode,
  rchip: FileChip,
};

export { fnNodeHeight, classNodeHeight };
