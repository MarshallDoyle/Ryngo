import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import ContextMenu from "./components/ContextMenu.jsx";
import AnnotateModal from "./components/AnnotateModal.jsx";
import Dashboard from "./components/Dashboard.jsx";
import { diffNarrative } from "../lib/narrative.js";
import { nodeTypes, fnNodeHeight, classNodeHeight } from "./components/nodes/index.js";
import { classifyFiles, LAYER_ORDER, LAYER_LABEL } from "../lib/layers.js";

// ============================================================================
// Sizing / palette
// ============================================================================

// All layout gaps were bumped ~50% (Phase 4.4.1) so edges have room to
// route cleanly instead of weaving through nearly-touching nodes. Tighter
// numbers made the canvas feel cramped at first paste; this is the
// "breathing room" pass.
const FILE_HEADER = 36;
const FILE_PAD_X = 14;
const FILE_PAD_BOTTOM = 18;
const DEF_W = 250;
// DEF_H is a baseline — function/class/cell nodes pick variable heights via
// fnNodeHeight() / classNodeHeight() / CELL_H based on their data.
const DEF_H_MIN = 56;
const DEF_GAP = 10;
// Cells default to collapsed (header only); expanded reveals 3 source lines.
const CELL_H = 24;
const FILE_MIN_W = DEF_W + FILE_PAD_X * 2;
const FILE_MIN_H = FILE_HEADER + 14;
const PKG_W = 180;
const PKG_H = 36;

/**
 * Pick a height for a child node based on its kind + data. Cells are
 * fixed; functions vary with param count; classes vary with members +
 * bases.
 */
function kidHeight(node) {
  if (node.kind === "cell") return CELL_H;
  if (node.kind === "function") {
    return fnNodeHeight(node.data?.params || [], !!node.data?.returnType);
  }
  if (node.kind === "class") {
    return classNodeHeight(node.data?.members || {}, node.data?.baseClasses || []);
  }
  return DEF_H_MIN;
}
// Spacing for the grid fallback used when files have no inter-imports.
const GRID_GAP_X = 90;
const GRID_GAP_Y = 56;

// Two parallel palettes. Picked by theme. Both keep the same shape so
// every site that reads STYLE.* keeps working — only the values change.
const STYLE_DARK = {
  fileBg: "#0e1626",
  fileBgInert: "#0b1220",
  fileBorder: "#2c3a52",
  fileBorderInert: "#1f2937",
  fnBg: "#0b2030",
  fnBorder: "#1d4d7c",
  fnText: "#a5d8ff",
  classBg: "#2a1a3a",
  classBorder: "#7e22ce",
  classText: "#d8b4fe",
  cellBg: "#1a1f08",
  cellBorder: "#65a30d",
  cellText: "#bef264",
  pkgBg: "#1a1408",
  pkgBorder: "#fbbf24",
  pkgText: "#fbbf24",
  bgColor: "#030712", // canvas behind the React Flow grid
  gridColor: "#1f2937",
  miniNodePkg: "#3a2a08",
  miniNodeFn: "#0b2030",
  miniNodeCls: "#2a1a3a",
  miniNodeCell: "#1a1f08",
  miniNodeFile: "#0e1626",
  miniMask: "rgba(3,7,18,0.7)",
};

const STYLE_LIGHT = {
  fileBg: "#f4f1e3",       // matches --panel
  // Inert file (non-analyzable) needs ~10% L* delta from canvas so it reads
  // as "secondary" without disappearing. Earlier values blended into bg.
  fileBgInert: "#e3dfc8",
  fileBorder: "#a89b69",
  fileBorderInert: "#a89b69",
  fnBg: "#dbeafe",          // pale blue
  fnBorder: "#1d4ed8",
  fnText: "#1e3a8a",
  classBg: "#f3e8ff",
  classBorder: "#7e22ce",
  classText: "#581c87",
  cellBg: "#ecfccb",
  cellBorder: "#4d7c0f",
  cellText: "#365314",
  pkgBg: "#fef3c7",
  pkgBorder: "#b45309",
  pkgText: "#78350f",
  bgColor: "#fbfaf2",
  gridColor: "#d8d3b4",
  miniNodePkg: "#fde68a",
  miniNodeFn: "#bfdbfe",
  miniNodeCls: "#e9d5ff",
  miniNodeCell: "#d9f99d",
  miniNodeFile: "#ece9d6",
  miniMask: "rgba(251,250,242,0.7)",
};

const STYLE = STYLE_DARK; // legacy alias retained for any leftover refs;
                          // call sites now use the `style` arg threaded
                          // through layoutRepo / layoutFocus.

const monoFont =
  "ui-monospace, 'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace";

// ============================================================================
// Layout — repo view: files become group containers, kids are placed inside.
// ============================================================================

// Box-shadow stripes for Ryngo state — composable since each one targets a
// different edge of the node. annotated = green-top, intent = amber-right,
// pinned = volt-left.
const RYNGO_SHADOW = {
  annotated: "inset 0 4px 0 #4ade80",
  intent: "inset -4px 0 0 #fbbf24",
  pinned: "inset 4px 0 0 #c8ff3d",
};

function applyRyngoBadges(style, ryngo) {
  if (!ryngo) return style;
  const parts = [];
  if (ryngo.pinned) parts.push(RYNGO_SHADOW.pinned);
  if (ryngo.annotated) parts.push(RYNGO_SHADOW.annotated);
  if (ryngo.intent) parts.push(RYNGO_SHADOW.intent);
  if (parts.length === 0) return style;
  // Compose with any existing box-shadow (e.g. diff overlay's glow).
  const prior = style.boxShadow ? `${style.boxShadow}, ` : "";
  return { ...style, boxShadow: prior + parts.join(", ") };
}

