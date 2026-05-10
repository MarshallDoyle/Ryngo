/**
 * Shared Ryngo MCP implementation.
 *
 * This module owns the tool contract and can be mounted on either stdio
 * (Claude/Codex local) or Streamable HTTP (ChatGPT Apps / hosted connectors).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { analyzeRepo } from "./analyze.js";
import {
  compactJson,
  englishSignature,
  topology,
  slice as sliceProjection,
} from "./projection-llm.js";
import { buildViewModel } from "./view-model.js";
import * as intentsLib from "./intents.js";
import * as annotationsLib from "./annotations.js";

const SESSION_CACHE_MS = 5 * 60 * 1000;
const WIDGET_URI = "ui://widget/ryngo-viewer.html";

const irCache = new Map(); // key -> { ts, ir }

function cacheKey(url, ref) {
  return `${url}@${ref || "HEAD"}`;
}

async function getIR(githubUrl, ref) {
  const k = cacheKey(githubUrl, ref);
  const hit = irCache.get(k);
  if (hit && Date.now() - hit.ts < SESSION_CACHE_MS) return hit.ir;
  const ir = await analyzeRepo(githubUrl, ref || "");
  irCache.set(k, { ts: Date.now(), ir });
  if (irCache.size > 8) {
    const oldest = [...irCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) irCache.delete(oldest[0]);
  }
  return ir;
}

const viewModelOutputSchema = {
  type: "object",
  properties: {
    version: { type: "number" },
    repo: { type: ["string", "null"] },
    ref: { type: "string" },
    mode: { type: "string" },
    summary: { type: "object" },
    nodes: { type: "array" },
    edges: { type: "array" },
    clusters: { type: "array" },
    highlights: { type: "object" },
    inspector: { type: "object" },
    prompts: { type: "array", items: { type: "string" } },
    limits: { type: "object" },
  },
  required: [
    "version",
    "repo",
    "ref",
    "mode",
    "summary",
    "nodes",
    "edges",
    "clusters",
    "highlights",
    "inspector",
    "prompts",
    "limits",
  ],
};

const BASE_TOOLS = [
  {
    name: "analyze_repo",
    description:
      "Clone a public GitHub repo (shallow) and return a compact analysis summary. " +
      "For model context use get_view_model, get_topology, or get_compact_ir.",
    inputSchema: githubRefSchema(),
  },
  {
    name: "get_view_model",
    description:
      "Return RyngoViewModel v1: a deterministic high-level graph contract for " +
      "Claude, ChatGPT widgets, and the Ryngo web viewer. Includes summary, " +
      "ranked nodes, aggregated edges, clusters, highlights, inspector defaults, " +
      "and drill-down prompts.",
    inputSchema: {
      type: "object",
      properties: {
        github_url: {
          type: "string",
          description: "https://github.com/owner/repo",
        },
        ref: {
          type: "string",
          description: "Branch, tag, or commit. Omit for the repo default.",
        },
        mode: {
          type: "string",
          enum: ["overview", "layers", "files"],
          default: "overview",
        },
        max_nodes: {
          type: "number",
          minimum: 20,
          maximum: 200,
          default: 80,
          description: "Maximum graph nodes to return in structuredContent.",
        },
      },
      required: ["github_url"],
    },
    outputSchema: viewModelOutputSchema,
    _meta: {
      "openai/toolInvocation/invoking": "Mapping the repo...",
      "openai/toolInvocation/invoked": "Repo map ready.",
    },
  },
  {
    name: "get_compact_ir",
    description:
      "Return a stripped-down IR with stable node ids. Drops layout, diff, and debug fields.",
    inputSchema: githubRefSchema(),
  },
  {
    name: "get_topology",
    description:
      "Bird's-eye markdown summary of the repo: languages, routes, packages, and hotspots.",
    inputSchema: githubRefSchema(),
  },
  {
    name: "get_subgraph",
    description:
      "Return the k-hop neighborhood around a node. Default 1 hop, max 3.",
    inputSchema: {
      type: "object",
      properties: {
        github_url: { type: "string" },
        root_id: {
          type: "string",
          description:
            "Stable node id (file:src/auth.ts | def:src/auth.ts#authenticate | ...)",
        },
        ref: { type: "string" },
        hops: { type: "number", minimum: 1, maximum: 3, default: 1 },
      },
      required: ["github_url", "root_id"],
    },
  },
  {
    name: "english_signature",
    description:
      "One-sentence deterministic prose description of a function or class node.",
    inputSchema: {
      type: "object",
      properties: {
        github_url: { type: "string" },
        node_id: { type: "string" },
        ref: { type: "string" },
      },
      required: ["github_url", "node_id"],
    },
  },
  {
    name: "find_node",
    description:
      "Fuzzy label search for nodes whose label contains the query string. Returns up to 20 matches.",
    inputSchema: {
      type: "object",
      properties: {
        github_url: { type: "string" },
        query: { type: "string" },
        ref: { type: "string" },
      },
      required: ["github_url", "query"],
    },
  },
  {
    name: "list_intents",
    description:
      "List apply-and-verify intents stored in this repo's `.ryngo/` directory.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "owner/repo identifier (NOT a URL).",
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "read_intent",
    description: "Read the full markdown body of one intent file.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        intent_id: { type: "string" },
      },
      required: ["repo", "intent_id"],
    },
  },
  {
    name: "list_annotations",
    description:
      "Read the freeform `.ryngo/annotations.md` file for a repo plus per-node counts.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
  },
];

export const TOOLS = toolsFor({ enableWidgets: false });

function toolsFor({ enableWidgets }) {
  return BASE_TOOLS.map((tool) => {
    if (tool.name !== "get_view_model") return tool;
    const next = {
      ...tool,
      _meta: { ...tool._meta },
    };
    if (enableWidgets) {
      next._meta.ui = { resourceUri: WIDGET_URI };
      next._meta["openai/outputTemplate"] = WIDGET_URI;
    }
    return next;
  });
}

/** Create a Ryngo MCP server with tools and widget resources registered. */
export function createRyngoMcpServer({ enableWidgets = false } = {}) {
  const server = new Server(
    { name: "ryngo", version: "0.1.0" },
    { capabilities: enableWidgets ? { tools: {}, resources: {} } : { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor({ enableWidgets }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params || {};
    try {
      return await dispatch(name, args, { enableWidgets });
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `ryngo:${name} failed: ${err.message || String(err)}`,
          },
        ],
      };
    }
  });
  if (enableWidgets) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: WIDGET_URI,
          name: "ryngo-viewer",
          title: "Ryngo Code Map",
          description: "Read-only graph widget for RyngoViewModel v1.",
          mimeType: "text/html;profile=mcp-app",
        },
      ],
    }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const uri = req.params?.uri;
      if (uri !== WIDGET_URI) {
        throw new Error(`unknown resource: ${uri}`);
      }
      return {
        contents: [
          {
            uri: WIDGET_URI,
            mimeType: "text/html;profile=mcp-app",
            text: ryngoViewerHtml(),
            _meta: { ui: { prefersBorder: true } },
          },
        ],
      };
    });
  }

  return server;
}

