/**
 * Smoke test the optional Postgres event warehouse.
 */
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  ensureEventSchema,
  eventsEnabled,
  recordAnalysisRun,
  recordMcpToolCall,
  recordUsageEvent,
} from "../lib/events.js";

if (!eventsEnabled()) {
  console.log("events smoke: skipped (DATABASE_URL not set)");
  process.exit(0);
}

await ensureEventSchema();
const githubUrl = "https://github.com/vercel/ms";
const ir = {
  repo: "vercel/ms",
  ref: "HEAD",
  nodes: [
    {
      id: "file:src/index.ts",
      kind: "file",
      label: "index.ts",
      data: {
        path: "src/index.ts",
        ext: ".ts",
        lang: "ts",
        analyzable: true,
        parserBackend: "regex",
        parseStatus: "ok",
        size: 1200,
      },
    },
    {
      id: "def:src/index.ts#ms",
      kind: "function",
      label: "ms",
      parentId: "file:src/index.ts",
      data: { file: "src/index.ts" },
    },
  ],
  edges: [],
  stats: {
    files: 1,
    analyzedFiles: 1,
    routes: 0,
    dbModels: 0,
    envReads: 0,
    packages: 0,
    truncated: false,
    ranAdapters: ["env"],
  },
  diagnostics: [],
};

await recordUsageEvent("events_smoke", {
  source: "internal",
  githubUrl,
  status: "ok",
  props: { smoke: true },
});
await recordAnalysisRun({
  source: "internal",
  githubUrl,
  ref: "HEAD",
  status: "ok",
  durationMs: 12,
  ir,
});
await recordMcpToolCall({
  toolName: "get_view_model",
  args: { github_url: githubUrl, max_nodes: 40 },
  status: "ok",
  durationMs: 10,
  result: {
    structuredContent: {
      version: 1,
      repo: "vercel/ms",
      ref: "HEAD",
      nodes: [{ id: "file:src/index.ts" }],
      edges: [],
      limits: { omittedNodes: 0, omittedEdges: 0 },
      prompts: [],
    },
  },
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query(`
  select
    (select count(*)::int from usage_events where event_name = 'events_smoke') as usage_count,
    (select count(*)::int from analysis_runs where source = 'internal') as run_count,
    (select count(*)::int from file_outcomes) as file_count,
    (select count(*)::int from mcp_tool_calls where tool_name = 'get_view_model') as mcp_count
`);
await pool.end();

assert.ok(rows[0].usage_count >= 1, "usage event inserted");
assert.ok(rows[0].run_count >= 1, "analysis run inserted");
assert.ok(rows[0].file_count >= 1, "file outcome inserted");
assert.ok(rows[0].mcp_count >= 1, "mcp tool call inserted");

console.log(
  `events smoke: ok (${rows[0].usage_count} usage, ${rows[0].run_count} runs, ${rows[0].file_count} files, ${rows[0].mcp_count} mcp calls)`,
);