function layoutRepo(rawNodes, rawEdges, ryngoState, pinnedSet, theme = "dark", aspectRatio = 16 / 10) {
  const STYLE = theme === "light" ? STYLE_LIGHT : STYLE_DARK;
  // Repo view shows only files (with their defs/cells inside). Packages
  // are intentionally hidden here: they only appear when you drill into
  // something that uses them. Same for any edge that touches a package.
  //
  // Diff-mode exception: when an IR comes from /api/diff, packages that
  // were ADDED or REMOVED are surfaced at root — that's the whole point
  // of the change-log view. Unchanged packages stay hidden.
  const isDiff = rawNodes.some((n) => n._diff);
  // Phase-5 adds node kinds the React Flow viewer doesn't yet render (Phase
  // 4.2's custom node components will handle them). Hide them from the graph
  // view but they remain in the IR for projections + dashboard stats.
  const VIEWER_KNOWN_KINDS = new Set([
    "file", "function", "class", "cell", "package",
  ]);
  const repoNodes = rawNodes.filter(
    (n) =>
      VIEWER_KNOWN_KINDS.has(n.kind) &&
      (n.kind !== "package" ||
        (isDiff && n._diff && n._diff !== "unchanged")),
  );
  const visibleIds = new Set(repoNodes.map((n) => n.id));
  const repoEdges = rawEdges.filter(
    (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
  );

  const childrenByParent = new Map();
  const topNodes = [];

  for (const n of repoNodes) {
    if (n.parentId) {
      if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
      childrenByParent.get(n.parentId).push(n);
    } else {
      topNodes.push(n);
    }
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => {
      // Cells sorted by index, defs by line.
      const ai = a.data?.index ?? a.data?.line ?? 0;
      const bi = b.data?.index ?? b.data?.line ?? 0;
      return ai - bi;
    });
  }

  const fileSize = new Map();
  for (const n of topNodes) {
    if (n.kind === "file") {
      const kids = childrenByParent.get(n.id) || [];
      const w = FILE_MIN_W;
      const h =
        kids.length === 0
          ? FILE_MIN_H
          : FILE_HEADER +
            kids.reduce((acc, k) => acc + kidHeight(k) + DEF_GAP, 0) -
            DEF_GAP +
            FILE_PAD_BOTTOM;
      fileSize.set(n.id, { w, h });
    }
  }

  // If no file imports another file, dagre would just stack everything in a
  // single rank — wastefully tall. Use a row-major grid in that case so
  // disconnected files spread out evenly.
  const hasInterFileEdges = repoEdges.some(
    (e) =>
      e.kind === "imports-file" ||
      (e.kind === "calls" &&
        e.source.startsWith("file:") &&
        e.target.startsWith("file:")),
  );

  const positions = new Map();
  if (hasInterFileEdges) {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    // rankdir LR for landscape windows, TB when the viewport is taller
    // than wide. Both gap dimensions bumped 50% (Phase 4.4.1) so edges
    // have room to route.
    const portrait = aspectRatio < 0.85;
    g.setGraph({
      rankdir: portrait ? "TB" : "LR",
      nodesep: 42,
      ranksep: 165,
      marginx: 48,
      marginy: 48,
    });

    for (const n of topNodes) {
      const { w, h } = fileSize.get(n.id) || { w: PKG_W, h: PKG_H };
      g.setNode(n.id, { width: w, height: h });
    }

    const idToParent = new Map();
    for (const n of repoNodes) idToParent.set(n.id, n.parentId);
    for (const e of repoEdges) {
      const sTop = idToParent.get(e.source) || e.source;
      const tTop = idToParent.get(e.target) || e.target;
      if (sTop === tTop) continue;
      g.setEdge(sTop, tTop);
    }
    dagre.layout(g);
    for (const n of topNodes) {
      const p = g.node(n.id);
      if (p) positions.set(n.id, { x: p.x, y: p.y });
    }
  } else {
    // Grid layout — sort by content count desc so dense files anchor each row.
    const sorted = [...topNodes].sort((a, b) => {
      const aw = (childrenByParent.get(a.id) || []).length;
      const bw = (childrenByParent.get(b.id) || []).length;
      return bw - aw;
    });
    // Aspect-aware column count. Goal: bounding box ≈ viewport aspect.
    // For a grid of N items each ~(w × h), choosing cols ≈
    // sqrt(N × aspect × h / w) makes the layout's W/H match aspect.
    // Floor at 1, ceiling at 6 so very-wide / very-tall windows don't
    // produce extreme single-row / single-column layouts.
    const aspectCols = Math.round(
      Math.sqrt(
        sorted.length *
          aspectRatio *
          (FILE_MIN_H + GRID_GAP_Y) /
          (FILE_MIN_W + GRID_GAP_X),
      ),
    );
    const cols = Math.max(1, Math.min(6, aspectCols || 1));
    const colW = FILE_MIN_W + GRID_GAP_X;
    let row = 0;
    let col = 0;
    let rowTop = 0;
    let rowMaxH = 0;
    for (const n of sorted) {
      if (col === cols) {
        rowTop += rowMaxH + GRID_GAP_Y;
        rowMaxH = 0;
        col = 0;
        row++;
      }
      const { w, h } = fileSize.get(n.id) || { w: FILE_MIN_W, h: FILE_MIN_H };
      // dagre returns CENTER coords; mimic that here so the rest of the
      // function works the same.
      const cx = col * colW + w / 2;
      const cy = rowTop + h / 2;
      positions.set(n.id, { x: cx, y: cy });
      if (h > rowMaxH) rowMaxH = h;
      col++;
    }
  }

  const rfNodes = [];

  for (const n of topNodes) {
    const pos = positions.get(n.id);
    if (!pos) continue;
    if (n.kind === "file") {
      const { w, h } = fileSize.get(n.id);
      const isAnalyzed = n.data?.analyzable;
      rfNodes.push({
        id: n.id,
        type: "group",
        data: { ...n.data, label: n.label, kind: n.kind },
        position: { x: pos.x - w / 2, y: pos.y - h / 2 },
        style: {
          width: w,
          height: h,
          background: isAnalyzed ? STYLE.fileBg : STYLE.fileBgInert,
          border: `1px ${isAnalyzed ? "solid" : "dashed"} ${
            isAnalyzed ? STYLE.fileBorder : STYLE.fileBorderInert
          }`,
          borderRadius: 6,
          padding: 0,
        },
      });
      // Header label inside the file.
      rfNodes.push({
        id: `${n.id}#header`,
        parentNode: n.id,
        extent: "parent",
        draggable: false,
        selectable: false,
        data: { label: n.label, kind: "file-header" },
        position: { x: 0, y: 0 },
        style: {
          width: w,
          height: FILE_HEADER,
          background: "transparent",
          border: 0,
          color: "#9ca3af",
          fontSize: 11,
          padding: "8px 12px",
          fontFamily: monoFont,
          pointerEvents: "none",
          userSelect: "none",
        },
      });
    } else if (n.kind === "package") {
      // Diff-mode surfaces added/removed packages at root; otherwise this
      // branch is unreachable (packages are filtered out).
      rfNodes.push({
        id: n.id,
        type: "rpkg",
        data: { ...n.data, label: n.label, kind: n.kind },
        position: { x: pos.x - PKG_W / 2, y: pos.y - PKG_H / 2 },
        style: { width: PKG_W, height: PKG_H },
      });
    }
  }

  for (const file of topNodes) {
    if (file.kind !== "file") continue;
    const kids = childrenByParent.get(file.id) || [];
    let y = FILE_HEADER;
    for (const c of kids) {
      const h = kidHeight(c);
      // Custom typed-port component per kind. The component owns the
      // visual; the layout owns the size + position. Param ports color
      // by type via lib/type-color.js.
      const type =
        c.kind === "cell"
          ? "rcell"
          : c.kind === "class"
            ? "rcls"
            : "rfn";
      rfNodes.push({
        id: c.id,
        parentNode: file.id,
        extent: "parent",
        type,
        data: { ...c.data, label: c.label, kind: c.kind },
        position: { x: FILE_PAD_X, y },
        style: { width: DEF_W, height: h },
      });
      y += h + DEF_GAP;
    }
  }

  const rfEdges = rawEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "bezier",
    data: { kind: e.kind, _diff: e._diff },
    style: edgeStyle(e.kind, false, false, theme),
    zIndex: e.kind === "calls" ? 5 : 1,
  }));

  // -- diff overlay + ryngo badges ----------------------------------------
  const rawNodeById = new Map(rawNodes.map((n) => [n.id, n]));
  const rawEdgeById = new Map(rawEdges.map((e) => [e.id, e]));
  const annot = ryngoState?.annotationsByNode || {};
  const intentByNode = ryngoState?.intentsByNode || {};
  for (const rfNode of rfNodes) {
    if (rfNode.id.endsWith("#header")) continue;
    const raw = rawNodeById.get(rfNode.id);
    if (raw?._diff) {
      rfNode.style = applyDiffNode(rfNode.style, raw._diff);
      rfNode.data = { ...rfNode.data, _diff: raw._diff };
    }
    const isAnnotated = !!annot[rfNode.id];
    const hasIntent = !!intentByNode[rfNode.id]?.length;
    const isPinned = !!pinnedSet?.has(rfNode.id);
    if (isAnnotated || hasIntent || isPinned) {
      rfNode.style = applyRyngoBadges(rfNode.style, {
        annotated: isAnnotated,
        intent: hasIntent,
        pinned: isPinned,
      });
      rfNode.data = {
        ...rfNode.data,
        _ryngoAnnotated: isAnnotated,
        _ryngoIntent: hasIntent,
        _ryngoPinned: isPinned,
      };
    }
  }
  for (const rfEdge of rfEdges) {
    const raw = rawEdgeById.get(rfEdge.id);
    if (raw?._diff) {
      rfEdge.style = applyDiffEdge(rfEdge.style, raw._diff);
      rfEdge.data = { ...rfEdge.data, _diff: raw._diff };
    }
  }

  return { nodes: rfNodes, edges: rfEdges };
}

// Edge colors per theme. The dark variants match the React Flow nodes' fill
// hues; the light variants are darker analogues that hold contrast on a warm
// off-white canvas. Wired through `theme` so a green call-edge doesn't ghost
// against the cream background.
const EDGE_COLORS_DARK = {
  "imports-file": "#60a5fa",
  "imports-package": "#fbbf24",
  calls: "#86efac",
};
const EDGE_COLORS_LIGHT = {
  "imports-file": "#1d4ed8",
  "imports-package": "#92400e",
  calls: "#15803d",
};

function edgeStyle(kind, highlighted, dimmed, theme = "dark") {
  const palette = theme === "light" ? EDGE_COLORS_LIGHT : EDGE_COLORS_DARK;
  const stroke = palette[kind] || palette.calls;
  // Cross-file imports are visually load-bearing — they're the spine of
  // the repo graph — so they get a bolder default stroke than calls or
  // package imports.
  const baseWidth = kind === "imports-file" ? 1.6 : 1.15;
  return {
    stroke,
    strokeWidth: highlighted ? Math.max(baseWidth, 1.7) : baseWidth,
    opacity: dimmed ? 0.08 : highlighted ? 1 : 0.78,
  };
}

// ============================================================================
// Layout — macro / "Layers" view (Phase 4.4).
//
// One super-container per non-empty stack layer (FE / BE / Data / Infra /
// Tests / Config / Other), files render as compact chips inside, and
// cross-layer relationships collapse into aggregate edges with counts.
// Default for first paste so the user sees product structure before code.
// ============================================================================

const LAYER_GAP_X = 90;
const LAYER_GAP_Y = 90;
const LAYER_HEADER = 40;
const LAYER_PAD = 18;
const CHIP_W = 200;
const CHIP_H = 22;
const CHIP_GAP_X = 12;
const CHIP_GAP_Y = 6;
const CHIPS_PER_ROW = 2;
const MAX_CHIPS_VISIBLE = 30;

function sizeForLayer(stats) {
  const visible = Math.min(stats.files.length, MAX_CHIPS_VISIBLE);
  const overflow = stats.files.length - visible;
  const rows = Math.max(1, Math.ceil(visible / CHIPS_PER_ROW)) + (overflow > 0 ? 1 : 0);
  const w = LAYER_PAD * 2 + CHIPS_PER_ROW * CHIP_W + (CHIPS_PER_ROW - 1) * CHIP_GAP_X;
  const h = LAYER_HEADER + rows * (CHIP_H + CHIP_GAP_Y) + LAYER_PAD;
  return { w, h };
}

/**
 * Layout the macro / Layers view from the same IR data the file view uses.
 * Returns { nodes, edges } in React-Flow shape, ready to render.
 *
 * @param showInert     If false (default), inert config / lockfile chips
 *                      are hidden inside their layer.
 * @param aspectRatio   Window aspect ratio (width / height). The wrap
 *                      width is derived from total content area × this
 *                      ratio so the rendered bounding box matches the
 *                      user's viewport instead of stretching arbitrarily.
 */
