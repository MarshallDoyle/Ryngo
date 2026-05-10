#!/usr/bin/env node
/**
 * Ryngo MCP stdio launcher.
 *
 * The shared tool contract lives in `lib/mcp.js` so the same MCP server can
 * run over stdio for Claude/Codex and over Streamable HTTP at `/mcp` for
 * ChatGPT Apps / hosted connectors.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRyngoMcpServer } from "./lib/mcp.js";

const server = createRyngoMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);

process.on("unhandledRejection", (err) => {
  console.error("[ryngo-mcp] unhandled rejection:", err);
});
