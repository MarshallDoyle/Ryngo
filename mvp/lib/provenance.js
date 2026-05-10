const CONFIDENCE = new Set([
  "confirmed",
  "source-syntax",
  "framework-inferred",
  "heuristic",
  "unknown",
]);

const FRAMEWORK_NODE_KINDS = new Set([
  "http-route",
  "db-model",
  "env",
  "infra-resource",
  "gql-resolver",
]);

const FRAMEWORK_EDGE_KINDS = new Set([
  "defines-route",
  "route-handler",
  "db-read",
  "db-write",
  "env-read",
]);

/** Normalize source provenance, confidence, facts, and edge counts in-place. */
export function normalizeProvenance(ir) {
  const nodes = ir.nodes || [];
  const edges = ir.edges || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edgeCounts = new Map();

  for (const edge of edges) {
    edge.confidence = normalizeConfidence(edge.confidence || confidenceForEdge(edge));
    edge.sourceLocation = normalizeSource(edge.sourceMeta || edge.sourceLocation || edge.sourceSpan || edge.data?.source, byId.get(edge.source));
    edge.provenance = normalizeProvenanceObject(edge.provenance, {
      extractor: extractorForEdge(edge),
      reason: edge.resolution ? `resolver:${edge.resolution}` : undefined,
    });
    bumpEdgeCount(edgeCounts, edge.source, "out", edge.kind);
    bumpEdgeCount(edgeCounts, edge.target, "in", edge.kind);
  }

  for (const node of nodes) {
    const data = node.data || {};
    const source = normalizeSource(node.source || data.source, node);
    const confidence = normalizeConfidence(node.confidence || data.confidence || confidenceForNode(node));
    const provenance = normalizeProvenanceObject(node.provenance || data.provenance, {
      extractor: extractorForNode(node),
      diagnostics: data.diagnostics,
      reason: data.parseStatus && data.parseStatus !== "ok" ? `parseStatus:${data.parseStatus}` : undefined,
    });
    const counts = edgeCounts.get(node.id) || emptyEdgeCounts();
    const facts = buildFacts(node, source, confidence, provenance, counts);

    node.source = source;
    node.confidence = confidence;
    node.provenance = provenance;
    node.edgeCounts = counts;
    node.facts = mergeFacts(node.facts || data.facts, facts);
    node.importanceReasons = node.importanceReasons || importanceReasons(node, counts);

    const preservedCellSource = node.kind === "cell" && typeof data.source === "string" ? data.source : undefined;
    node.data = {
      ...data,
      source,
      ...(preservedCellSource ? { sourceText: preservedCellSource } : {}),
      confidence,
      provenance,
      edgeCounts: counts,
      facts: node.facts,
      importanceReasons: node.importanceReasons,
    };

    normalizeMemberSources(node);
  }

  ir.provenance = provenanceSummary(nodes, edges);
  return ir;
}

function normalizeSource(value, node) {
  const data = node?.data || {};
  const path = value?.path || data.file || data.path || parentPath(node) || null;
  if (!path) return null;
  const startLine = positiveInt(value?.startLine ?? value?.line ?? data.line ?? 1);
  const endLine = positiveInt(value?.endLine ?? startLine) || startLine;
  const out = {
    path,
    startLine,
    endLine: Math.max(startLine, endLine),
  };
  const startColumn = positiveInt(value?.startColumn);
  const endColumn = positiveInt(value?.endColumn);
  if (startColumn != null) out.startColumn = startColumn;
  if (endColumn != null) out.endColumn = endColumn;
  return out;
}

function normalizeProvenanceObject(value, fallback = {}) {
  const extractor = value?.extractor || fallback.extractor || "ryngo";
  const out = { extractor };
  const reason = value?.reason || fallback.reason;
  if (reason) out.reason = reason;
  const diagnostics = value?.diagnostics || fallback.diagnostics;
  if (diagnostics?.length) out.diagnostics = diagnostics.slice(0, 5);
  return out;
}

function confidenceForNode(node) {
  if (node.kind === "file") {
    const status = node.data?.parseStatus;
    if (status === "unsupported" || status === "stub") return "unknown";
    if (status === "error" || status === "skipped_large") return "heuristic";
    return "source-syntax";
  }
  if (node.kind === "package") return "confirmed";
  if (FRAMEWORK_NODE_KINDS.has(node.kind)) return "framework-inferred";
  if (node.kind === "function" || node.kind === "class" || node.kind === "cell") return "source-syntax";
  return "unknown";
}

function confidenceForEdge(edge) {
  if (edge.resolution === "lexical" || edge.resolution === "imported" || edge.resolution === "scip-precise") {
    return "confirmed";
  }
  if (edge.resolution === "name-match") return "heuristic";
  if (FRAMEWORK_EDGE_KINDS.has(edge.kind)) return "framework-inferred";
  if (edge.kind === "imports-file" || edge.kind === "imports-package") return "confirmed";
  return "unknown";
}

function extractorForNode(node) {
  const data = node.data || {};
  if (data.parserBackend) return data.parserBackend;
  if (data.framework) return `${data.framework}-adapter`;
  if (node.kind === "package") return "resolver";
  if (FRAMEWORK_NODE_KINDS.has(node.kind)) return "adapter";
  return data.lang ? `${data.lang}-parser` : "ryngo";
}

function extractorForEdge(edge) {
  if (edge.resolution) return "resolver";
  if (FRAMEWORK_EDGE_KINDS.has(edge.kind)) return "adapter";
  return "ryngo";
}