function layoutLayers(rawNodes, rawEdges, theme = "dark", showInert = false, aspectRatio = 16 / 10) {
  // Synthesize an IR-shape input for the classifier.
  const classification = classifyFiles({ nodes: rawNodes, edges: rawEdges });
  const fileById = new Map();
  for (const n of rawNodes) {
    if (n.kind === "file") fileById.set(n.id, n);
  }

  // Pre-compute layer sizes so we can derive a viewport-matching wrap
  // width from total content area instead of a hardcoded threshold.
  const orderedLayers = [];
  let totalArea = 0;
  for (const layer of LAYER_ORDER) {
    const stats = classification.layers[layer];
    if (stats.files.length === 0) continue;
    const size = sizeForLayer(stats);
    orderedLayers.push({ layer, stats, ...size });
    totalArea += (size.w + LAYER_GAP_X) * (size.h + LAYER_GAP_Y);
  }
  const maxLayerW = orderedLayers.reduce((m, l) => Math.max(m, l.w), 0);
  // Target wrap width: `sqrt(totalArea × aspectRatio)` is the width of a
  // rectangle of that area whose aspect matches the viewport. Floor at
  // one layer wide so we never produce a layout narrower than its
  // widest member.
  const targetWrapWidth = Math.max(
    maxLayerW + LAYER_GAP_X,
    Math.sqrt(Math.max(1, totalArea) * aspectRatio),
  );

  const rfNodes = [];
  const layerPos = new Map();
  let cursorX = 0;
  let cursorY = 0;
  let rowMaxH = 0;

  for (const { layer, stats, w, h } of orderedLayers) {
    if (cursorX > 0 && cursorX + w > targetWrapWidth) {
      cursorX = 0;
      cursorY += rowMaxH + LAYER_GAP_Y;
      rowMaxH = 0;
    }
    const layerId = `layer:${layer}`;
    layerPos.set(layer, { x: cursorX, y: cursorY, w, h });
    rfNodes.push({
      id: layerId,
      type: "rlayer",
      data: {
        layer,
        label: LAYER_LABEL[layer],
        fileCount: stats.files.length,
        routes: stats.routes,
        dbModels: stats.dbModels,
        envReads: stats.envReads,
        defs: stats.defs,
        cells: stats.cells,
      },
      position: { x: cursorX, y: cursorY },
      style: { width: w, height: h },
    });

    // Chip children (filtered for inert by default).
    const visibleFileIds = [];
    for (const fid of stats.files) {
      const fileNode = fileById.get(fid);
      if (!fileNode) continue;
      if (!showInert && fileNode.data?.analyzable === false) continue;
      visibleFileIds.push(fid);
      if (visibleFileIds.length >= MAX_CHIPS_VISIBLE) break;
    }
    for (let i = 0; i < visibleFileIds.length; i++) {
      const fid = visibleFileIds[i];
      const f = fileById.get(fid);
      const col = i % CHIPS_PER_ROW;
      const row = Math.floor(i / CHIPS_PER_ROW);
      rfNodes.push({
        id: fid,
        type: "rchip",
        parentNode: layerId,
        extent: "parent",
        data: { ...f.data, label: f.label, kind: f.kind, layer },
        position: {
          x: LAYER_PAD + col * (CHIP_W + CHIP_GAP_X),
          y: LAYER_HEADER + row * (CHIP_H + CHIP_GAP_Y),
        },
        style: { width: CHIP_W, height: CHIP_H },
      });
    }
    const overflow = stats.files.length - visibleFileIds.length;
    if (overflow > 0) {
      const row = Math.ceil(visibleFileIds.length / CHIPS_PER_ROW);
      rfNodes.push({
        id: `${layerId}#overflow`,
        parentNode: layerId,
        extent: "parent",
        draggable: false,
        selectable: false,
        type: "default",
        data: { label: `+ ${overflow} more file${overflow === 1 ? "" : "s"}`, kind: "overflow" },
        position: { x: LAYER_PAD, y: LAYER_HEADER + row * (CHIP_H + CHIP_GAP_Y) },
        style: {
          width: CHIPS_PER_ROW * CHIP_W + (CHIPS_PER_ROW - 1) * CHIP_GAP_X,
          height: CHIP_H,
          background: "transparent",
          border: "0",
          color: "var(--muted)",
          fontSize: 10,
          textAlign: "left",
          padding: "0 8px",
          pointerEvents: "none",
        },
      });
    }
    cursorX += w + LAYER_GAP_X;
    if (h > rowMaxH) rowMaxH = h;
  }

  // -- Aggregate edges -----------------------------------------------------
  const fileForNode = (id) => {
    if (id.startsWith("file:")) return id;
    if (id.startsWith("cell:")) return `file:${id.replace(/^cell:/, "").split("#")[0]}`;
    if (id.startsWith("def:")) return `file:${id.replace(/^def:/, "").split("#")[0]}`;
    return null;
  };
  const bundles = new Map(); // key → { from, to, kind, count }
  for (const e of rawEdges) {
    if (e.kind !== "imports-file" && e.kind !== "calls") continue;
    const sFile = fileForNode(e.source);
    const tFile = fileForNode(e.target);
    if (!sFile || !tFile) continue;
    const sLayer = classification.byFile.get(sFile);
    const tLayer = classification.byFile.get(tFile);
    if (!sLayer || !tLayer || sLayer === tLayer) continue;
    const key = `${sLayer}->${tLayer}@${e.kind}`;
    if (!bundles.has(key)) {
      bundles.set(key, { from: sLayer, to: tLayer, kind: e.kind, count: 0 });
    }
    bundles.get(key).count++;
  }
  const rfEdges = [];
  for (const b of bundles.values()) {
    const baseStyle = edgeStyle(b.kind, false, false, theme);
    rfEdges.push({
      id: `layer:${b.from}=>layer:${b.to}@${b.kind}`,
      source: `layer:${b.from}`,
      target: `layer:${b.to}`,
      type: "bezier",
      label: `${b.count}`,
      data: { kind: b.kind, count: b.count, layerEdge: true },
      style: {
        ...baseStyle,
        strokeWidth: Math.min(8, 1 + Math.log2(b.count + 1) * 1.2),
        opacity: 0.85,
      },
      labelStyle: {
        fill: "var(--text)",
        fontSize: 11,
        fontFamily: monoFont,
        fontWeight: 600,
      },
      labelBgStyle: {
        fill: "var(--bg)",
        fillOpacity: 0.85,
      },
      labelBgPadding: [4, 6],
      labelBgBorderRadius: 3,
      zIndex: 5,
    });
  }
  return { nodes: rfNodes, edges: rfEdges, classification };
}

// ============================================================================
// Diff overlay — applied on top of the base node/edge styles when the IR
// carries `_diff` annotations from a `/api/diff` response.
// ============================================================================

const DIFF_NODE_OVERLAY = {
  added: {
    boxShadow: "0 0 16px 2px rgba(34, 197, 94, 0.45)",
    filter: "saturate(1.3)",
    borderColor: "#22c55e",
    borderStyle: "solid",
    borderWidth: 2,
  },
  removed: {
    opacity: 0.34,
    filter: "grayscale(0.85) saturate(0.4)",
    borderColor: "#7f1d1d",
    borderStyle: "dashed",
  },
};

const DIFF_EDGE_OVERLAY = {
  added: { stroke: "#22c55e", strokeWidth: 1.6, opacity: 1 },
  removed: {
    stroke: "#ef4444",
    strokeWidth: 1,
    opacity: 0.42,
    strokeDasharray: "4 3",
  },
};

function applyDiffNode(style, diff) {
  if (!diff || diff === "unchanged") return style;
  return { ...style, ...DIFF_NODE_OVERLAY[diff] };
}

function applyDiffEdge(style, diff) {
  if (!diff || diff === "unchanged") return style;
  return { ...style, ...DIFF_EDGE_OVERLAY[diff] };
}

// ============================================================================
// Layout — focus view: hub-and-spoke around a single node.
// ============================================================================

const FOCUS_HUB_W = 280;
const FOCUS_HUB_H = 64;
const FOCUS_SAT_W = 220;
const FOCUS_SAT_H = 40;

