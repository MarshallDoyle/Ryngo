/**
 * RyngoViewModel v1.
 *
 * A deterministic, capped graph projection for agent UIs. This sits between
 * the full IR and chat/app renderers: small enough for model-visible
 * `structuredContent`, but still rich enough to drive a read-only node viewer.
 */
import { classifyFiles, LAYER_LABEL, LAYER_ORDER } from "./layers.js";

const DEFAULT_MAX_NODES = 80;
const MIN_MAX_NODES = 20;
const MAX_MAX_NODES = 200;

const VIEW_NODE_KINDS = new Set([
  "file",
  "function",
  "class",
  "cell",
  "package",
  "http-route",
  "db-model",
  "env",
  "infra-resource",
]);

const VIEW_EDGE_KINDS = new Set([
  "imports-file",
  "imports-package",
  "calls",
  "defines-route",
  "route-handler",
  "db-read",
  "db-write",
  "env-read",
]);

const KIND_WEIGHT = {
  "http-route": 32,
  "db-model": 30,
  env: 26,
  file: 20,
  class: 18,
  function: 16,
  "infra-resource": 14,
  cell: 10,
  package: 8,
};

const EDGE_LABEL = {
  "imports-file": "imports",
  "imports-package": "uses package",
  calls: "calls",
  "defines-route": "defines route",
  "route-handler": "handled by",
  "db-read": "reads",
  "db-write": "writes",
  "env-read": "reads env",
};

/** Build a deterministic high-level graph payload for agent viewers. */
export function buildViewModel(ir, opts = {}) {
  const maxNodes = clampMaxNodes(opts.maxNodes);
  const mode = normalizeMode(opts.mode);
  const nodes = (ir.nodes || []).filter((n) => VIEW_NODE_KINDS.has(n.kind));
  const edges = (ir.edges || []).filter((e) => VIEW_EDGE_KINDS.has(e.kind));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layers = classifyFiles(ir);
  const degree = degreeMap(edges);
  const ranked = nodes
    .map((node) => ({
      node,
      score: importanceScore(node, degree, layers),
    }))
    .sort((a, b) => compareRanked(a, b));

  const mustKeep = new Set();
  for (const n of nodes) {
    if (
      n.kind === "http-route" ||
      n.kind === "db-model" ||
      n.kind === "env" ||
      n.kind === "infra-resource"
    ) {
      mustKeep.add(n.id);
      if (n.parentId) mustKeep.add(n.parentId);
    }
  }

  const selectedIds = new Set();
  for (const id of [...mustKeep].sort()) {
    if (selectedIds.size >= maxNodes) break;
    if (byId.has(id)) selectedIds.add(id);
  }
  for (const { node } of ranked) {
    if (selectedIds.size >= maxNodes) break;
    selectedIds.add(node.id);
  }

  const viewNodes = [...selectedIds]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((node) => viewNode(node, degree, layers))
    .sort(compareViewNodes);

  const viewEdges = aggregateEdges(edges, selectedIds, byId)
    .sort(compareViewEdges);

  return {
    version: 1,
    repo: ir.repo || null,
    ref: ir.ref || "HEAD",
    mode,
    summary: buildSummary(ir, nodes, edges, layers, degree),
    nodes: viewNodes,
    edges: viewEdges,
    clusters: buildClusters(viewNodes, layers),
    highlights: buildHighlights(nodes, edges, degree),
    inspector: buildInspector(viewNodes),
    prompts: buildPrompts(ir, viewNodes),
    limits: {
      maxNodes,
      returnedNodes: viewNodes.length,
      omittedNodes: Math.max(0, nodes.length - viewNodes.length),
      returnedEdges: viewEdges.length,
      omittedEdges: Math.max(0, edges.length - viewEdges.length),
      reason: nodes.length > viewNodes.length ? "max_nodes" : null,
    },
  };
}

function clampMaxNodes(value) {
  const n = Number(value) || DEFAULT_MAX_NODES;
  return Math.max(MIN_MAX_NODES, Math.min(MAX_MAX_NODES, Math.floor(n)));
}

function normalizeMode(mode) {
  const m = String(mode || "overview").toLowerCase();
  return ["overview", "layers", "files"].includes(m) ? m : "overview";
}

function degreeMap(edges) {
  const out = new Map();
  for (const e of edges) {
    bump(out, e.source);
    bump(out, e.target);
  }
  return out;
}