function buildFacts(node, source, confidence, provenance, edgeCounts) {
  const data = node.data || {};
  const facts = [];
  const add = (kind, text, factSource = source, factConfidence = confidence) => {
    if (!text) return;
    facts.push({
      kind,
      text,
      confidence: factConfidence,
      source: factSource || null,
      provenance,
    });
  };

  if (node.kind === "file") {
    add("language", data.lang ? `language: ${data.lang}` : "language: unknown");
    add("parser", `parser: ${data.parserBackend || "unknown"} / ${data.parseStatus || "unknown"}`);
    add("analyzable", data.analyzable ? "analyzable source" : "not analyzable");
  }
  if (node.kind === "function") {
    add("params", `${data.params?.length || 0} parameter${data.params?.length === 1 ? "" : "s"}`);
    if (data.returnType) add("return", `returns ${displayType(data.returnType)}`);
    if (data.warnings?.length) add("warnings", `${data.warnings.length} warning${data.warnings.length === 1 ? "" : "s"}`);
  }
  if (node.kind === "class") {
    add("methods", `${data.members?.methods?.length || 0} method${data.members?.methods?.length === 1 ? "" : "s"}`);
    add("fields", `${data.members?.fields?.length || 0} field${data.members?.fields?.length === 1 ? "" : "s"}`);
    if (data.baseClasses?.length) add("bases", `extends ${data.baseClasses.join(", ")}`);
  }
  if (node.kind === "cell") add("cell", `notebook cell ${data.index != null ? data.index + 1 : ""}`.trim());
  if (node.kind === "http-route") add("route", `${(data.method || "GET").toUpperCase()} ${node.label}`);
  if (node.kind === "db-model") add("model", `database model ${node.label}`);
  if (node.kind === "env") add("env", `reads ${node.label}`);
  if (node.kind === "infra-resource") add("infra", `${data.type || "resource"} ${node.label}`);
  if (node.kind === "package") add("package", `external package ${node.label}`);

  if (edgeCounts.in.total) add("incoming", `${edgeCounts.in.total} incoming relationship${edgeCounts.in.total === 1 ? "" : "s"}`);
  if (edgeCounts.out.total) add("outgoing", `${edgeCounts.out.total} outgoing relationship${edgeCounts.out.total === 1 ? "" : "s"}`);
  return facts;
}

function mergeFacts(existing, generated) {
  const out = [];
  const seen = new Set();
  for (const fact of [...(existing || []), ...generated]) {
    const key = `${fact.kind}:${fact.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out.slice(0, 12);
}

function importanceReasons(node, edgeCounts) {
  const reasons = [];
  if (node.kind === "http-route") reasons.push("public route");
  if (node.kind === "db-model") reasons.push("data model");
  if (node.kind === "env") reasons.push("configuration boundary");
  if (node.kind === "package") reasons.push("external dependency");
  if (edgeCounts.in.total) reasons.push(`${edgeCounts.in.total} incoming relationship${edgeCounts.in.total === 1 ? "" : "s"}`);
  if (edgeCounts.out.total) reasons.push(`${edgeCounts.out.total} outgoing relationship${edgeCounts.out.total === 1 ? "" : "s"}`);
  if (node.data?.warnings?.length) reasons.push("compiler warnings");
  if (node.data?.parseStatus && node.data.parseStatus !== "ok") reasons.push(`parser status: ${node.data.parseStatus}`);
  return reasons.slice(0, 5);
}

function normalizeMemberSources(node) {
  const data = node.data || {};
  const path = node.source?.path || data.file || data.path;
  if (!path) return;
  for (const method of data.members?.methods || []) {
    if (!method.source && method.line) {
      method.source = { path, startLine: method.line, endLine: method.line };
    }
  }
  for (const field of data.members?.fields || []) {
    if (!field.source && field.line) {
      field.source = { path, startLine: field.line, endLine: field.line };
    }
  }
}

function provenanceSummary(nodes, edges) {
  const confidence = {};
  const edgesByConfidence = {};
  const missingSourceByKind = {};
  let sourceBackedNodes = 0;
  let sourceBackedFacts = 0;
  let factCount = 0;

  for (const node of nodes) {
    confidence[node.confidence || "unknown"] = (confidence[node.confidence || "unknown"] || 0) + 1;
    if (node.source) sourceBackedNodes += 1;
    else missingSourceByKind[node.kind] = (missingSourceByKind[node.kind] || 0) + 1;
    for (const fact of node.facts || []) {
      factCount += 1;
      if (fact.source) sourceBackedFacts += 1;
    }
  }
  for (const edge of edges) {
    edgesByConfidence[edge.confidence || "unknown"] = (edgesByConfidence[edge.confidence || "unknown"] || 0) + 1;
  }
  return {
    sourceAnchorCoverage: ratio(sourceBackedNodes, nodes.length),
    factProvenanceCoverage: ratio(sourceBackedFacts, factCount),
    confidence,
    edgesByConfidence,
    missingSourceByKind: sortObject(missingSourceByKind),
    factsMissingProvenance: Math.max(0, factCount - sourceBackedFacts),
  };
}

function bumpEdgeCount(map, id, direction, kind) {
  if (!id) return;
  const counts = map.get(id) || emptyEdgeCounts();
  counts[direction].total += 1;
  counts[direction].byKind[kind] = (counts[direction].byKind[kind] || 0) + 1;
  map.set(id, counts);
}

function emptyEdgeCounts() {
  return {
    in: { total: 0, byKind: {} },
    out: { total: 0, byKind: {} },
  };
}

function normalizeConfidence(value) {
  return CONFIDENCE.has(value) ? value : "unknown";
}

function parentPath(node) {
  return node?.parentId?.startsWith("file:") ? node.parentId.replace(/^file:/, "") : null;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function displayType(t) {
  return typeof t === "string" ? t : t?.display || "value";
}

function ratio(num, den) {
  return den > 0 ? Number((num / den).toFixed(3)) : 0;
}

function sortObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))),
  );
}
