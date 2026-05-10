/**
 * Smoke test a running Streamable HTTP MCP endpoint.
 */
const endpoint = process.argv[2] || "http://localhost:3000/mcp";
const githubUrl = process.argv[3] || "https://github.com/vercel/ms";
const expectWidget = !endpoint.includes("/plain");

const tools = await mcpPost({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
});

const toolNames = tools.result?.tools?.map((tool) => tool.name) || [];
if (!toolNames.includes("get_view_model")) {
  throw new Error(`get_view_model missing from ${endpoint}; tools=${toolNames.join(", ")}`);
}

let resourceUris = [];
if (expectWidget) {
  const resources = await mcpPost({
    jsonrpc: "2.0",
    id: 2,
    method: "resources/list",
  });
  resourceUris = resources.result?.resources?.map((resource) => resource.uri) || [];
  if (!resourceUris.includes("ui://widget/ryngo-viewer.html")) {
    throw new Error(`viewer widget missing from ${endpoint}; resources=${resourceUris.join(", ")}`);
  }
}

const map = await mcpPost({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "get_view_model",
    arguments: {
      github_url: githubUrl,
      max_nodes: 40,
    },
  },
});

if (map.error) {
  throw new Error(map.error.message || JSON.stringify(map.error));
}
if (map.result?.isError) {
  const message = map.result.content?.map((c) => c.text).filter(Boolean).join("\n");
  throw new Error(message || "get_view_model returned an MCP error");
}

const vm = map.result?.structuredContent;
if (!vm || vm.version !== 1) {
  throw new Error(`get_view_model did not return RyngoViewModel v1 from ${endpoint}`);
}

console.log(
  `mcp http smoke: ok ${endpoint} (${toolNames.length} tools, ${resourceUris.length} resources, ${vm.repo}@${vm.ref}, ${vm.nodes.length} nodes)`,
);

async function mcpPost(body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${endpoint} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return parseMcpResponse(text);
}

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty MCP response");
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = trimmed
    .split(/\n/)
    .find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error(`could not parse MCP response: ${trimmed.slice(0, 500)}`);
  }
  return JSON.parse(dataLine.slice("data:".length).trim());
}