function layoutFocus(rawNodes, rawEdges, focusId, theme = "dark", aspectRatio = 16 / 10) {
  const STYLE = theme === "light" ? STYLE_LIGHT : STYLE_DARK;
  // Same VIEWER_KNOWN_KINDS gate as layoutRepo — Phase-5 adapter nodes are
  // hidden until Phase 4.2 lands custom renderers.
  const VIEWER_KNOWN_KINDS_FOCUS = new Set([
    "file", "function", "class", "cell", "package",
  ]);
  rawNodes = rawNodes.filter((n) => VIEWER_KNOWN_KINDS_FOCUS.has(n.kind));
  const focusNode = rawNodes.find((n) => n.id === focusId);
  if (!focusNode) return { nodes: [], edges: [] };

  // Gather connected nodes (1 hop in / out, plus parent for context).
  const inIds = new Set();
  const outIds = new Set();
  const relEdges = [];
  for (const e of rawEdges) {
    if (e.source === focusId) {
      outIds.add(e.target);
      relEdges.push(e);
    } else if (e.target === focusId) {
      inIds.add(e.source);
      relEdges.push(e);
    }
  }
  // For files / cells, also surface their children.
  if (focusNode.kind === "file") {
    for (const n of rawNodes) {
      if (n.parentId === focusId) outIds.add(n.id);
    }
  }

  const byId = new Map(rawNodes.map((n) => [n.id, n]));

  const incoming = [...inIds].map((id) => byId.get(id)).filter(Boolean);
  const outgoing = [...outIds].map((id) => byId.get(id)).filter(Boolean);

  // Position: hub in the middle, callers on the left, callees on the right.
  // Phase 4.4.2 — when there are many satellites, distribute them into a
  // multi-column grid sized to match the viewport aspect ratio instead of
  // stacking everything in one tall vertical column. The hub stays
  // centered between the two satellite blocks.
  const VGAP = 16;
  const HGAP = 24;
  const HUB_PAD = 80;

  const colsFor = (n) => {
    if (n <= 6) return 1;
    if (n <= 12) return 2;
    if (n <= 22) return Math.min(3, Math.round(Math.sqrt(n * 0.6 * aspectRatio)));
    return Math.min(5, Math.round(Math.sqrt(n * 0.6 * aspectRatio)));
  };

  /**
   * Stack n nodes into `cols` columns. Direction = -1 means satellites
   * grow leftward (callers); +1 means rightward (callees). Returns
   *   { placed: [{ node, x, y }], width, height }
   * so the hub can be repositioned between the two blocks.
   */
  const stackInColumns = (arr, direction) => {
    const cols = colsFor(arr.length);
    const rowsPerCol = Math.ceil(arr.length / cols);
    const colW = FOCUS_SAT_W + HGAP;
    const rowH = FOCUS_SAT_H + VGAP;
    const totalH = rowsPerCol * rowH - VGAP;
    const totalW = cols * colW - HGAP;
    const placed = [];
    for (let i = 0; i < arr.length; i++) {
      const col = Math.floor(i / rowsPerCol);
      const row = i % rowsPerCol;
      // Direction -1 (callers): rightmost column is closest to hub
      // Direction +1 (callees): leftmost column is closest to hub
      const colSlot = direction === -1 ? cols - 1 - col : col;
      const x = direction * (colSlot * colW + FOCUS_SAT_W / 2);
      const y = row * rowH - totalH / 2 + FOCUS_SAT_H / 2;
      placed.push({ node: arr[i], x, y });
    }
    return { placed, width: totalW, height: totalH };
  };

  const left = stackInColumns(incoming, -1);
  const right = stackInColumns(outgoing, +1);

  const hubX = 0;
  const hubY = 0;
  const leftEdge = -(left.width + HUB_PAD + FOCUS_HUB_W / 2);
  const rightEdge = right.width + HUB_PAD + FOCUS_HUB_W / 2;
  // Re-anchor satellites relative to the hub padding.
  const leftPlaced = left.placed.map((p) => ({
    ...p,
    x: p.x - HUB_PAD - FOCUS_HUB_W / 2,
  }));
  const rightPlaced = right.placed.map((p) => ({
    ...p,
    x: p.x + HUB_PAD + FOCUS_HUB_W / 2,
  }));
  void leftEdge;
  void rightEdge;

  const rfNodes = [];

  // Hub: blown-up custom-typed component if available, else the legacy
  // inline-styled fallback.
  const hubType = focusTypeFor(focusNode.kind);
  const hubW = focusNode.kind === "function" || focusNode.kind === "class" ? FOCUS_HUB_W : FOCUS_HUB_W;
  const hubH =
    focusNode.kind === "function"
      ? Math.max(FOCUS_HUB_H, fnNodeHeight(focusNode.data?.params, !!focusNode.data?.returnType) + 8)
      : focusNode.kind === "class"
        ? Math.max(FOCUS_HUB_H, classNodeHeight(focusNode.data?.members, focusNode.data?.baseClasses) + 8)
        : FOCUS_HUB_H;
  rfNodes.push({
    id: focusNode.id,
    type: hubType,
    data: {
      ...focusNode.data,
      label: focusNode.label,
      kind: focusNode.kind,
      _focus: true,
      _diff: focusNode._diff,
    },
    position: { x: hubX, y: hubY },
    style: applyDiffNode(
      hubType
        ? {
            width: hubW,
            height: hubH,
            boxShadow: "0 0 24px rgba(200, 255, 61, 0.15)",
          }
        : {
            width: FOCUS_HUB_W,
            height: FOCUS_HUB_H,
            background: hubBg(focusNode.kind, STYLE),
            color: hubFg(focusNode.kind, STYLE),
            border: `2px solid ${hubBorder(focusNode.kind, STYLE)}`,
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: 13,
            fontFamily: monoFont,
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            boxShadow: "0 0 24px rgba(200, 255, 61, 0.15)",
          },
      focusNode._diff,
    ),
  });

  for (const { node: n, x, y } of [...leftPlaced, ...rightPlaced]) {
    const satType = focusTypeFor(n.kind);
    const satH =
      n.kind === "function"
        ? fnNodeHeight(n.data?.params, !!n.data?.returnType)
        : n.kind === "class"
          ? classNodeHeight(n.data?.members, n.data?.baseClasses)
          : FOCUS_SAT_H;
    const satStyle = satType
      ? { width: FOCUS_SAT_W, height: satH }
      : {
          width: FOCUS_SAT_W,
          height: FOCUS_SAT_H,
          background: hubBg(n.kind, STYLE),
          color: hubFg(n.kind, STYLE),
          border: `1px solid ${hubBorder(n.kind, STYLE)}`,
          borderRadius: 4,
          padding: "4px 10px",
          fontSize: 11,
          fontFamily: monoFont,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "flex",
          alignItems: "center",
        };
    rfNodes.push({
      id: n.id,
      type: satType,
      data: { ...n.data, label: n.label, kind: n.kind, _diff: n._diff },
      position: { x, y },
      style: applyDiffNode(satStyle, n._diff),
    });
  }

  const rfEdges = relEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "bezier",
    data: { kind: e.kind, _diff: e._diff },
    style: applyDiffEdge(edgeStyle(e.kind, true, false, theme), e._diff),
    zIndex: 5,
  }));
  // Synthetic containment edges file → child for the file-focus case.
  if (focusNode.kind === "file") {
    for (const id of outIds) {
      const exists = rfEdges.some((e) => e.source === focusNode.id && e.target === id);
      if (!exists) {
        rfEdges.push({
          id: `${focusNode.id}=>${id}@contains`,
          source: focusNode.id,
          target: id,
          type: "bezier",
          data: { kind: "contains" },
          style: {
            stroke: "#475569",
            strokeWidth: 0.8,
            opacity: 0.5,
            strokeDasharray: "3 3",
          },
          zIndex: 1,
        });
      }
    }
  }

  return { nodes: rfNodes, edges: rfEdges, counts: { incoming: incoming.length, outgoing: outgoing.length } };
}

function focusTypeFor(kind) {
  switch (kind) {
    case "function": return "rfn";
    case "class":    return "rcls";
    case "cell":     return "rcell";
    case "package":  return "rpkg";
    default:         return undefined; // file + unknown → fall back to default React Flow node
  }
}

function hubBg(kind, STYLE) {
  switch (kind) {
    case "file": return STYLE.fileBg;
    case "function": return STYLE.fnBg;
    case "class": return STYLE.classBg;
    case "cell": return STYLE.cellBg;
    case "package": return STYLE.pkgBg;
    default: return STYLE.fileBg;
  }
}
function hubFg(kind, STYLE) {
  switch (kind) {
    case "function": return STYLE.fnText;
    case "class": return STYLE.classText;
    case "cell": return STYLE.cellText;
    case "package": return STYLE.pkgText;
    default: return STYLE === STYLE_LIGHT ? "#1a1a1a" : "#e5e7eb";
  }
}
function hubBorder(kind, STYLE) {
  switch (kind) {
    case "file": return STYLE.fileBorder;
    case "function": return STYLE.fnBorder;
    case "class": return STYLE.classBorder;
    case "cell": return STYLE.cellBorder;
    case "package": return STYLE.pkgBorder;
    default: return STYLE.fileBorder;
  }
}

// ============================================================================
// Highlight (repo view): selecting a node lights up its 1-hop neighbourhood.
// ============================================================================

function computeHighlight(rawNodes, rawEdges, selectedId) {
  if (!selectedId) return { nodeSet: null, edgeSet: null };
  const idToParent = new Map();
  for (const n of rawNodes) idToParent.set(n.id, n.parentId);

  const nodeSet = new Set([selectedId]);
  const edgeSet = new Set();
  for (const e of rawEdges) {
    if (e.source === selectedId) {
      nodeSet.add(e.target);
      edgeSet.add(e.id);
    } else if (e.target === selectedId) {
      nodeSet.add(e.source);
      edgeSet.add(e.id);
    }
  }
  for (const n of rawNodes) {
    if (n.parentId === selectedId) nodeSet.add(n.id);
  }
  for (const id of [...nodeSet]) {
    const p = idToParent.get(id);
    if (p) nodeSet.add(p);
  }
  return { nodeSet, edgeSet };
}

// ============================================================================
// Component
// ============================================================================

const SAMPLE_URLS = [
  "https://github.com/karpathy/autoresearch",
  "https://github.com/expressjs/express",
  "https://github.com/sindresorhus/p-queue",
  "https://github.com/vercel/ms",
];

