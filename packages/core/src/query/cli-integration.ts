/**
 * cgql — CLI integration helpers.
 *
 * Pure formatting + argument-resolution functions. The actual `codegraph
 * query` command in packages/cli/src/commands/cmd-query.ts is a thin shell
 * over `runQuery` plus the formatters here. Keeping format logic in core
 * means the viewer's "Copy as `codegraph query` command" feature (§6.3) and
 * the GitHub Action both render identical output.
 */

import type { Edge, Node, NodeId } from "../ir/types.js";
import type { CellValue, EdgeRef, Path, QueryResult, Subgraph } from "./types.js";

// =============================================================================
// Formats
// =============================================================================

export type CliFormat = "table" | "json" | "path" | "subgraph" | "dot" | "mermaid";

export const ALL_CLI_FORMATS: CliFormat[] = [
  "table", "json", "path", "subgraph", "dot", "mermaid",
];

/**
 * Pick the default output format. Mirrors gh / kubectl: TTY → table,
 * pipe → json. The CLI passes `process.stdout.isTTY`.
 */
export function defaultFormatFor(isTTY: boolean): CliFormat {
  return isTTY ? "table" : "json";
}

/**
 * Top-level format dispatch. The CLI calls this with the runQuery envelope
 * and the resolved format; we return the single string to write to stdout.
 */
export function formatResult(
  result: QueryResult,
  format: CliFormat,
  store: { nodes: Map<NodeId, Node>; edges: Edge[] },
  opts: { quiet?: boolean } = {},
): string {
  if (result.diagnostics.some((d) => d.severity === "error")) {
    // Error path: render diagnostics so the user sees them even with --format=json.
    if (format === "json") return JSON.stringify(envelopeWithoutStats(result, opts.quiet), null, 2);
    return formatDiagnostics(result);
  }
  switch (format) {
    case "json": return JSON.stringify(envelopeWithoutStats(result, opts.quiet), null, 2);
    case "table": return formatTable(result, store);
    case "path": return formatPaths(result, store);
    case "subgraph": return formatSubgraph(result);
    case "dot": return formatDot(result, store);
    case "mermaid": return formatMermaid(result, store);
  }
}

function envelopeWithoutStats(result: QueryResult, quiet?: boolean): unknown {
  if (!quiet) return result;
  const { stats: _stats, ...rest } = result;
  return rest;
}

function formatDiagnostics(result: QueryResult): string {
  const lines: string[] = [];
  for (const d of result.diagnostics) {
    const prefix = `${d.severity}: ${d.source}`;
    const loc = d.line && d.col ? ` (${d.line}:${d.col})` : "";
    lines.push(`cgql: ${prefix}${loc}: ${d.message}`);
  }
  return lines.join("\n");
}

// =============================================================================
// Table
// =============================================================================

function formatTable(result: QueryResult, store: { nodes: Map<NodeId, Node>; edges: Edge[] }): string {
  if (result.shape === "subgraph") return formatSubgraph(result);
  if (result.shape === "paths") return formatPaths(result, store);

  const cols = result.columns ?? [];
  if (cols.length === 0 || result.rows.length === 0) return "(0 rows)";

  const matrix: string[][] = [cols.slice()];
  for (const row of result.rows) {
    matrix.push(row.map((c) => renderCell(c, store)));
  }
  const widths = cols.map((_, i) => Math.max(...matrix.map((r) => (r[i] ?? "").length)));
  const lines: string[] = [];
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r]!;
    lines.push(row.map((c, i) => c.padEnd(widths[i]!)).join("  "));
    if (r === 0) lines.push(sep);
  }
  lines.push("");
  lines.push(`(${result.rows.length} row${result.rows.length === 1 ? "" : "s"})`);
  return lines.join("\n");
}

function renderCell(c: CellValue, store: { nodes: Map<NodeId, Node> }): string {
  if (c === null || c === undefined) return "null";
  if (typeof c === "string") return c;
  if (typeof c === "number") return Number.isInteger(c) ? String(c) : c.toFixed(4);
  if (typeof c === "boolean") return String(c);
  if (Array.isArray(c)) return `[${c.map((x) => renderCell(x as CellValue, store)).join(", ")}]`;
  if (isNodeValue(c)) {
    const n = c as Node;
    return n.name ? `${n.name}#${n.id.slice(0, 8)}` : n.id;
  }
  if (isPath(c)) {
    const p = c as Path;
    return p.nodes.map((id) => store.nodes.get(id)?.name ?? id.slice(0, 8)).join(" -> ");
  }
  return JSON.stringify(c);
}

// =============================================================================
// Paths
// =============================================================================

