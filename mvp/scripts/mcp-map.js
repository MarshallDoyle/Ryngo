/**
 * Call Ryngo through its MCP stdio transport and print the codebase map.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const githubUrl = process.argv[2] || "https://github.com/vercel/ms";
const ref = process.argv[3] || "";

const child = spawn(process.execPath, ["mcp-server.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "ryngo-mcp-map", version: "0.0.0" },
  },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "get_view_model",
    arguments: {
      github_url: githubUrl,
      ref,
      max_nodes: 80,
    },
  },
});

const response = await waitForResponse(2, 120000);
child.kill("SIGTERM");
await Promise.race([once(child, "exit"), sleep(1000)]);

if (response.error) {
  throw new Error(response.error.message || JSON.stringify(response.error));
}
const result = response.result;
if (result?.isError) {
  const message = result.content?.map((c) => c.text).filter(Boolean).join("\n");
  throw new Error(message || "get_view_model returned an MCP error");
}
const vm = result?.structuredContent;
if (!vm || vm.version !== 1) {
  throw new Error(`get_view_model returned no RyngoViewModel v1; stderr=${stderr}`);
}

const text = result.content?.find((c) => c.type === "text")?.text || "";
console.log(text);
console.log("");
console.log(
  `MCP map OK: ${vm.repo}@${vm.ref} (${vm.nodes.length} nodes, ${vm.edges.length} edges, ${vm.clusters.length} clusters)`,
);

function send(message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

async function waitForResponse(id, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const line of stdout.trim().split(/\n+/).filter(Boolean)) {
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) return msg;
      } catch {
        // ignore partial lines while the child is still writing
      }
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for MCP response ${id}; stderr=${stderr}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