/** Handle one stateless Streamable HTTP MCP request. */
export async function handleMcpHttpRequest(req, res, { enableWidgets = true } = {}) {
  const server = createRyngoMcpServer({ enableWidgets });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error("[ryngo-mcp-http] request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

/** Dispatch one Ryngo MCP tool call by name. */
export async function dispatch(name, args, { enableWidgets = false } = {}) {
  switch (name) {
    case "analyze_repo": {
      const ir = await getIR(args.github_url, args.ref);
      return jsonResult({
        repo: ir.repo,
        ref: ir.ref,
        stats: ir.stats,
        nodeCount: ir.nodes.length,
        edgeCount: ir.edges.length,
      });
    }
    case "get_view_model": {
      const ir = await getIR(args.github_url, args.ref);
      const viewModel = buildViewModel(ir, {
        mode: args.mode,
        maxNodes: args.max_nodes,
      });
      const out = {
        structuredContent: viewModel,
        content: [
          {
            type: "text",
            text: viewModelMarkdown(viewModel),
          },
        ],
        _meta: {
          contract: "RyngoViewModel v1",
        },
      };
      if (enableWidgets) out._meta.widget = WIDGET_URI;
      return out;
    }
    case "get_compact_ir": {
      const ir = await getIR(args.github_url, args.ref);
      return jsonResult(compactJson(ir));
    }
    case "get_topology": {
      const ir = await getIR(args.github_url, args.ref);
      return textResult(topology(ir));
    }
    case "get_subgraph": {
      const ir = await getIR(args.github_url, args.ref);
      const out = sliceProjection(ir, args.root_id, {
        hops: Math.min(Math.max(Number(args.hops) || 1, 1), 3),
      });
      if (out.notFound) {
        return textResult(`Node ${args.root_id} not found in ${ir.repo}@${ir.ref}.`);
      }
      return jsonResult(out);
    }
    case "english_signature": {
      const ir = await getIR(args.github_url, args.ref);
      const node = ir.nodes.find((n) => n.id === args.node_id);
      if (!node) return textResult(`Node ${args.node_id} not in ${ir.repo}@${ir.ref}.`);
      return textResult(englishSignature(node) || `${node.kind} ${node.label}`);
    }
    case "find_node": {
      const ir = await getIR(args.github_url, args.ref);
      const q = String(args.query || "").toLowerCase();
      if (!q) return textResult("Empty query.");
      const hits = ir.nodes
        .filter((n) => (n.label || "").toLowerCase().includes(q))
        .slice(0, 20)
        .map((n) => ({
          id: n.id,
          kind: n.kind,
          label: n.label,
          file: n.data?.file || n.data?.path,
          line: n.data?.line,
        }));
      return jsonResult({ matches: hits, total: hits.length });
    }
    case "list_intents": {
      const list = await intentsLib.listIntents(args.repo);
      const enriched = list.map((it) => {
        const parsed = intentsLib.parseIntent(it.text);
        return {
          id: it.id,
          status: parsed?.meta?.status || "open",
          type: parsed?.meta?.type || "intent",
          node: parsed?.meta?.node || parsed?.nodeIds?.[0] || null,
          created: parsed?.meta?.created || null,
        };
      });
      return jsonResult({ repo: args.repo, intents: enriched });
    }
    case "read_intent": {
      const text = await intentsLib.readIntent(args.repo, args.intent_id);
      if (!text) return textResult(`Intent ${args.intent_id} not found.`);
      return textResult(text);
    }
    case "list_annotations": {
      const text = await annotationsLib.read(args.repo);
      const counts = await annotationsLib.countsByNode(args.repo);
      return jsonResult({
        repo: args.repo,
        countsByNode: counts,
        markdown: text,
      });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function viewModelMarkdown(vm) {
  const stats = vm.summary.stats;
  const languages = Object.entries(vm.summary.languages || {})
    .map(([lang, count]) => `${lang}: ${count}`)
    .join(", ");
  const clusters = vm.clusters
    .map((c) => `${c.label}: ${c.nodeIds.length}`)
    .join(", ");
  const hotspots = (vm.summary.hotspots || [])
    .slice(0, 5)
    .map((h) => `- ${h.path || h.label} (${h.degree} links)`)
    .join("\n");
  const topNodes = (vm.highlights.topNodes || [])
    .slice(0, 8)
    .map((n) => `- ${n.kind} \`${n.label}\` (${n.degree} links, id: \`${n.id}\`)`)
    .join("\n");
  const routes = (vm.highlights.routes || [])
    .slice(0, 8)
    .map((r) => `- ${r.label} (${r.path || r.parent || "unknown"})`)
    .join("\n");
  const prompts = (vm.prompts || [])
    .map((p) => `- ${p}`)
    .join("\n");

  return [
    `# Ryngo map: ${vm.repo}@${vm.ref}`,
    "",
    `Returned ${vm.nodes.length} viewer nodes and ${vm.edges.length} viewer edges` +
      (vm.limits.omittedNodes ? ` (${vm.limits.omittedNodes} nodes omitted by cap).` : "."),
    "",
    "## High-level stats",
    `- Files: ${stats.files} (${stats.analyzedFiles ?? "?"} analyzed)`,
    `- Functions/classes: ${stats.functions} functions, ${stats.classes} classes`,
    `- Routes/data/env: ${stats.routes} routes, ${stats.dbModels} models, ${stats.envVars} env vars`,
    `- Packages: ${stats.packages}`,
    languages ? `- Languages: ${languages}` : "- Languages: none detected",
    clusters ? `- Clusters: ${clusters}` : "- Clusters: none",
    "",
    "## Hot files",
    hotspots || "- None",
    "",
    "## Important nodes",
    topNodes || "- None",
    "",
    routes ? ["## Routes", routes, ""].join("\n") : "",
    "## Suggested next questions",
    prompts || "- Ask for a subgraph around any node id above.",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function githubRefSchema() {
  return {
    type: "object",
    properties: {
      github_url: {
        type: "string",
        description: "https://github.com/owner/repo",
      },
      ref: {
        type: "string",
        description: "Branch, tag, or commit. Omit for the repo default.",
      },
    },
    required: ["github_url"],
  };
}

function jsonResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function textResult(s) {
  return { content: [{ type: "text", text: s }] };
}

function ryngoViewerHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
    body { margin: 0; background: #fbfaf2; color: #172033; }
    .wrap { padding: 14px; display: grid; gap: 12px; }
    .top { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    h1 { font-size: 16px; margin: 0; font-weight: 750; }
    .meta { font-size: 12px; color: #667085; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 12px; }
    .graph { min-height: 320px; border: 1px solid #d8d3b4; background: #fffdf4; position: relative; overflow: hidden; }
    .node { position: absolute; width: 150px; min-height: 46px; border: 1px solid #98a2b3; background: #fff; padding: 8px; box-sizing: border-box; font-size: 12px; cursor: pointer; }
    .node.is-selected { outline: 3px solid #0e7490; }
    .node small { display: block; color: #667085; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .frontend { border-color: #2563eb; background: #eff6ff; }
    .backend { border-color: #0f766e; background: #ecfdf5; }
    .data { border-color: #7c3aed; background: #f5f3ff; }
    .infra { border-color: #b45309; background: #fff7ed; }
    .tests { border-color: #64748b; background: #f8fafc; }
    .config { border-color: #4d7c0f; background: #f7fee7; }
    .side { border: 1px solid #d8d3b4; background: #fffdf4; padding: 10px; font-size: 12px; }
    .side h2 { font-size: 13px; margin: 0 0 8px; }
    .side p { margin: 0 0 8px; line-height: 1.35; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } .side { min-height: 120px; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1 id="title">Ryngo Code Map</h1>
      <div id="meta" class="meta"></div>
    </div>
    <div class="grid">
      <div id="graph" class="graph"></div>
      <aside class="side">
        <h2 id="inspectorTitle">Select a node</h2>
        <p id="inspectorBody">The graph will render when ChatGPT sends a tool result.</p>
        <p id="limits" class="meta"></p>
      </aside>
    </div>
  </div>
  <script>
    let current = null;
    let selectedId = null;
    if (window.openai && window.openai.toolOutput && window.openai.toolOutput.version === 1) {
      render(window.openai.toolOutput);
    }
    window.addEventListener("openai:set_globals", (event) => {
      const data = event.detail && event.detail.globals && event.detail.globals.toolOutput;
      if (data && data.version === 1) render(data);
    }, { passive: true });
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method !== "ui/notifications/tool-result") return;
      const data = message.params && message.params.structuredContent;
      if (data && data.version === 1) render(data);
    }, { passive: true });
    function render(vm) {
      current = vm;
      selectedId = vm.inspector && vm.inspector.defaultNodeId;
      document.getElementById("title").textContent = vm.repo || "Ryngo Code Map";
      document.getElementById("meta").textContent = (vm.ref || "HEAD") + " · " + vm.nodes.length + " nodes · " + vm.edges.length + " edges";
      document.getElementById("limits").textContent = vm.limits.omittedNodes ? vm.limits.omittedNodes + " nodes omitted by cap" : "Full view returned";
      const graph = document.getElementById("graph");
      graph.innerHTML = "";
      const cols = Math.max(1, Math.ceil(Math.sqrt(vm.nodes.length)));
      vm.nodes.forEach((node, i) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "node " + (node.layer || "other") + (node.id === selectedId ? " is-selected" : "");
        el.style.left = (18 + (i % cols) * 172) + "px";
        el.style.top = (18 + Math.floor(i / cols) * 72) + "px";
        el.innerHTML = "<strong></strong><small></small>";
        el.querySelector("strong").textContent = node.label;
        el.querySelector("small").textContent = node.kind + " · " + (node.path || node.layerLabel || "");
        el.addEventListener("click", () => { selectedId = node.id; updateSelection(); });
        graph.appendChild(el);
      });
      updateInspector();
    }
    function updateSelection() {
      document.querySelectorAll(".node").forEach((el, i) => {
        el.classList.toggle("is-selected", current.nodes[i].id === selectedId);
      });
      updateInspector();
    }
    function updateInspector() {
      if (!current) return;
      const node = current.nodes.find((n) => n.id === selectedId) || current.nodes[0];
      if (!node) return;
      document.getElementById("inspectorTitle").textContent = node.label;
      document.getElementById("inspectorBody").textContent = node.description + " · " + node.kind + " · " + (node.path || node.layerLabel || "unknown");
    }
  </script>
</body>
</html>`;
}