function importanceScore(node, degree, layers) {
  const base = KIND_WEIGHT[node.kind] || 1;
  const d = degree.get(node.id) || 0;
  const data = node.data || {};
  const childBonus = node.parentId ? 0 : 4;
  const routeBonus = node.kind === "file" && layerOf(node, layers) === "backend" ? 5 : 0;
  const typedBonus =
    data.returnType || data.params?.length || data.members?.methods?.length ? 3 : 0;
  return base + d * 3 + childBonus + routeBonus + typedBonus;
}

function compareRanked(a, b) {
  return (
    b.score - a.score ||
    compareText(a.node.kind, b.node.kind) ||
    compareText(a.node.label, b.node.label) ||
    compareText(a.node.id, b.node.id)
  );
}

function viewNode(node, degree, layers) {
  const layer = layerOf(node, layers);
  const data = node.data || {};
  const path = data.path || data.file || parentPath(node);
  const out = {
    id: node.id,
    kind: node.kind,
    label: node.label || node.id,
    layer,
    layerLabel: LAYER_LABEL[layer] || "Other",
    importance: importanceScore(node, degree, layers),
    degree: degree.get(node.id) || 0,
    description: describeNode(node),
  };
  if (path) out.path = path;
  if (data.line) out.line = data.line;
  if (node.parentId) out.parent = node.parentId;
  return out;
}

function describeNode(node) {
  const data = node.data || {};
  if (node.kind === "file") {
    return `${data.lang || "source"} file`;
  }
  if (node.kind === "function") {
    const params = data.params?.length || 0;
    const ret = data.returnType ? ` returns ${displayType(data.returnType)}` : "";
    return `function with ${params} parameter${params === 1 ? "" : "s"}${ret}`;
  }
  if (node.kind === "class") {
    const methods = data.members?.methods?.length || 0;
    const fields = data.members?.fields?.length || 0;
    return `class with ${methods} method${methods === 1 ? "" : "s"} and ${fields} field${fields === 1 ? "" : "s"}`;
  }
  if (node.kind === "http-route") {
    return `${(data.method || "GET").toUpperCase()} ${node.label}`;
  }
  if (node.kind === "db-model") return "database model";
  if (node.kind === "env") return "environment variable";
  if (node.kind === "package") return "external package";
  if (node.kind === "infra-resource") return "infrastructure resource";
  if (node.kind === "cell") return "notebook cell";
  return node.kind;
}

function displayType(t) {
  return typeof t === "string" ? t : t?.display || "value";
}

function layerOf(node, layers) {
  if (node.kind === "package") return "other";
  if (node.kind === "env") return "config";
  if (node.kind === "db-model") return "data";
  if (node.kind === "infra-resource") return "infra";
  const fileId = node.kind === "file" ? node.id : node.parentId || "";
  return layers.byFile.get(fileId) || "other";
}

function parentPath(node) {
  return node.parentId?.startsWith("file:") ? node.parentId.replace(/^file:/, "") : "";
}

function aggregateEdges(edges, selectedIds, byId) {
  const aggregate = new Map();
  for (const e of edges) {
    const source = selectedEndpoint(e.source, selectedIds, byId);
    const target = selectedEndpoint(e.target, selectedIds, byId);
    if (!source || !target || source === target) continue;
    const key = `${source}->${target}:${e.kind}`;
    const prev = aggregate.get(key);
    if (prev) {
      prev.weight += 1;
      continue;
    }
    aggregate.set(key, {
      id: `edge:${key}`,
      source,
      target,
      kind: e.kind,
      label: EDGE_LABEL[e.kind] || e.kind,
      weight: 1,
    });
  }
  return [...aggregate.values()];
}

function selectedEndpoint(id, selectedIds, byId) {
  if (selectedIds.has(id)) return id;
  const node = byId.get(id);
  if (node?.parentId && selectedIds.has(node.parentId)) return node.parentId;
  return null;
}

