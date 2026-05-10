/**
 * D2 renderer.
 *
 * Spec: design/exports.md §3.
 *
 * D2's nested-container syntax mirrors the IR's `service > module > type
 * > function` tiering, and its layout (with the ELK engine) handles deep
 * containment cleanly. We emit one container per service/module/type and
 * one leaf per function/expression, then connections at the bottom.
 */

import {
  sortedForEmission,
  ancestryOf,
  type IR,
  type IRDocument,
  type IRNode,
  type IREdge,
} from "./subgraph.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface D2RenderOptions {
  /** Default 40 — matches Mermaid for cross-format consistency. */
  labelMaxChars?: number;
  noTimestamp?: boolean;
  noVersion?: boolean;
  version?: string;
  /** ELK by default; D2 supports `dagre` / `elk` / `tala`. */
  layoutEngine?: "elk" | "dagre" | "tala";
}

const DEFAULT_LABEL_MAX = 40;
const DEFAULT_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Identifier sanitization (§3.3)
// ---------------------------------------------------------------------------

const D2_RESERVED = new Set([
  "vars", "classes", "style", "shape", "label", "direction", "near", "icon",
  "source-arrowhead", "target-arrowhead", "constraint", "tooltip", "link",
  "width", "height", "top", "left", "fill", "stroke",
]);

