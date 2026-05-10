/**
 * Protocol smoke for the Ryngo MCP stdio launcher.
 *
 * Verifies tool/resource discovery without cloning a GitHub repo.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

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
    clientInfo: { name: "ryngo-mcp-smoke", version: "0.0.0" },
  },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
send({ jsonrpc: "2.0", id: 3, method: "resources/list" });

await waitForResponses(3);
child.kill("SIGTERM");
await Promise.race([once(child, "exit"), sleep(1000)]);

const messages = stdout
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const byId = new Map(messages.filter((m) => m.id).map((m) => [m.id, m]));

assert.equal(byId.get(1)?.result?.serverInfo?.name, "ryngo");
const tools = byId.get(2)?.result?.tools || [];
const resources = byId.get(3)?.result?.resources || [];
assert.ok(tools.some((t) => t.name === "get_view_model"), "get_view_model advertised");
assert.ok(tools.length >= 10, "existing tools plus get_view_model advertised");
assert.ok(resources.some((r) => r.uri === "ui://widget/ryngo-viewer.html"));
assert.equal(stderr.trim(), "", "stderr should stay clean during discovery");

console.log(`mcp smoke: ok (${tools.length} tools, ${resources.length} resources)`);

function send(message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

async function waitForResponses(count) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const responses = stdout
      .trim()
      .split(/\n+/)
      .filter(Boolean)
      .filter((line) => {
        try {
          return Boolean(JSON.parse(line).id);
        } catch {
          return false;
        }
      });
    if (responses.length >= count) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for MCP responses; stderr=${stderr}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