// Parse various GitHub URL shapes the user might paste. Returns the canonical
// repo URL plus any ref/compare hints we can pull out of `/tree/branch`,
// `/compare/base...head`, or `/pull/123` URLs. PR shape is async: the caller
// resolves base/head via /api/pr.
function parseGithubInput(input) {
  const trimmed = (input || "").trim();
  const compare = trimmed.match(
    /^https:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)\/compare\/([^.\s]+)\.\.\.([^?#\/\s]+)/,
  );
  if (compare) {
    return {
      url: `https://github.com/${compare[1]}/${compare[2]}`,
      ref: decodeURIComponent(compare[4]),
      compareRef: decodeURIComponent(compare[3]),
    };
  }
  const pr = trimmed.match(
    /^https:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)\/pull\/(\d+)/,
  );
  if (pr) {
    return {
      url: `https://github.com/${pr[1]}/${pr[2]}`,
      pr: pr[3],
    };
  }
  const tree = trimmed.match(
    /^https:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)\/tree\/([^?#\s]+)/,
  );
  if (tree) {
    return {
      url: `https://github.com/${tree[1]}/${tree[2]}`,
      ref: decodeURIComponent(tree[3]),
      compareRef: "",
    };
  }
  return { url: trimmed, ref: "", compareRef: "" };
}

function repoFromUrl(url) {
  const m = (url || "").match(
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/,
  );
  return m ? `${m[1]}/${m[2]}` : null;
}

export default function App() {
  const [url, setUrl] = useState(SAMPLE_URLS[0]);
  const [ref, setRef] = useState(""); // "" → repo default branch
  const [compareRef, setCompareRef] = useState(""); // "" → no diff
  const [branches, setBranches] = useState({
    branches: [],
    tags: [],
    default: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [ir, setIr] = useState(null);
  const [agentViewModel, setAgentViewModel] = useState(null);
  const [selected, setSelected] = useState(null);

  // Ryngo annotation state (annotations / regions / intents) for the
  // current repo. Refreshed from /api/ryngo-state after every write.
  const [ryngoState, setRyngoState] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [annotateFor, setAnnotateFor] = useState(null);
  const [pinnedIds, setPinnedIds] = useState(() => new Set());

  // Top-level mode: which surface is shown. 'graph' is the React Flow canvas;
  // 'dashboard' is the PM summary cards.
  const [viewMode, setViewMode] = useState("graph");

  // Inside the graph mode, which layout: 'layers' (Phase 4.4 macro view —
  // FE / BE / Data / Infra / Tests / Config / Other super-nodes with
  // aggregated cross-layer edges) or 'files' (the original meso view).
  // Default to layers on first paste so the user sees product structure
  // before they see code. Persist their preference.
  const [graphView, setGraphView] = useState(() => {
    if (typeof window === "undefined") return "layers";
    const saved = window.localStorage.getItem("ryngoGraphView");
    return saved === "files" || saved === "layers" ? saved : "layers";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("ryngoGraphView", graphView);
    } catch {
      /* ignore storage errors */
    }
  }, [graphView]);

  // Slice A — show inert files (lockfiles, configs, READMEs) inside the
  // active layout. Off by default so the canvas looks curated.
  const [showInertFiles, setShowInertFiles] = useState(false);

  // Theme: 'light' is default; toggle persists in localStorage. Sets
  // <html data-theme="dark"> when dark, removes the attribute when light
  // so the :root CSS variables drive everything.
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem("ryngoTheme");
    if (saved === "light" || saved === "dark") return saved;
    return "light";
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (theme === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    try {
      window.localStorage.setItem("ryngoTheme", theme);
    } catch {
      // ignore — private mode etc.
    }
  }, [theme]);

  // Aspect ratio of the React Flow canvas. Used by layoutLayers and
  // layoutRepo to shape the rendered graph so its bounding box matches
  // the user's viewport — wide windows get wider rows of layers, tall
  // windows get taller stacks. Updates on resize so a user dragging the
  // window from landscape to portrait sees the layout reflow.
  const [aspectRatio, setAspectRatio] = useState(() => {
    if (typeof window === "undefined") return 16 / 10;
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 800;
    return Math.max(0.4, Math.min(4, w / h));
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const w = window.innerWidth || 1280;
        const h = window.innerHeight || 800;
        setAspectRatio(Math.max(0.4, Math.min(4, w / h)));
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(frame);
    };
  }, []);

  const toggleTheme = useCallback(() => {
    // Mark the document as transitioning so styles.css can fade colors
    // for ~1 s; the class is removed after the animation so hover states
    // don't stay slow. Only fires on user action — the initial-mount
    // theme application is instant.
    if (typeof document !== "undefined") {
      document.documentElement.classList.add("theming");
      window.setTimeout(() => {
        document.documentElement.classList.remove("theming");
      }, 1100);
    }
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const styleSet = theme === "light" ? STYLE_LIGHT : STYLE_DARK;

  const isDiffMode = !!ir?.diff;

  // Focus / drill-down stack — each entry is a node id. Top of stack is the
  // currently focused node. Empty stack = repo view.
  const [focusStack, setFocusStack] = useState([]);
  const focusedId = focusStack[focusStack.length - 1] || null;
  const focusedNode = useMemo(() => {
    if (!ir || !focusedId) return null;
    return ir.nodes.find((n) => n.id === focusedId) || null;
  }, [ir, focusedId]);

  // Refs to the underlying React Flow instances so click handlers can pan
  // and zoom the camera onto the clicked node.
  const repoFlow = useRef(null);
  const focusFlow = useRef(null);

  // ESC pops out of focus (one level), then clears selection.
  useEffect(() => {
    function onKey(e) {
      if (e.key !== "Escape") return;
      if (focusStack.length > 0) {
        e.preventDefault();
        setFocusStack((s) => s.slice(0, -1));
      } else if (selected) {
        e.preventDefault();
        setSelected(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusStack.length, selected]);

  // ----- repo view layout (memoized) -----
  const repoBase = useMemo(() => {
    if (!ir) return null;
    if (graphView === "layers") {
      return layoutLayers(ir.nodes, ir.edges, theme, showInertFiles, aspectRatio);
    }
    // Files view: optionally hide inert files from the meso layout too.
    const filteredNodes = showInertFiles
      ? ir.nodes
      : ir.nodes.filter(
          (n) => n.kind !== "file" || n.data?.analyzable !== false,
        );
    const visibleIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = ir.edges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
    );
    return layoutRepo(filteredNodes, filteredEdges, ryngoState, pinnedIds, theme, aspectRatio);
  }, [ir, ryngoState, pinnedIds, theme, graphView, showInertFiles, aspectRatio]);

  const repoHighlight = useMemo(() => {
    if (!ir || !selected) return { nodeSet: null, edgeSet: null };
    return computeHighlight(ir.nodes, ir.edges, selected.id);
  }, [ir, selected]);

  const repoLayout = useMemo(() => {
    if (!repoBase) return null;
    if (!repoHighlight.nodeSet) return repoBase;
    const { nodeSet, edgeSet } = repoHighlight;
    return {
      nodes: repoBase.nodes.map((n) => {
        const inspectId =
          n.id.endsWith("#header") && n.parentNode ? n.parentNode : n.id;
        const dimmed = !nodeSet.has(inspectId);
        return { ...n, style: { ...n.style, opacity: dimmed ? 0.18 : 1 } };
      }),
      edges: repoBase.edges.map((e) => {
        const high = edgeSet.has(e.id);
        return {
          ...e,
          style: edgeStyle(e.data.kind, high, !high, theme),
          zIndex: high ? 10 : 1,
        };
      }),
    };
  }, [repoBase, repoHighlight]);

  // ----- focus view layout -----
  const focusLayout = useMemo(() => {
    if (!ir || !focusedId) return null;
    return layoutFocus(ir.nodes, ir.edges, focusedId, theme, aspectRatio);
  }, [ir, focusedId, theme, aspectRatio]);

  // ----- branches: fetch per-repo on URL change so the datalist can autofill
  useEffect(() => {
    const repo = repoFromUrl(url);
    if (!repo) return;
    let cancelled = false;
    fetch(`/api/branches?repo=${encodeURIComponent(repo)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) return; // soft fail — user can still type a ref
        setBranches({
          branches: d.branches || [],
          tags: d.tags || [],
          default: d.default || "",
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);

  // ----- ryngo state -----
  const refreshRyngoState = useCallback(async (repo) => {
    if (!repo) return;
    try {
      const r = await fetch(
        `/api/ryngo-state?repo=${encodeURIComponent(repo)}`,
      );
      if (!r.ok) return;
      const data = await r.json();
      setRyngoState(data);
    } catch {
      // soft-fail; viewer still works without state
    }
  }, []);

  useEffect(() => {
    if (!ir?.repo) {
      setRyngoState(null);
      return;
    }
    refreshRyngoState(ir.repo);
  }, [ir?.repo, refreshRyngoState]);

  // ----- network -----
  const analyze = useCallback(
    async (overrides = {}) => {
      const target = overrides.url ?? url;
      const targetRef = overrides.ref ?? ref;
      const targetCompare = overrides.compareRef ?? compareRef;
      setLoading(true);
      setError(null);
      setIr(null);
      setAgentViewModel(null);
      setSelected(null);
      setFocusStack([]);
      setPinnedIds(new Set());
      setContextMenu(null);
      setAnnotateFor(null);
      try {
        let json;
        if (targetCompare) {
          const res = await fetch("/api/diff", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: target,
              base: targetCompare,
              head: targetRef || branches.default || "HEAD",
            }),
          });
          json = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        } else {
          const res = await fetch("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: target, ref: targetRef }),
          });
          json = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        }
        if (!json.ir) throw new Error("Server returned no `ir` payload.");
        setIr(json.ir);
        try {
          const vmRes = await fetch("/api/projection/view-model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ir: json.ir,
              mode: "overview",
              maxNodes: 80,
            }),
          });
          const vm = await vmRes.json().catch(() => null);
          if (vmRes.ok && vm?.version === 1) setAgentViewModel(vm);
        } catch {
          // Soft-fail: the canonical graph can render without the agent view.
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [url, ref, compareRef, branches.default],
  );

  // When the user pastes a URL, peel off ref / compare hints from /tree/...,
  // /compare/..., and /pull/<n> shapes so they don't have to set them
  // manually. /pull/<n> requires one extra fetch to GitHub to resolve the
  // base/head refs.
  const onUrlChange = useCallback(async (next) => {
    const parsed = parseGithubInput(next);
    setUrl(parsed.url);
    if (parsed.pr) {
      // resolve PR → base/head via the API
      const repo = repoFromUrl(parsed.url);
      if (repo) {
        try {
          const r = await fetch(
            `/api/pr?repo=${encodeURIComponent(repo)}&number=${parsed.pr}`,
          );
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.base && j.head) {
            setRef(j.head);
            setCompareRef(j.base);
            return;
          }
        } catch {
          // fall through; user can still set refs manually
        }
      }
    }
    if (parsed.ref) setRef(parsed.ref);
    if (parsed.compareRef) setCompareRef(parsed.compareRef);
  }, []);

  const onSubmit = useCallback(
    (e) => {
      e.preventDefault();
      if (loading) return;
      analyze();
    },
    [analyze, loading],
  );

  // ----- node interactions -----
  // Single-click pans + zooms the camera onto a node and shows the
  // inspector. Double-click drills (== Inspect node). Both handlers share
  // a `clickTimer` ref so that the camera pan from the first click
  // doesn't fire when a second click is on its way — otherwise React
  // Flow's hit detection during the animation can lose the second click.
  const drillIn = useCallback((nodeId) => {
    setSelected(null);
    setFocusStack((stack) => {
      if (stack[stack.length - 1] === nodeId) return stack;
      return [...stack, nodeId];
    });
  }, []);

  // Single-click runs immediately — no debounce. React Flow's hit testing
  // is keyed on DOM elements, so the camera animation from the first click
  // doesn't break the second click of a double-click. The earlier 220ms
  // click timer was the cause of the perceived "broken" double-click, not
  // the cure.
  const handleNodeClick = useCallback(
    (view, _evt, node) => {
      const id = node.id.endsWith("#header") ? node.parentNode : node.id;
      if (!ir) return;
      const irNode = ir.nodes.find((n) => n.id === id);
      if (!irNode) return;
      setSelected({
        id,
        data: { ...irNode.data, label: irNode.label, kind: irNode.kind },
      });
      const inst = view === "repo" ? repoFlow.current : focusFlow.current;
      inst?.fitView({
        nodes: [{ id }],
        padding: 0.45,
        duration: 400,
        maxZoom: 1.3,
      });
    },
    [ir],
  );

  const handleNodeDoubleClick = useCallback(
    (_view, _evt, node) => {
      const id = node.id.endsWith("#header") ? node.parentNode : node.id;
      drillIn(id);
    },
    [drillIn],
  );

  const onPaneClick = useCallback(() => {
    setSelected(null);
  }, []);

  // Inspector → drill. Same target as double-click.
  const onInspect = useCallback(() => {
    if (!selected) return;
    drillIn(selected.id);
  }, [selected, drillIn]);

  // Right-click handler — common to repo view and focus view. Opens our
  // custom Ryngo context menu and suppresses the browser's native one.
  const handleNodeContextMenu = useCallback(
    (evt, node) => {
      evt.preventDefault();
      if (!ir) return;
      const id = node.id.endsWith("#header") ? node.parentNode : node.id;
      const irNode = ir.nodes.find((n) => n.id === id);
      if (!irNode) return;
      setContextMenu({
        x: evt.clientX,
        y: evt.clientY,
        nodeId: id,
        nodeLabel: irNode.label,
        nodeKind: irNode.kind,
      });
    },
    [ir],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const onContextAnnotate = useCallback((ctx) => {
    setAnnotateFor({
      nodeId: ctx.nodeId,
      nodeLabel: ctx.nodeLabel,
      nodeKind: ctx.nodeKind,
    });
    setContextMenu(null);
  }, []);

  const onContextIntent = useCallback(
    async (ctx, kind) => {
      setContextMenu(null);
      if (!ir?.repo) return;
      try {
        const r = await fetch("/api/intents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: ir.repo,
            kind,
            nodeId: ctx.nodeId,
            nodeLabel: ctx.nodeLabel,
            // Snapshot the current IR with the intent so Apply-and-verify
            // can diff against it after the user's AI applies the change.
            ir: {
              repo: ir.repo,
              ref: ir.ref,
              nodes: ir.nodes,
              edges: ir.edges,
              stats: ir.stats,
            },
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setError(j.error || `intent ${kind} failed`);
          return;
        }
        await refreshRyngoState(ir.repo);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [ir, refreshRyngoState],
  );

  /**
   * Apply-and-verify — diff the current IR against the snapshot stored when
   * the intent was created. Backend computes the verdict and (if satisfied)
   * flips the intent's status to "done".
   */
  const onVerifyIntent = useCallback(
    async (intentId) => {
      if (!ir?.repo) return null;
      try {
        const r = await fetch(
          `/api/intents/${encodeURIComponent(intentId)}/verify`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repo: ir.repo,
              ir: {
                repo: ir.repo,
                ref: ir.ref,
                nodes: ir.nodes,
                edges: ir.edges,
                stats: ir.stats,
              },
            }),
          },
        );
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setError(j.error || `verify failed (${r.status})`);
          return null;
        }
        await refreshRyngoState(ir.repo);
        return j;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [ir, refreshRyngoState],
  );

  const onContextPin = useCallback(
    (ctx) => {
      setContextMenu(null);
      setPinnedIds((s) => {
        const next = new Set(s);
        if (next.has(ctx.nodeId)) next.delete(ctx.nodeId);
        else next.add(ctx.nodeId);
        return next;
      });
    },
    [],
  );

  const onAnnotateSubmit = useCallback(
    async ({ nodeId, text }) => {
      if (!ir?.repo) throw new Error("no repo loaded");
      const r = await fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: ir.repo,
          nodeId,
          text,
          author: "you",
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await refreshRyngoState(ir.repo);
    },
    [ir?.repo, refreshRyngoState],
  );

  const onExportCart = useCallback(async () => {
    if (!ir?.repo || pinnedIds.size === 0) return;
    try {
      const r = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: ir.repo,
          nodeIds: [...pinnedIds],
          ir: { nodes: ir.nodes, edges: ir.edges },
          label: `Ryngo cart from ${ir.repo}`,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `cart export failed (${r.status})`);
        return;
      }
      const md = await r.text();
      // Try the modern clipboard API; fall back to opening a new tab so the
      // user can copy manually.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
        // Brief in-page confirmation via the error banner channel — repurposed
        // because we don't have a toast system. Cleared after 1.5s.
        setError(`✓ Cart copied to clipboard (${md.length} chars). Paste into your AI.`);
        setTimeout(() => setError(null), 2500);
      } else {
        const blob = new Blob([md], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [ir, pinnedIds]);

  // Breadcrumb pieces.
  const breadcrumb = useMemo(() => {
    if (!ir) return [];
    const items = [{ label: ir.repo, id: null }];
    for (const id of focusStack) {
      const n = ir.nodes.find((x) => x.id === id);
      if (n) items.push({ label: n.label, id });
    }
    return items;
  }, [ir, focusStack]);

  return (
    <div className="app">
      <header>
        <div className="brand">
          <div className="logo" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 32 32">
              <rect width="32" height="32" rx="6" fill="#030712" />
              {/* Block-letter R: vertical bar + top + bowl returning to bar + diagonal leg. */}
              <path
                d="M8 24V8h6a5 5 0 010 10H8 M13 18l5 6"
                stroke="#c8ff3d"
                strokeWidth="2"
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <h1>
            Ryngo <span className="tag">MVP</span>
          </h1>
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            title={
              theme === "dark"
                ? "Switch to light mode (currently dark)"
                : "Switch to dark mode (currently light)"
            }
            aria-label="Toggle color theme"
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>

        <form onSubmit={onSubmit}>
          <input
            type="url"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://github.com/owner/repo"
            disabled={loading}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="url-input"
          />
          <input
            list="ref-list"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder={branches.default || "ref"}
            disabled={loading}
            className="ref-input"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            title="branch, tag, or HEAD"
          />
          <span className="vs-label">vs</span>
          <input
            list="ref-list"
            value={compareRef}
            onChange={(e) => setCompareRef(e.target.value)}
            placeholder="(no compare)"
            disabled={loading}
            className="ref-input"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            title="compare against this ref → diff mode"
          />
          <datalist id="ref-list">
            {branches.default && (
              <option value={branches.default}>default</option>
            )}
            {branches.branches.map((b) => (
              <option key={`b:${b}`} value={b}>
                branch
              </option>
            ))}
            {branches.tags.map((t) => (
              <option key={`t:${t}`} value={t}>
                tag
              </option>
            ))}
          </datalist>
          <button type="submit" disabled={loading || !url}>
            {loading
              ? "Analyzing…"
              : compareRef
                ? "Diff"
                : "Visualize"}
          </button>
        </form>

        <div className="samples">
          <span className="samples-label">try:</span>
          {SAMPLE_URLS.map((s) => (
            <button
              key={s}
              type="button"
              className="sample"
              onClick={() => {
                setUrl(s);
                setRef("");
                setCompareRef("");
                if (!loading) analyze({ url: s, ref: "", compareRef: "" });
              }}
              disabled={loading}
            >
              {s.replace("https://github.com/", "")}
            </button>
          ))}
          <span className="samples-label" style={{ marginLeft: 12 }}>
            diff:
          </span>
          <button
            type="button"
            className="sample"
            onClick={() => {
              setUrl("https://github.com/sindresorhus/p-queue");
              setRef("main");
              setCompareRef("v8.0.0");
              if (!loading)
                analyze({
                  url: "https://github.com/sindresorhus/p-queue",
                  ref: "main",
                  compareRef: "v8.0.0",
                });
            }}
            disabled={loading}
          >
            p-queue: v8.0.0…main
          </button>
        </div>
      </header>

      {error && (
        <div className="banner banner-error">
          <strong>error:</strong> {error}
        </div>
      )}

      {ir && !focusedId && (
        <div className="view-tabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "graph"}
            className={`view-tab${viewMode === "graph" ? " active" : ""}`}
            onClick={() => setViewMode("graph")}
          >
            Graph
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "dashboard"}
            className={`view-tab${viewMode === "dashboard" ? " active" : ""}`}
            onClick={() => setViewMode("dashboard")}
          >
            Dashboard
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "agent"}
            className={`view-tab${viewMode === "agent" ? " active" : ""}`}
            onClick={() => setViewMode("agent")}
          >
            Agent Map
          </button>
          {viewMode === "graph" && (
            <div className="view-subtabs" role="group" aria-label="Graph layout">
              <button
                type="button"
                className={`view-subtab${graphView === "layers" ? " active" : ""}`}
                onClick={() => setGraphView("layers")}
                title="Group files into Frontend / Backend / Data / Infra panels"
              >
                Layers
              </button>
              <button
                type="button"
                className={`view-subtab${graphView === "files" ? " active" : ""}`}
                onClick={() => setGraphView("files")}
                title="Show every analyzable file with its functions and classes"
              >
                Files
              </button>
              <label className="view-inert-toggle" title="Include lockfiles, READMEs, package.json, and other non-analyzable files">
                <input
                  type="checkbox"
                  checked={showInertFiles}
                  onChange={(e) => setShowInertFiles(e.target.checked)}
                />
                <span>config files</span>
              </label>
            </div>
          )}
        </div>
      )}

      {ir && breadcrumb.length > 0 && (
        <div className="banner banner-stats">
          {breadcrumb.map((item, i) => (
            <span key={i} className="bc-row">
              {i > 0 && <span className="bc-sep">›</span>}
              <button
                className={`bc-item ${i === breadcrumb.length - 1 ? "bc-here" : ""}`}
                disabled={i === breadcrumb.length - 1}
                onClick={() => setFocusStack(focusStack.slice(0, i))}
              >
                {item.label}
              </button>
            </span>
          ))}
          {focusedId == null && !isDiffMode && (
            <>
              <span className="dot">·</span>
              {ir.stats.files} files
              <span className="dot">·</span>
              {ir.stats.analyzedFiles} analyzed
              <span className="dot">·</span>
              <span className="defs">{ir.stats.definitions} defs</span>
              {ir.stats.cells > 0 && (
                <>
                  <span className="dot">·</span>
                  <span className="cells">{ir.stats.cells} cells</span>
                </>
              )}
              <span className="dot">·</span>
              {ir.stats.packages} pkgs
              <span className="dot">·</span>
              <span className="calls">{ir.stats.callEdges} calls</span>
              {ir.ref && ir.ref !== "HEAD" && (
                <>
                  <span className="dot">·</span>
                  <span className="ref-badge">@{ir.ref}</span>
                </>
              )}
            </>
          )}
          {focusedId == null && isDiffMode && ir.diff && (
            <>
              <span className="dot">·</span>
              <span className="ref-badge">{ir.diff.base.ref}</span>
              <span className="dot">…</span>
              <span className="ref-badge">{ir.diff.head.ref}</span>
              <span className="dot">·</span>
              <span className="diff-added">
                +{ir.diff.counts.nodes.added}
              </span>
              <span className="diff-removed">
                −{ir.diff.counts.nodes.removed}
              </span>
              <span className="muted"> nodes</span>
              <span className="dot">·</span>
              <span className="diff-added">
                +{ir.diff.counts.edges.added}
              </span>
              <span className="diff-removed">
                −{ir.diff.counts.edges.removed}
              </span>
              <span className="muted"> edges</span>
              {Object.entries(ir.diff.byKind).map(([kind, c]) => (
                <span key={kind} className="muted">
                  <span className="dot">·</span>
                  {kind}:&nbsp;
                  {c.added > 0 && (
                    <span className="diff-added">+{c.added}</span>
                  )}
                  {c.added > 0 && c.removed > 0 && " "}
                  {c.removed > 0 && (
                    <span className="diff-removed">−{c.removed}</span>
                  )}
                </span>
              ))}
            </>
          )}
          {focusedId != null && focusLayout && (
            <span className="muted" style={{ marginLeft: "auto" }}>
              {focusLayout.counts.incoming} in · {focusLayout.counts.outgoing} out
              · double-click to drill · esc to back
            </span>
          )}
        </div>
      )}

      {/* Auto-narrative banner — only in diff mode, only on the graph view. */}
      {ir && isDiffMode && !focusedId && viewMode === "graph" && (
        <div className="narrative">
          <span className="narrative-eyebrow">Summary</span>
          <span className="narrative-text">{diffNarrative(ir)}</span>
        </div>
      )}

      <main>
        {ir && viewMode === "dashboard" && !focusedId ? (
          <Dashboard
            ir={ir}
            ryngoState={ryngoState}
            onJumpToFile={(nodeId) => {
              setViewMode("graph");
              setFocusStack((s) => [...s, nodeId]);
            }}
            onVerifyIntent={onVerifyIntent}
          />
        ) : ir && viewMode === "agent" && !focusedId ? (
          <AgentMap
            viewModel={agentViewModel}
            onInspectNode={(nodeId) => {
              setViewMode("graph");
              setFocusStack((s) => [...s, nodeId]);
            }}
          />
        ) : focusedId && focusedNode ? (
          <FocusView
            ir={ir}
            node={focusedNode}
            layout={focusLayout}
            selected={selected}
            onSelect={(e, n) => handleNodeClick("focus", e, n)}
            onDoubleSelect={(e, n) => handleNodeDoubleClick("focus", e, n)}
            onContextMenu={handleNodeContextMenu}
            onInspect={onInspect}
            onPaneClick={onPaneClick}
            onBack={() => setFocusStack((s) => s.slice(0, -1))}
            instanceRef={focusFlow}
          />
        ) : repoLayout ? (
          <ReactFlow
            nodes={repoLayout.nodes}
            edges={repoLayout.edges}
            nodeTypes={nodeTypes}
            onInit={(inst) => {
              repoFlow.current = inst;
            }}
            onNodeClick={(e, n) => handleNodeClick("repo", e, n)}
            onNodeDoubleClick={(e, n) => handleNodeDoubleClick("repo", e, n)}
            onNodeContextMenu={handleNodeContextMenu}
            onPaneClick={onPaneClick}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.05}
            maxZoom={2}
            nodesDraggable={false}
            elementsSelectable={true}
            proOptions={{ hideAttribution: true }}
          >
            <Background color={styleSet.gridColor} gap={24} />
            <Controls
              showInteractive={false}
              style={{
                background: "var(--panel)",
                border: "1px solid var(--line)",
                borderRadius: 6,
              }}
            />
            <MiniMap
              pannable
              zoomable
              nodeStrokeColor={styleSet.gridColor}
              nodeColor={(n) => {
                const k = n.data?.kind;
                if (k === "package") return styleSet.miniNodePkg;
                if (k === "function") return styleSet.miniNodeFn;
                if (k === "class") return styleSet.miniNodeCls;
                if (k === "cell") return styleSet.miniNodeCell;
                return styleSet.miniNodeFile;
              }}
              maskColor={styleSet.miniMask}
              style={{
                background: styleSet.bgColor,
                border: "1px solid var(--line)",
              }}
            />
            <Panel position="bottom-left" className="legend">
              <div className="legend-row">
                <span className="sw sw-file" /> file
                <span className="sw sw-fn" /> function
                <span className="sw sw-cls" /> class
                <span className="sw sw-cell" /> cell
              </div>
              <div className="legend-row">
                <span className="ln ln-import" /> imports
                <span className="ln ln-call" /> calls
              </div>
              <div className="legend-row legend-hint">
                click = inspect · double-click = Inspect node
              </div>
              <div className="legend-row legend-hint">
                packages shown only inside drilled views
              </div>
            </Panel>
            {selected && selected.data?.kind !== "file-header" && (
              <Panel position="top-right" className="inspector">
                <div className="inspector-header">
                  {iconForKind(selected.data?.kind)} {selected.data?.label}
                </div>
                <NodeMeta data={selected.data} ir={ir} selectedId={selected.id} />
                <button className="inspector-drill" onClick={onInspect}>
                  Inspect node ↳
                </button>
              </Panel>
            )}
          </ReactFlow>
        ) : loading ? (
          <div className="placeholder">
            <Spinner />
            Cloning + parsing…
          </div>
        ) : (
          <div className="placeholder">
            Paste a GitHub URL to visualize the import + call graph.
          </div>
        )}
      </main>

      {/* Floating cart indicator — appears once at least one node is pinned. */}
      {ir && pinnedIds.size > 0 && (
        <div className="cart-fab" role="status">
          <span className="cart-count">★ {pinnedIds.size} pinned</span>
          <button
            type="button"
            className="cart-clear"
            onClick={() => setPinnedIds(new Set())}
            title="Clear all pins"
          >
            clear
          </button>
          <button
            type="button"
            className="cart-export"
            onClick={onExportCart}
            title="Copy a markdown cart of pinned nodes to clipboard"
          >
            Export cart →
          </button>
        </div>
      )}

      {/* Right-click context menu and annotation modal — both render at the
          App root because they're position:fixed overlays. */}
      <ContextMenu
        ctx={contextMenu}
        onClose={closeContextMenu}
        onAnnotate={onContextAnnotate}
        onIntent={onContextIntent}
        onPin={onContextPin}
        pinned={contextMenu ? pinnedIds.has(contextMenu.nodeId) : false}
      />
      <AnnotateModal
        target={annotateFor}
        onClose={() => setAnnotateFor(null)}
        onSubmit={onAnnotateSubmit}
      />
    </div>
  );
}

function AgentMap({ viewModel, onInspectNode }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [layer, setLayer] = useState("all");
  const [selectedId, setSelectedId] = useState(null);

  const nodes = viewModel?.nodes || [];
  const selected =
    nodes.find((n) => n.id === selectedId) ||
    nodes.find((n) => n.id === viewModel?.inspector?.defaultNodeId) ||
    nodes[0] ||
    null;
  const kinds = useMemo(
    () => ["all", ...new Set(nodes.map((n) => n.kind).sort())],
    [nodes],
  );
  const layers = useMemo(
    () => ["all", ...new Set(nodes.map((n) => n.layer).sort())],
    [nodes],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nodes.filter((n) => {
      if (kind !== "all" && n.kind !== kind) return false;
      if (layer !== "all" && n.layer !== layer) return false;
      if (!q) return true;
      return [n.label, n.path, n.description, n.id]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [nodes, query, kind, layer]);

  if (!viewModel) {
    return (
      <div className="agent-map agent-map-empty">
        <div className="agent-empty-title">Agent map unavailable</div>
        <div className="muted">
          The repo graph loaded, but the shared RyngoViewModel projection did
          not return. The Graph and Dashboard views still use the full IR.
        </div>
      </div>
    );
  }

  return (
    <section className="agent-map" aria-label="Agent map">
      <div className="agent-summary">
        <Metric label="nodes" value={viewModel.summary.stats.nodes} />
        <Metric label="edges" value={viewModel.summary.stats.edges} />
        <Metric label="routes" value={viewModel.summary.stats.routes} />
        <Metric label="models" value={viewModel.summary.stats.dbModels} />
        <Metric label="env" value={viewModel.summary.stats.envVars} />
        <Metric label="omitted" value={viewModel.limits.omittedNodes} />
      </div>

      <div className="agent-toolbar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search view model"
          spellCheck={false}
        />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k === "all" ? "all kinds" : k}
            </option>
          ))}
        </select>
        <select value={layer} onChange={(e) => setLayer(e.target.value)}>
          {layers.map((l) => (
            <option key={l} value={l}>
              {l === "all" ? "all layers" : l}
            </option>
          ))}
        </select>
      </div>

      <div className="agent-grid">
        <div className="agent-list" role="list">
          {filtered.map((node) => (
            <button
              key={node.id}
              type="button"
              className={`agent-node ${selected?.id === node.id ? "selected" : ""}`}
              onClick={() => setSelectedId(node.id)}
              onDoubleClick={() => onInspectNode(node.id)}
            >
              <span className={`agent-dot agent-dot-${node.layer || "other"}`} />
              <span className="agent-node-main">
                <span className="agent-node-title">{node.label}</span>
                <span className="agent-node-meta">
                  {node.kind} · {node.path || node.layerLabel}
                </span>
              </span>
              <span className="agent-score">{node.importance}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="agent-empty muted">No nodes match these filters.</div>
          )}
        </div>

        <aside className="agent-inspector">
          {selected ? (
            <>
              <div className="agent-inspector-kicker">
                {selected.kind} · {selected.layerLabel}
              </div>
              <h2>{selected.label}</h2>
              <p>{selected.description}</p>
              {selected.path && <code>{selected.path}</code>}
              <dl>
                <Row label="node id" mono>
                  {selected.id}
                </Row>
                <Row label="degree">{selected.degree}</Row>
                <Row label="importance">{selected.importance}</Row>
              </dl>
              <button
                type="button"
                className="agent-inspect-button"
                onClick={() => onInspectNode(selected.id)}
              >
                Inspect in graph
              </button>
            </>
          ) : (
            <p className="muted">Select a node to inspect it.</p>
          )}
        </aside>
      </div>

      <div className="agent-footer">
        <div>
          <h3>Clusters</h3>
          <div className="agent-clusters">
            {viewModel.clusters.map((cluster) => (
              <span key={cluster.id} className="agent-chip">
                {cluster.label}: {cluster.nodeIds.length}
              </span>
            ))}
          </div>
        </div>
        <div>
          <h3>Ask Next</h3>
          <ul className="agent-prompts">
            {viewModel.prompts.map((prompt) => (
              <li key={prompt}>{prompt}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="agent-metric">
      <span>{label}</span>
      <strong>{value ?? "—"}</strong>
    </div>
  );
}

// ============================================================================
// Focus view — split: source code on the left, hub-and-spoke graph on right
// ============================================================================

function FocusView({
  ir,
  node,
  layout,
  selected,
  onSelect,
  onDoubleSelect,
  onContextMenu,
  onInspect,
  onPaneClick,
  onBack,
  instanceRef,
}) {
  const [source, setSource] = useState(null);
  const [sourceErr, setSourceErr] = useState(null);
  const [sourceLoading, setSourceLoading] = useState(false);

  // Fetch source. Cells already have it inline; everything else needs the
  // raw file from /api/source.
  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setSourceErr(null);

    if (node.kind === "cell") {
      setSource({ text: node.data.source, focusLine: 1, file: node.data.file });
      return;
    }
    if (node.kind === "package") {
      setSource(null);
      return;
    }

    const filePath = node.data?.file || node.data?.path;
    if (!filePath) return;

    // Diff-mode: a removed node's file may not exist on head — fetch from
    // base instead. unchanged/added go through the head ref.
    let sourceRef = "";
    if (ir.diff) {
      sourceRef =
        node._diff === "removed" ? ir.diff.base.ref : ir.diff.head.ref;
    } else if (ir.ref) {
      sourceRef = ir.ref;
    }
    const refQuery = sourceRef
      ? `&ref=${encodeURIComponent(sourceRef)}`
      : "";

    setSourceLoading(true);
    fetch(
      `/api/source?repo=${encodeURIComponent(ir.repo)}&path=${encodeURIComponent(filePath)}${refQuery}`,
    )
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (cancelled) return;
        setSource({
          text: j.source,
          focusLine: node.data?.line || 1,
          file: filePath,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setSourceErr(e.message);
      })
      .finally(() => {
        if (cancelled) return;
        setSourceLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ir.repo, node.id, node.kind, node.data]);

  return (
    <div className="focus">
      <div className="focus-source">
        <div className="focus-source-header">
          <span className="focus-icon">{iconForKind(node.kind)}</span>
          <span className="focus-name">{node.label}</span>
          {source?.file && (
            <span className="focus-file mono">{source.file}</span>
          )}
          <button className="focus-back" onClick={onBack}>
            ← back
          </button>
        </div>
        <div className="focus-source-body">
          {sourceLoading && <div className="muted">fetching…</div>}
          {sourceErr && (
            <div className="banner-error" style={{ borderBottom: 0 }}>
              {sourceErr}
            </div>
          )}
          {!sourceLoading && !sourceErr && source && (
            <CodeBlock text={source.text} focusLine={source.focusLine} />
          )}
          {!sourceLoading && !sourceErr && !source && (
            <div className="muted" style={{ padding: 16 }}>
              {node.kind === "package"
                ? "External package — view on the registry from the inspector."
                : "No source available."}
            </div>
          )}
        </div>
      </div>
      <div className="focus-graph">
        {layout && (
          <ReactFlow
            nodes={layout.nodes}
            edges={layout.edges}
            nodeTypes={nodeTypes}
            onInit={(inst) => {
              if (instanceRef) instanceRef.current = inst;
            }}
            onNodeClick={onSelect}
            onNodeDoubleClick={onDoubleSelect}
            onNodeContextMenu={onContextMenu}
            onPaneClick={onPaneClick}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            minZoom={0.4}
            maxZoom={1.6}
            nodesDraggable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--line)" gap={24} />
            <Controls
              showInteractive={false}
              style={{
                background: "var(--panel)",
                border: "1px solid var(--line)",
                borderRadius: 6,
              }}
            />
            <Panel position="top-left" className="legend">
              <div className="legend-row legend-hint">
                hub: <strong>{node.label}</strong>
              </div>
              <div className="legend-row legend-hint">
                left = callers · right = callees
              </div>
              <div className="legend-row legend-hint">
                click = inspect · double-click = drill
              </div>
            </Panel>
            {selected && selected.data?.kind !== "file-header" && (
              <Panel position="top-right" className="inspector">
                <div className="inspector-header">
                  {iconForKind(selected.data?.kind)} {selected.data?.label}
                </div>
                <NodeMeta
                  data={selected.data}
                  ir={ir}
                  selectedId={selected.id}
                />
                <button className="inspector-drill" onClick={onInspect}>
                  Inspect node ↳
                </button>
              </Panel>
            )}
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Source-code rendering with line numbers + focus-line highlight
// ============================================================================

function CodeBlock({ text, focusLine }) {
  const ref = useRef(null);
  const lines = useMemo(() => text.split("\n"), [text]);
  const focus0 = Math.max(1, focusLine || 1);
  // Auto-scroll to the focus line on first paint.
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current.querySelector(`[data-line="${focus0}"]`);
    if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
  }, [focus0]);

  return (
    <pre className="code" ref={ref}>
      {lines.map((line, i) => {
        const ln = i + 1;
        const isFocus = ln === focus0;
        return (
          <div
            key={i}
            data-line={ln}
            className={`code-line${isFocus ? " code-focus" : ""}`}
          >
            <span className="code-gutter">{ln}</span>
            <span className="code-text">{line || " "}</span>
          </div>
        );
      })}
    </pre>
  );
}

// ============================================================================
// Inspector helpers (small)
// ============================================================================

function NodeMeta({ data, ir, selectedId }) {
  if (data?.kind === "file") {
    return (
      <dl>
        <Row label="path" mono>{data.path}</Row>
        <Row label="size">{formatBytes(data.size)}</Row>
        <Row label="lang" mono>{data.lang || "—"}</Row>
      </dl>
    );
  }
  if (data?.kind === "package") {
    return (
      <dl>
        <Row label="package" mono>{data.name}</Row>
        <Row label="link">
          <a
            href={`https://www.npmjs.com/package/${encodeURIComponent(data.name)}`}
            target="_blank"
            rel="noreferrer"
          >
            npm →
          </a>
          &nbsp;
          <a
            href={`https://pypi.org/project/${encodeURIComponent(data.name)}/`}
            target="_blank"
            rel="noreferrer"
          >
            pypi →
          </a>
        </Row>
      </dl>
    );
  }
  // function / class / cell
  const callers = ir.edges
    .filter((e) => e.kind === "calls" && e.target === selectedId)
    .map((e) => idToLabel(ir, e.source));
  const callees = ir.edges
    .filter((e) => e.kind === "calls" && e.source === selectedId)
    .map((e) => idToLabel(ir, e.target));
  return (
    <dl>
      <Row label="kind">{data.kind}</Row>
      {data.file && (
        <Row label="file" mono>
          {data.file}
          {data.line ? `:${data.line}` : ""}
        </Row>
      )}
      <Row label="lang" mono>{data.lang || "—"}</Row>
      <Row label={`callers (${callers.length})`}>
        {callers.length ? (
          <ul className="ref-list">
            {callers.slice(0, 12).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
            {callers.length > 12 && <li>…+{callers.length - 12}</li>}
          </ul>
        ) : (
          <span className="muted">—</span>
        )}
      </Row>
      <Row label={`callees (${callees.length})`}>
        {callees.length ? (
          <ul className="ref-list">
            {callees.slice(0, 12).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
            {callees.length > 12 && <li>…+{callees.length - 12}</li>}
          </ul>
        ) : (
          <span className="muted">—</span>
        )}
      </Row>
    </dl>
  );
}

function idToLabel(ir, id) {
  const n = ir.nodes.find((x) => x.id === id);
  if (!n) return id;
  if (n.kind === "function" || n.kind === "class") {
    const file = n.data?.file?.split("/").slice(-1)[0];
    return `${n.label}  (${file})`;
  }
  if (n.kind === "cell") {
    return `${n.label}  (${n.data?.file?.split("/").slice(-1)[0]})`;
  }
  if (n.kind === "package") return `[pkg] ${n.label}`;
  if (n.kind === "file") return `[file] ${n.label}`;
  return id;
}

function iconForKind(kind) {
  switch (kind) {
    case "file": return "📄";
    case "function": return "ƒ";
    case "class": return "C";
    case "cell": return "▢";
    case "package": return "📦";
    default: return "·";
  }
}

function Row({ label, children, mono }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? "mono" : ""}>{children}</dd>
    </div>
  );
}

function formatBytes(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function Spinner() {
  return (
    <span className="spinner" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="#374151" strokeWidth="3" />
        <path
          d="M12 3a9 9 0 0 1 9 9"
          stroke="#c8ff3d"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
