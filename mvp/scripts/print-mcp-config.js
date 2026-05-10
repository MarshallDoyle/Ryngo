/**
 * Print local MCP client config snippets for Ryngo.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const mvpDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverPath = path.join(mvpDir, "mcp-server.js");

const claude = {
  mcpServers: {
    ryngo: {
      command: "node",
      args: [serverPath],
    },
  },
};

console.log("# Ryngo MCP server path");
console.log(serverPath);
console.log("");
console.log("# Claude Code / Claude Desktop JSON");
console.log(JSON.stringify(claude, null, 2));
console.log("");
console.log("# Codex config.toml");
console.log("[mcp_servers.ryngo]");
console.log('command = "node"');
console.log(`args = ["${serverPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`);
console.log("");
console.log("# ChatGPT connector URL");
console.log("Run `npm run dev:api`, expose port 3000 with ngrok/cloudflared, then use:");
console.log("https://<your-tunnel-host>/mcp");