function d2Id(raw: string): string {
  // `/` → `__`, `.` → `_`; collapse anything else to `_`. Quote reserved
  // identifiers via the caller (we keep them bare here so the dot path
  // syntax keeps working).
  const s = raw
    .replace(/\//g, "__")
    .replace(/\./g, "_")
    .replace(/[^A-Za-z0-9_]/g, "_");
  if (D2_RESERVED.has(s)) return `${s}_node`;
  // D2 ids may not start with a digit when used in path positions.
  return /^[0-9]/.test(s) ? `n_${s}` : s || "n_x";
}

function shortHex(id: string): string {
  const hexMatch = /^[0-9a-fA-F]+$/.test(id);
  if (hexMatch) return id.slice(0, 8).padStart(8, "0");
  const safe = id.replace(/[^A-Za-z0-9]/g, "");
  return safe.slice(Math.max(0, safe.length - 8)) || "00000000";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function render(doc: IRDocument, opts: D2RenderOptions = {}): string {
  const ir = doc.ir;
  const ctx: Ctx = {
    labelMax: opts.labelMaxChars ?? DEFAULT_LABEL_MAX,
    version: opts.version ?? DEFAULT_VERSION,
    noTimestamp: opts.noTimestamp === true,
    noVersion: opts.noVersion === true,
    engine: opts.layoutEngine ?? "elk",
  };

  const out: string[] = [];
  emitHeader(out, ir, ctx);
  out.push(`vars: {`);
  out.push(`  d2-config: {`);
  out.push(`    layout-engine: ${ctx.engine}`);
  out.push(`  }`);
  out.push(`}`);
  out.push("");
  out.push(`classes: {`);
  out.push(`  pure:      { style: { fill: "#dff5e1"; stroke: "#3a8" } }`);
  out.push(`  effectful: { style: { fill: "#fde7e7"; stroke: "#a33" } }`);
  out.push(`  sink:      { style: { fill: "#fff4d1"; stroke: "#a83" } }`);
  out.push(`  entry:     { style: { fill: "#e0f0ff"; stroke: "#36a" } }`);
  out.push(`  leaf:      { style: { fill: "#f4f4f4"; stroke: "#888" } }`);
  out.push(`}`);
  out.push("");

  const { nodes, edges } = sortedForEmission(ir);
  const byId = new Map<string, IRNode>();
  for (const n of nodes) byId.set(n.id as string, n);

  const childrenOf = new Map<string, IRNode[]>();
  for (const n of nodes) {
    const pid = (n as { parentId?: string }).parentId;
    if (!pid) continue;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid)!.push(n);
  }

  // Compute the D2 path ("api.routes__signup_ts.handleSignup") for
  // every node — used both when emitting and when writing edges.
  const paths = new Map<string, string>();
  // Determine roots first: any node without a parent in the sub-IR.
  const roots: IRNode[] = [];
  for (const n of nodes) {
    const pid = (n as { parentId?: string }).parentId;
    if (!pid || !byId.has(pid)) roots.push(n);
  }
  roots.sort((a, b) => (a.id as string).localeCompare(b.id as string));

  // Emit recursively, recording the path on the way down.
  for (const root of roots) {
    emitD2Node(out, root, byId, childrenOf, paths, "", ctx);
  }

  out.push("");

  // Emit connections (§3.1). Parallel edges are preserved (§3.3) — D2
  // supports them natively.
  for (const e of edges) {
    const sp = paths.get(e.sourceId as string);
    const tp = paths.get(e.targetId as string);
    if (!sp || !tp) continue;
    const label = formatEdgeLabel(e, ctx.labelMax);
    const styleAttrs = formatEdgeStyle(e);
    if (styleAttrs.length === 0) {
      out.push(`${sp} -> ${tp}: "${label}"`);
    } else {
      out.push(`${sp} -> ${tp}: "${label}" {`);
      for (const a of styleAttrs) out.push(`  ${a}`);
      out.push(`}`);
    }
  }

  return out.join("\n") + "\n";
}

interface Ctx {
  labelMax: number;
  version: string;
  noTimestamp: boolean;
  noVersion: boolean;
  engine: "elk" | "dagre" | "tala";
}

// ---------------------------------------------------------------------------
// Container emission
// ---------------------------------------------------------------------------

function emitD2Node(
  out: string[],
  node: IRNode,
  byId: Map<string, IRNode>,
  childrenOf: Map<string, IRNode[]>,
  paths: Map<string, string>,
  parentPath: string,
  ctx: Ctx,
  indent = "",
): void {
  const localId = d2Id((node as { name?: string }).name ?? node.id as string);
  const fullPath = parentPath ? `${parentPath}.${localId}` : localId;
  paths.set(node.id as string, fullPath);

  const shape = d2Shape(node);
  const label = d2Label(node);
  const cls = d2Class(node);

  const children = (childrenOf.get(node.id as string) ?? []).slice();
  children.sort((a, b) => (a.id as string).localeCompare(b.id as string));

  if (children.length === 0) {
    out.push(`${indent}${localId}: {`);
    out.push(`${indent}  shape: ${shape}`);
    out.push(`${indent}  label: "${escapeD2Label(label)}"`);
    if (cls) out.push(`${indent}  class: ${cls}`);
    out.push(`${indent}}`);
    return;
  }

  // Container with children.
  out.push(`${indent}${localId}: {`);
  out.push(`${indent}  shape: ${shape}`);
  out.push(`${indent}  label: "${escapeD2Label(label)}"`);
  if (cls) out.push(`${indent}  class: ${cls}`);
  out.push("");
  for (const c of children) {
    emitD2Node(out, c, byId, childrenOf, paths, fullPath, ctx, indent + "  ");
  }
  out.push(`${indent}}`);
}

// ---------------------------------------------------------------------------
// Shape / label / class lookup tables (§3.1)
// ---------------------------------------------------------------------------

function d2Shape(node: IRNode): string {
  if (node.tier === "service") return "package";
  if (node.tier === "module") return "page";
  if (node.tier === "type") return "class";
  if (node.tier === "function") return "rectangle";
  if (node.tier === "expression") {
    const ex = node as {
      leaf?: { flavor?: string };
      sink?: { flavor?: string };
    };
    if (ex.sink) {
      switch (ex.sink.flavor) {
        case "db-write": return "cylinder";
        case "network":  return "cloud";
        case "fs":       return "page";
        case "exec":     return "hexagon";
        case "log":      return "stored_data";
        default:         return "rectangle";
      }
    }
    if (ex.leaf) {
      switch (ex.leaf.flavor) {
        case "literal":     return "text";
        case "env":         return "hexagon";
        case "http-input":  return "hexagon";
        case "config-file": return "page";
        case "cli-arg":     return "hexagon";
        case "external-api":return "cloud";
        case "db-read":     return "cylinder";
        default:            return "rectangle";
      }
    }
    return "rectangle";
  }
  return "rectangle";
}

function d2Label(node: IRNode): string {
  const name = (node as { name?: string }).name;
  if (node.tier === "service") {
    const path = (node as { path?: string }).path;
    return path ? `${name ?? ""} (service · ${path})` : `${name ?? ""} (service)`;
  }
  if (node.tier === "module") {
    return (node as { path?: string }).path ?? name ?? (node.id as string);
  }
  if (node.tier === "type") {
    return name ?? (node.id as string);
  }
  if (node.tier === "function") {
    const f = node as {
      name?: string;
      params?: Array<{ name: string; type?: { display?: string } }>;
      returnType?: { display?: string };
      receiverType?: { display?: string };
    };
    const params = (f.params ?? [])
      .map((p) => `${p.name}: ${p.type?.display ?? "any"}`)
      .join(", ");
    const ret = f.returnType?.display ?? "void";
    const recv = f.receiverType?.display;
    const namePart = recv ? `${recv}.${f.name ?? "anon"}` : (f.name ?? "anon");
    return `${namePart}(${params}): ${ret}`;
  }
  if (node.tier === "expression") {
    const ex = node as {
      sink?: { flavor?: string; store?: string; entity?: string; op?: string; method?: string; url?: string };
      leaf?: { flavor?: string; value?: unknown; name?: string; from?: string; field?: string; service?: string; url?: string };
    };
    if (ex.sink) {
      const s = ex.sink;
      switch (s.flavor) {
        case "db-write":
          return `DB-write: ${[s.store, s.entity].filter(Boolean).join(".")}${s.op ? ` (${s.op})` : ""}`;
        case "network":
          return `network: ${[s.method, s.url].filter(Boolean).join(" ")}`;
        case "fs":
          return `fs: ${s.op ?? ""}`;
        case "exec":
          return "exec";
        case "log":
          return "log";
        default:
          return s.flavor ?? "sink";
      }
    }
    if (ex.leaf) {
      const l = ex.leaf;
      switch (l.flavor) {
        case "literal":
          return `lit: ${shortJson(l.value)}`;
        case "env":
          return `env: ${l.name ?? "?"}`;
        case "http-input":
          return `http-input: ${[l.from, l.field].filter(Boolean).join(".")}`;
        case "external-api":
          return `ext: ${[l.service, l.url].filter(Boolean).join(" ")}`;
        case "db-read":
          return "db-read";
        default:
          return l.flavor ?? "leaf";
      }
    }
    return name ?? (node.id as string);
  }
  return name ?? (node.id as string);
}

function d2Class(node: IRNode): string | null {
  if (node.tier === "function") {
    const f = node as { pure?: boolean };
    if (f.pure === true) return "pure";
    if (f.pure === false) return "effectful";
  }
  if (node.tier === "expression") {
    const ex = node as { sink?: unknown; leaf?: unknown };
    if (ex.sink) return "sink";
    if (ex.leaf) return "leaf";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edge formatting
// ---------------------------------------------------------------------------

function formatEdgeLabel(e: IREdge, maxLen: number): string {
  const cat = e.category as string;
  const a = e as Record<string, unknown>;
  const display = (a.valueType as { display?: string } | undefined)?.display;
  let label: string;
  switch (cat) {
    case "call":
      label = display ? `call: ${display}` : "call";
      break;
    case "import":
      label = "import";
      break;
    case "type-flow":
      label = display ?? "type-flow";
      break;
    case "http-route":
      label = `${(a.method as string | undefined) ?? "HTTP"} ${(a as { path?: string }).path ?? ""}`.trim();
      break;
    case "db-read":
      label = a.entity ? `R: ${a.entity as string}` : "R";
      break;
    case "db-write":
      label = a.entity ? `W: ${a.entity as string}` : "W";
      break;
    case "network":
      label = [a.method as string | undefined, a.url as string | undefined]
        .filter(Boolean)
        .join(" ") || "network";
      break;
    case "env-read":
      label = a.name ? `env ${a.name as string}` : "env";
      break;
    default:
      label = display ?? cat;
  }
  return escapeD2Label(truncate(label, maxLen));
}

function formatEdgeStyle(e: IREdge): string[] {
  const out: string[] = [];
  const cat = e.category as string;
  switch (cat) {
    case "import":
      out.push(`style.stroke-dash: 3`);
      break;
    case "type-flow":
      out.push(`style.stroke-width: 2`);
      out.push(`style.stroke: "#36a"`);
      break;
    case "http-route":
      out.push(`style.stroke: "#0a7"`);
      break;
    case "db-read":
      out.push(`style.stroke: "#06a"`);
      break;
    case "db-write":
      out.push(`style.stroke: "#a06"`);
      out.push(`style.stroke-width: 2`);
      break;
    case "network":
      out.push(`style.stroke: "#a30"`);
      out.push(`style.stroke-width: 2`);
      break;
    case "env-read":
      out.push(`style.stroke-dash: 5`);
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Header / escaping helpers
// ---------------------------------------------------------------------------

function emitHeader(out: string[], ir: IR, ctx: Ctx): void {
  const versionTag = ctx.noVersion ? "" : ` ${ctx.version}`;
  out.push(`# codegraph${versionTag} — D2`);
  const sel = (ir.metadata as { selection?: { roots?: ReadonlyArray<string>; depth?: number | null; filters?: ReadonlyArray<string>; direction?: string; includeParents?: boolean; selectedAt?: string } }).selection;
  if (sel) {
    const flagBits: string[] = [];
    for (const r of sel.roots ?? []) flagBits.push(`--root ${r}`);
    if (sel.depth !== undefined && sel.depth !== null) flagBits.push(`--depth ${sel.depth}`);
    if (sel.direction && sel.direction !== "out") flagBits.push(`--direction ${sel.direction}`);
    for (const f of sel.filters ?? []) flagBits.push(`--filter ${f}`);
    if (sel.includeParents === false) flagBits.push("--no-include-parents");
    if (flagBits.length > 0) out.push(`# selection: ${flagBits.join(" ")}`);
    if (!ctx.noTimestamp && sel.selectedAt) out.push(`# generatedAt: ${sel.selectedAt}`);
  }
  out.push("");
}

function escapeD2Label(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ");
}

function truncate(s: string, maxLen: number): string {
  if (maxLen <= 0 || s.length <= maxLen) return s;
  return s.slice(0, Math.max(1, maxLen - 1)) + "…";
}

function shortJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.length > 12 ? v.slice(0, 12) + "…" : v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 16 ? s.slice(0, 16) + "…" : s;
  } catch {
    return String(v);
  }
}

// Suppress lint complaints about unused helpers retained for symmetry with mermaid/dot.
void shortHex;
void ancestryOf;