function buildSummary(ir, nodes, edges, layers, degree) {
  const files = nodes.filter((n) => n.kind === "file");
  const languages = {};
  for (const f of files) {
    const lang = f.data?.lang || "other";
    languages[lang] = (languages[lang] || 0) + 1;
  }
  const hotspots = nodes
    .filter((n) => n.kind === "file")
    .map((n) => ({
      id: n.id,
      label: n.label,
      path: n.data?.path,
      degree: degree.get(n.id) || 0,
    }))
    .sort((a, b) => b.degree - a.degree || compareText(a.path, b.path))
    .slice(0, 5);
  return {
    repo: ir.repo || null,
    ref: ir.ref || "HEAD",
    stats: {
      files: ir.stats?.files ?? files.length,
      analyzedFiles: ir.stats?.analyzedFiles ?? null,
      nodes: nodes.length,
      edges: edges.length,
      functions: nodes.filter((n) => n.kind === "function").length,
      classes: nodes.filter((n) => n.kind === "class").length,
      routes: nodes.filter((n) => n.kind === "http-route").length,
      dbModels: nodes.filter((n) => n.kind === "db-model").length,
      envVars: nodes.filter((n) => n.kind === "env").length,
      packages: nodes.filter((n) => n.kind === "package").length,
    },
    languages: sortObject(languages),
    dominantLayer: layers.dominantLayer,
    hotspots,
  };
}

function buildClusters(viewNodes, layers) {
  const idsByLayer = new Map(LAYER_ORDER.map((layer) => [layer, []]));
  for (const node of viewNodes) {
    if (!idsByLayer.has(node.layer)) idsByLayer.set(node.layer, []);
    idsByLayer.get(node.layer).push(node.id);
  }
  return [...idsByLayer.entries()]
    .map(([layer, ids]) => ({
      id: `layer:${layer}`,
      kind: "layer",
      label: LAYER_LABEL[layer] || layer,
      layer,
      nodeIds: ids.sort(),
      stats: layers.layers[layer] || {
        files: [],
        routes: 0,
        dbModels: 0,
        envReads: 0,
        defs: 0,
        cells: 0,
      },
    }))
    .filter((cluster) => cluster.nodeIds.length > 0);
}

function buildHighlights(nodes, edges, degree) {
  const topPackages = nodes
    .filter((n) => n.kind === "package")
    .map((n) => ({
      id: n.id,
      label: n.label,
      imports: edges.filter((e) => e.kind === "imports-package" && e.target === n.id).length,
    }))
    .sort((a, b) => b.imports - a.imports || compareText(a.label, b.label))
    .slice(0, 8);
  const topNodes = nodes
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      degree: degree.get(n.id) || 0,
    }))
    .sort((a, b) => b.degree - a.degree || compareText(a.label, b.label))
    .slice(0, 8);
  return {
    routes: nodes.filter((n) => n.kind === "http-route").slice(0, 12).map(highlightNode),
    dbModels: nodes.filter((n) => n.kind === "db-model").slice(0, 12).map(highlightNode),
    envVars: nodes.filter((n) => n.kind === "env").slice(0, 12).map(highlightNode),
    topPackages,
    topNodes,
  };
}

function highlightNode(n) {
  return {
    id: n.id,
    label: n.label,
    path: n.data?.path || n.data?.file || parentPath(n),
    parent: n.parentId || null,
  };
}

function buildInspector(viewNodes) {
  const defaultNode = viewNodes[0] || null;
  return {
    defaultNodeId: defaultNode?.id || null,
    facts: defaultNode
      ? {
          id: defaultNode.id,
          label: defaultNode.label,
          kind: defaultNode.kind,
          layer: defaultNode.layer,
          path: defaultNode.path || null,
          description: defaultNode.description,
        }
      : null,
    recommendedToolCalls: defaultNode
      ? [
          {
            tool: "get_subgraph",
            arguments: { root_id: defaultNode.id, hops: 1 },
            reason: "Show the immediate neighborhood around the selected node.",
          },
          {
            tool: "english_signature",
            arguments: { node_id: defaultNode.id },
            reason: "Explain the selected function or class in prose when applicable.",
          },
        ]
      : [],
  };
}

function buildPrompts(ir, viewNodes) {
  const repo = ir.repo || "this repo";
  const selected = viewNodes[0]?.label || "the most important node";
  return [
    `Explain how ${repo} is organized at a high level.`,
    `Show me what depends on ${selected}.`,
    "Which files look like the safest starting point for a change?",
    "Which routes, data models, and environment variables matter most?",
  ];
}

function compareViewNodes(a, b) {
  return (
    b.importance - a.importance ||
    compareText(a.layer, b.layer) ||
    compareText(a.kind, b.kind) ||
    compareText(a.label, b.label) ||
    compareText(a.id, b.id)
  );
}

function compareViewEdges(a, b) {
  return (
    compareText(a.source, b.source) ||
    compareText(a.target, b.target) ||
    compareText(a.kind, b.kind)
  );
}

function sortObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])),
  );
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function compareText(a = "", b = "") {
  return String(a).localeCompare(String(b));
}
