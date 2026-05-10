/**
 * Smoke test for RyngoViewModel v1.
 *
 * Uses a synthetic IR so the contract can be checked without network access.
 */
import assert from "node:assert/strict";
import { buildViewModel } from "../lib/view-model.js";

const ir = {
  repo: "example/app",
  ref: "main",
  stats: {
    files: 4,
    analyzedFiles: 4,
  },
  nodes: [
    file("server.js", "js"),
    file("src/App.jsx", "js"),
    file("prisma/schema.prisma", "prisma"),
    file(".env.example", "env"),
    def("server.js", "createServer", "function", [{ name: "port" }]),
    def("src/App.jsx", "App", "function", []),
    {
      id: "route:server.js#GET /api/health",
      kind: "http-route",
      label: "/api/health",
      parentId: "file:server.js",
      data: { method: "GET", path: "server.js", framework: "express" },
    },
    {
      id: "model:prisma/schema.prisma#User",
      kind: "db-model",
      label: "User",
      parentId: "file:prisma/schema.prisma",
      data: { path: "prisma/schema.prisma" },
    },
    {
      id: "env:DATABASE_URL",
      kind: "env",
      label: "DATABASE_URL",
      parentId: "file:server.js",
      data: { path: "server.js" },
    },
    { id: "pkg:express", kind: "package", label: "express" },
    { id: "pkg:react", kind: "package", label: "react" },
  ],
  edges: [
    edge("file:server.js", "pkg:express", "imports-package"),
    edge("file:src/App.jsx", "pkg:react", "imports-package"),
    edge("file:server.js", "route:server.js#GET /api/health", "defines-route"),
    edge("route:server.js#GET /api/health", "def:server.js#createServer", "route-handler"),
    edge("file:server.js", "env:DATABASE_URL", "env-read"),
    edge("def:server.js#createServer", "model:prisma/schema.prisma#User", "db-read"),
  ],
};

const a = buildViewModel(ir, { maxNodes: 20 });
const b = buildViewModel(ir, { maxNodes: 20 });

assert.deepEqual(a, b, "view model must be deterministic");
assert.equal(a.version, 1);
assert.equal(a.repo, "example/app");
assert.ok(a.summary.stats.routes >= 1, "route stats should be present");
assert.ok(a.summary.languages.js >= 2, "language counts should be present");
assert.ok(a.nodes.some((n) => n.kind === "http-route"), "route node should be kept");
assert.ok(a.nodes.some((n) => n.kind === "db-model"), "db model node should be kept");
assert.ok(a.clusters.some((c) => c.layer === "backend"), "backend cluster should exist");
assert.ok(a.inspector.defaultNodeId, "inspector default should exist");
assert.ok(a.nodes.every((n) => n.confidence), "nodes should include confidence");
assert.ok(a.nodes.some((n) => n.source?.path), "nodes should include source spans");
assert.ok(a.nodes.some((n) => n.facts?.length), "nodes should include source-backed facts");
assert.ok(a.inspector.facts?.facts?.length, "inspector should include selected-node facts");
assert.ok(a.limits.omittedNodesByKind, "limits should include omitted node kinds");
assert.ok(a.prompts.length >= 3, "drill-down prompts should exist");

const capped = buildViewModel(ir, { maxNodes: 3 });
assert.equal(capped.limits.maxNodes, 20, "maxNodes clamps to the safe minimum");

const bigIr = {
  ...ir,
  nodes: [
    ...ir.nodes,
    ...Array.from({ length: 30 }, (_, i) =>
      def("server.js", `helper${String(i).padStart(2, "0")}`, "function", []),
    ),
  ],
};
const truncated = buildViewModel(bigIr, { maxNodes: 20 });
assert.ok(truncated.limits.omittedNodes > 0, "large views should report truncation");
assert.equal(truncated.limits.reason, "max_nodes");

console.log(
  `view-model smoke: ok (${a.nodes.length} nodes, ${a.edges.length} edges, ${a.clusters.length} clusters)`,
);

function file(path, lang) {
  return {
    id: `file:${path}`,
    kind: "file",
    label: path,
    source: { path, startLine: 1, endLine: 1 },
    confidence: "source-syntax",
    facts: [{ kind: "language", text: `language: ${lang}`, confidence: "source-syntax", source: { path, startLine: 1, endLine: 1 } }],
    data: { path, file: path, lang, ext: path.slice(path.lastIndexOf(".")) },
  };
}

function def(path, name, kind, params) {
  return {
    id: `def:${path}#${name}`,
    kind,
    label: name,
    parentId: `file:${path}`,
    source: { path, startLine: 1, endLine: 1 },
    confidence: "source-syntax",
    facts: [{ kind: "params", text: `${params.length} parameters`, confidence: "source-syntax", source: { path, startLine: 1, endLine: 1 } }],
    data: { path, file: path, line: 1, params },
  };
}

function edge(source, target, kind) {
  return {
    id: `${source}->${target}:${kind}`,
    source,
    target,
    kind,
    confidence: kind === "calls" ? "confirmed" : "framework-inferred",
  };
}