function formatPaths(result: QueryResult, store: { nodes: Map<NodeId, Node> }): string {
  if (result.shape !== "paths" && !result.rows.some((r) => isPath(r[0] ?? null))) {
    return formatTable(result, { nodes: store.nodes, edges: [] });
  }
  const lines: string[] = [];
  for (const row of result.rows) {
    const v = row[0];
    if (isPath(v ?? null)) {
      const p = v as Path;
      lines.push(p.nodes.map((id) => store.nodes.get(id)?.name ?? id.slice(0, 8)).join(" -> "));
    }
  }
  if (lines.length === 0) return "(0 paths)";
  lines.push("");
  lines.push(`(${result.rows.length} path${result.rows.length === 1 ? "" : "s"})`);
  return lines.join("\n");
}

// =============================================================================
// Subgraph
// =============================================================================

function formatSubgraph(result: QueryResult): string {
  // A subgraph result has exactly one row containing the merged Subgraph.
  const v = result.rows[0]?.[0];
  if (!isSubgraph(v ?? null)) return JSON.stringify({ nodes: [], edges: [] }, null, 2);
  return JSON.stringify(v, null, 2);
}

// =============================================================================
// DOT / Mermaid
// =============================================================================

function formatDot(result: QueryResult, store: { nodes: Map<NodeId, Node>; edges: Edge[] }): string {
  const sg = collectSubgraph(result);
  const lines: string[] = ["digraph cgql {", "  rankdir=LR;"];
  for (const id of sg.nodes) {
    const n = store.nodes.get(id);
    const label = n?.name ?? id.slice(0, 8);
    lines.push(`  "${id}" [label="${escapeDot(label)}"];`);
  }
  for (const e of sg.edges) {
    lines.push(`  "${e.sourceId}" -> "${e.targetId}" [label="${e.category}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function formatMermaid(result: QueryResult, store: { nodes: Map<NodeId, Node>; edges: Edge[] }): string {
  const sg = collectSubgraph(result);
  const lines: string[] = ["graph LR"];
  for (const id of sg.nodes) {
    const n = store.nodes.get(id);
    const label = n?.name ?? id.slice(0, 8);
    lines.push(`  ${shortId(id)}["${escapeMermaid(label)}"]`);
  }
  for (const e of sg.edges) {
    lines.push(`  ${shortId(e.sourceId)} -- ${e.category} --> ${shortId(e.targetId)}`);
  }
  return lines.join("\n");
}

function collectSubgraph(result: QueryResult): Subgraph {
  const nodes = new Set<string>();
  const edges = new Map<number, EdgeRef>();
  for (const row of result.rows) {
    for (const cell of row) {
      if (isNodeValue(cell)) nodes.add((cell as Node).id);
      else if (isPath(cell ?? null)) {
        for (const id of (cell as Path).nodes) nodes.add(id);
        for (const e of (cell as Path).edges) edges.set(e.index, e);
      } else if (isSubgraph(cell ?? null)) {
        for (const id of (cell as Subgraph).nodes) nodes.add(id);
        for (const e of (cell as Subgraph).edges) edges.set(e.index, e);
      }
    }
  }
  return {
    nodes: Array.from(nodes) as unknown as NodeId[],
    edges: Array.from(edges.values()),
  };
}

// =============================================================================
// Argument parsing
// =============================================================================

/**
 * Parse a `--params` JSON-or-key=value argument string.
 *
 *   --params 'foo=bar,baz=42'
 *   --params '{"foo":"bar","baz":42}'
 *   --params @params.json
 */
export function parseParamsArg(
  arg: string,
  readFile: (path: string) => string,
): Record<string, string | number | boolean | null> {
  if (arg.startsWith("@")) {
    const text = readFile(arg.slice(1));
    return JSON.parse(text);
  }
  const trimmed = arg.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const out: Record<string, string | number | boolean | null> = {};
  for (const pair of trimmed.split(",")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) throw new Error(`Bad --params entry "${pair}"; expected key=value`);
    const key = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1).trim();
    if (raw === "true") out[key] = true;
    else if (raw === "false") out[key] = false;
    else if (raw === "null") out[key] = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) out[key] = Number.parseFloat(raw);
    else out[key] = raw;
  }
  return out;
}

// =============================================================================
// Pure helpers
// =============================================================================

function isNodeValue(v: CellValue | null): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && "id" in (v as object) && "tier" in (v as object);
}

function isPath(v: CellValue | null): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && "nodes" in (v as object) && "edges" in (v as object) && "length" in (v as object);
}

function isSubgraph(v: CellValue | null): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && "nodes" in (v as object) && "edges" in (v as object) && !("length" in (v as object));
}

function shortId(id: string): string {
  return "n_" + id.slice(0, 12);
}

function escapeDot(s: string): string {
  return s.replace(/"/g, '\\"');
}

function escapeMermaid(s: string): string {
  return s.replace(/"/g, '#quot;');
}
