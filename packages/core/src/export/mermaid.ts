/**
 * Mermaid renderer.
 *
 * Spec: design/exports.md §2.
 *
 * Two flavors: `flowchart` (service / module level) and `classDiagram`
 * (type level). Auto-selected from the dominant tier in the sub-IR with
 * ties broken toward `flowchart`; can be forced via `flavor` option.
 */

import {
  dominantTier,
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

export type MermaidFlavor = "flowchart" | "classDiagram";

export interface MermaidRenderOptions {
  flavor?: MermaidFlavor;
  /** Edge label truncation length (default 40 — see §2.3). */
  labelMaxChars?: number;
  /** Suppress the generation timestamp from the header comment. */
  noTimestamp?: boolean;
  /** Suppress the codegraph version from the header comment. */
  noVersion?: boolean;
  /** codegraph version stamped into the header. */
  version?: string;
}

const DEFAULT_LABEL_MAX = 40;
const DEFAULT_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function render(doc: IRDocument, opts: MermaidRenderOptions = {}): string {
  const ir = doc.ir;
  const flavor: MermaidFlavor = opts.flavor ?? autoFlavor(ir);
  const ctx: Ctx = {
    labelMax: opts.labelMaxChars ?? DEFAULT_LABEL_MAX,
    version: opts.version ?? DEFAULT_VERSION,
    noTimestamp: opts.noTimestamp === true,
    noVersion: opts.noVersion === true,
  };
  return flavor === "classDiagram"
    ? renderClassDiagram(ir, ctx)
    : renderFlowchart(ir, ctx);
}

interface Ctx {
  labelMax: number;
  version: string;
  noTimestamp: boolean;
  noVersion: boolean;
}

function autoFlavor(ir: IR): MermaidFlavor {
  // Ties break toward `flowchart` (§2).
  return dominantTier(ir) === "type" ? "classDiagram" : "flowchart";
}

// ---------------------------------------------------------------------------
// Flowchart (service / module level) — §2.1
// ---------------------------------------------------------------------------

function renderFlowchart(ir: IR, ctx: Ctx): string {
  const out: string[] = [];
  emitHeader(out, ir, "Mermaid flowchart", ctx);
  out.push("flowchart LR");
  out.push("  classDef pure       fill:#dff5e1,stroke:#3a8,stroke-width:1px");
  out.push("  classDef effectful  fill:#fde7e7,stroke:#a33,stroke-width:1px");
  out.push("  classDef sinkNode   fill:#fff4d1,stroke:#a83,stroke-width:1px");
  out.push("  classDef entryNode  fill:#e0f0ff,stroke:#36a,stroke-width:1px");
  out.push("  classDef leafNode   fill:#f4f4f4,stroke:#888,stroke-width:1px");
  out.push("");

  const { nodes, edges } = sortedForEmission(ir);

  // Build a containment forest: serviceId → moduleId[] → leaves[]. Mermaid
  // supports two levels of subgraph reliably (§2.3); deeper containment is
  // flattened into the function label.
  const byId = new Map<string, IRNode>();
  for (const n of nodes) byId.set(n.id as string, n);

  const childrenOf = new Map<string, IRNode[]>();
  for (const n of nodes) {
    const pid = (n as { parentId?: string }).parentId;
    if (!pid) continue;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid)!.push(n);
  }

  const services = nodes.filter((n) => n.tier === "service");
  const orphans: IRNode[] = [];
  for (const n of nodes) {
    if (n.tier === "service") continue;
    // A node is an "orphan" wrt rendering if its enclosing service is not
    // in the sub-IR. We render those at top level so the diagram still
    // shows them.
    const ancestors = ancestryOf(ir, n.id as string);
    const hasService = ancestors.some((a) => byId.get(a)?.tier === "service");
    if (!hasService) orphans.push(n);
  }

  // 1. Emit service-rooted subgraphs (with module nesting for two levels).
  for (const svc of services) {
    emitFlowchartContainer(out, ir, svc, byId, childrenOf, ctx, /* indent */ "  ");
  }

  // 2. Emit nodes that landed without a service ancestor (e.g. an isolated
  //    sink kept by `--filter category=db-write`). They sit at top level so
  //    edges still resolve.
  for (const n of orphans) {
    if (n.tier === "module" || n.tier === "type") {
      // Render as a single-level subgraph to preserve semantics.
      emitFlowchartContainer(out, ir, n, byId, childrenOf, ctx, /* indent */ "  ");
    } else {
      out.push("  " + flowchartLeafLine(n, ctx));
    }
  }

  out.push("");

  // 3. Emit edges (after every node), grouping parallel edges per §2.3.
  emitFlowchartEdges(out, edges, byId, ctx);

  return out.join("\n") + "\n";
}

/**
 * Emits one container — `service` (subgraph svc_…) or `module` /
 * `type` (subgraph mod_…) — and recurses one level for module nesting.
 * Beyond two levels, function-tier nodes are emitted with their parent
 * type's name appended to the label (§2.1 trailing paragraph).
 */
function emitFlowchartContainer(
  out: string[],
  ir: IR,
  container: IRNode,
  byId: Map<string, IRNode>,
  childrenOf: Map<string, IRNode[]>,
  ctx: Ctx,
  indent: string,
): void {
  const tier = container.tier as string;
  const containerId = mermaidContainerId(container);
  const headerLabel = mermaidContainerLabel(container);
  out.push(`${indent}subgraph ${containerId}["${escapeMermaidLabel(headerLabel)}"]`);

  const directChildren = (childrenOf.get(container.id as string) ?? []).slice();
  // Stable order: by id, since sortedForEmission already sorted.
  directChildren.sort((a, b) => (a.id as string).localeCompare(b.id as string));

  // Module containers nested inside services get their own subgraph.
  const subContainers = directChildren.filter(
    (c) => c.tier === "module" || c.tier === "type",
  );
  const leaves = directChildren.filter(
    (c) => c.tier !== "module" && c.tier !== "type",
  );

  for (const sub of subContainers) {
    if (tier === "service") {
      // service > module — supported nesting.
      emitFlowchartContainer(out, ir, sub, byId, childrenOf, ctx, indent + "  ");
    } else {
      // service > module > type would be three-level — flatten the type's
      // children up into the module by walking down two levels.
      emitFlowchartContainer(out, ir, sub, byId, childrenOf, ctx, indent + "  ");
    }
  }

  for (const leaf of leaves) {
    out.push(indent + "  " + flowchartLeafLine(leaf, ctx));
    // Function-tier nodes can have descendant expressions (literal /
    // env / sink). Render them as siblings with three-tag node shapes.
    const grand = childrenOf.get(leaf.id as string) ?? [];
    for (const g of grand) {
      out.push(indent + "  " + flowchartLeafLine(g, ctx));
    }
  }

  out.push(`${indent}end`);
}

function flowchartLeafLine(node: IRNode, ctx: Ctx): string {
  const id = mermaidLeafId(node);
  const label = mermaidLeafLabel(node, ctx);
  const klass = mermaidNodeClass(node);
  const shaped = wrapLeafShape(node, id, label);
  return klass ? `${shaped}:::${klass}` : shaped;
}

function wrapLeafShape(node: IRNode, id: string, label: string): string {
  const escaped = escapeMermaidLabel(label);
  // Expression-tier flavors get distinct shapes per §2.1.
  if (node.tier === "expression") {
    const ex = node as {
      leaf?: { flavor?: string };
      sink?: { flavor?: string };
    };
    if (ex.sink) {
      return `${id}((("${escaped}")))`;
    }
    if (ex.leaf?.flavor === "literal") {
      return `${id}(["${escaped}"])`;
    }
    if (
      ex.leaf?.flavor === "env" ||
      ex.leaf?.flavor === "http-input" ||
      ex.leaf?.flavor === "config-file" ||
      ex.leaf?.flavor === "cli-arg"
    ) {
      return `${id}{{"${escaped}"}}`;
    }
  }
  // Default: rectangle.
  return `${id}["${escaped}"]`;
}

// ---------------------------------------------------------------------------
// Flowchart edges
// ---------------------------------------------------------------------------

function emitFlowchartEdges(
  out: string[],
  edges: ReadonlyArray<IREdge>,
  byId: Map<string, IRNode>,
  ctx: Ctx,
): void {
  // Per §2.3, parallel edges (same pair, different category) are merged
  // into a single edge with a `|`-separated label.
  type Group = { src: string; tgt: string; entries: IREdge[] };
  const groups = new Map<string, Group>();
  for (const e of edges) {
    const key = `${e.sourceId as string} ${e.targetId as string}`;
    if (!groups.has(key)) {
      groups.set(key, {
        src: e.sourceId as string,
        tgt: e.targetId as string,
        entries: [],
      });
    }
    groups.get(key)!.entries.push(e);
  }

  for (const g of groups.values()) {
    const srcNode = byId.get(g.src);
    const tgtNode = byId.get(g.tgt);
    if (!srcNode || !tgtNode) continue;
    const srcId = mermaidLeafId(srcNode);
    const tgtId = mermaidLeafId(tgtNode);
    const arrow = pickFlowchartArrow(g.entries);
    const label = pickFlowchartLabel(g.entries, ctx);
    out.push(`  ${srcId} ${arrow}${label} ${tgtId}`);
  }
}

function pickFlowchartArrow(entries: ReadonlyArray<IREdge>): string {
  // The "strongest" category wins arrow style if multiple are present,
  // since you can only render one.
  const cats = new Set(entries.map((e) => e.category as string));
  if (cats.has("type-flow")) return "==>";
  if (cats.has("import")) return "-.->";
  if (cats.has("env-read")) return "-..->";
  return "-->";
}

function pickFlowchartLabel(
  entries: ReadonlyArray<IREdge>,
  ctx: Ctx,
): string {
  // For each contributing edge, format `<category>: <displayOrSlug>`.
  const parts: string[] = [];
  for (const e of entries) {
    const cat = e.category as string;
    const slug = formatEdgeSlug(e);
    parts.push(slug ? `${cat}: ${slug}` : cat);
  }
  const merged = parts.join(" | ");
  const truncated = truncate(merged, ctx.labelMax);
  // Mermaid labels: angle brackets and pipes need escaping.
  const safe = mermaidEscapeLabel(truncated);
  return `|"${safe}"|`;
}

/** Compose the visible portion of an edge's label from its category-specific fields. */
function formatEdgeSlug(e: IREdge): string {
  const a = e as Record<string, unknown>;
  const display = (a.valueType as { display?: string } | undefined)?.display;
  switch (e.category as string) {
    case "http-route": {
      const method = (a.method as string | undefined) ?? "";
      return method ? method : (display ?? "");
    }
    case "db-read": {
      const ent = (a.entity as string | undefined) ?? "";
      return ent ? `R: ${ent}` : (display ?? "R");
    }
    case "db-write": {
      const ent = (a.entity as string | undefined) ?? "";
      return ent ? `W: ${ent}` : (display ?? "W");
    }
    case "network": {
      const method = (a.method as string | undefined) ?? "";
      const url = (a.url as string | undefined) ?? "";
      return [method, url].filter(Boolean).join(" ");
    }
    case "import": {
      const sym = (a.specifier as string | undefined) ?? "";
      return sym ? `import ${sym}` : "import";
    }
    case "env-read": {
      const name = (a.name as string | undefined) ?? "";
      return name ? `env ${name}` : "env";
    }
    default:
      return display ?? "";
  }
}

// ---------------------------------------------------------------------------
// Class diagram (type level) — §2.2
// ---------------------------------------------------------------------------

function renderClassDiagram(ir: IR, ctx: Ctx): string {
  const out: string[] = [];
  emitHeader(out, ir, "Mermaid classDiagram", ctx);
  out.push("classDiagram");

  const { nodes, edges } = sortedForEmission(ir);

  // Pull out type-tier nodes; their fields and contained methods become
  // the class body.
  const types = nodes.filter((n) => n.tier === "type");
  const childrenOf = new Map<string, IRNode[]>();
  for (const n of nodes) {
    const pid = (n as { parentId?: string }).parentId;
    if (!pid) continue;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid)!.push(n);
  }

  for (const t of types) {
    const className = classDiagramName(t);
    const stereotype = classDiagramStereotype(t);
    out.push(`  class ${className} {`);
    if (stereotype) out.push(`    ${stereotype}`);

    // Fields (recorded on the type node itself).
    const fields = (t as { fields?: Array<{ name: string; type?: { display?: string }; readonly?: boolean }> }).fields ?? [];
    for (const f of fields) {
      const ty = mermaidEscapeGeneric(f.type?.display ?? "any");
      const ro = f.readonly ? "+~~" : "+";
      out.push(`    ${ro}${f.name}: ${ty}`);
    }

    // Methods: function-tier children of the type node.
    const methods = (childrenOf.get(t.id as string) ?? []).filter(
      (c) => c.tier === "function",
    );
    methods.sort((a, b) => (a.id as string).localeCompare(b.id as string));
    for (const m of methods) {
      const f = m as {
        name?: string;
        params?: Array<{ name: string; type?: { display?: string } }>;
        returnType?: { display?: string };
      };
      const params = (f.params ?? [])
        .map((p) => `${p.name}: ${mermaidEscapeGeneric(p.type?.display ?? "any")}`)
        .join(", ");
      const ret = mermaidEscapeGeneric(f.returnType?.display ?? "void");
      out.push(`    +${f.name ?? "anon"}(${params}) ${ret}`);
    }
    out.push(`  }`);
  }

  out.push("");

  // Relations (filter to type↔type edges; everything else is meaningless
  // in a class diagram).
  const typeIds = new Set(types.map((t) => t.id as string));
  // For methods, treat the parent type as the endpoint.
  const ownerOf = new Map<string, string>();
  for (const n of nodes) {
    const pid = (n as { parentId?: string }).parentId;
    if (pid && typeIds.has(pid)) ownerOf.set(n.id as string, pid);
  }
  for (const t of types) ownerOf.set(t.id as string, t.id as string);

  type Pair = { from: string; to: string; arrow: string; label: string };
  const seenPairs = new Map<string, Pair>();
  for (const e of edges) {
    const fromOwner = ownerOf.get(e.sourceId as string);
    const toOwner = ownerOf.get(e.targetId as string);
    if (!fromOwner || !toOwner) continue;
    if (fromOwner === toOwner) continue;
    const fromName = classDiagramName(byIdFor(types, fromOwner)!);
    const toName = classDiagramName(byIdFor(types, toOwner)!);
    const cat = e.category as string;
    let arrow = "-->";
    if (cat === "import") arrow = "..>";
    if (cat === "type-flow") arrow = "-->";
    const labelDisplay = (e as { valueType?: { display?: string } }).valueType?.display ?? cat;
    const safe = mermaidEscapeGeneric(truncate(labelDisplay, ctx.labelMax));
    const key = `${fromName} ${toName} ${arrow}`;
    if (!seenPairs.has(key)) {
      seenPairs.set(key, {
        from: fromName,
        to: toName,
        arrow,
        label: safe,
      });
    }
  }

  for (const p of seenPairs.values()) {
    out.push(`  ${p.from} ${p.arrow} ${p.to} : ${p.label}`);
  }

  return out.join("\n") + "\n";
}

function classDiagramName(t: IRNode): string {
  const name = (t as { name?: string }).name ?? "Anon";
  // Mermaid class names disallow many chars; keep it strictly identifier-safe.
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function classDiagramStereotype(t: IRNode): string | null {
  const kind = (t as { kind?: string }).kind ?? "";
  if (kind === "interface") return "<<interface>>";
  if (kind === "enum") return "<<enumeration>>";
  if (kind === "trait" || kind === "protocol") return "<<interface>>";
  return null;
}

function byIdFor(arr: ReadonlyArray<IRNode>, id: string): IRNode | undefined {
  for (const n of arr) if ((n.id as string) === id) return n;
  return undefined;
}

// ---------------------------------------------------------------------------
// Headers and identifiers
// ---------------------------------------------------------------------------

function emitHeader(out: string[], ir: IR, kind: string, ctx: Ctx): void {
  const versionTag = ctx.noVersion ? "" : ` ${ctx.version}`;
  out.push(`%% codegraph${versionTag} — ${kind}`);
  const sel = (ir.metadata as { selection?: { roots?: ReadonlyArray<string>; depth?: number | null; filters?: ReadonlyArray<string>; direction?: string; includeParents?: boolean } }).selection;
  if (sel) {
    const flagBits: string[] = [];
    for (const r of sel.roots ?? []) flagBits.push(`--root ${r}`);
    if (sel.depth !== undefined && sel.depth !== null) flagBits.push(`--depth ${sel.depth}`);
    if (sel.direction && sel.direction !== "out") flagBits.push(`--direction ${sel.direction}`);
    for (const f of sel.filters ?? []) flagBits.push(`--filter ${f}`);
    if (sel.includeParents === false) flagBits.push("--no-include-parents");
    if (flagBits.length > 0) {
      out.push(`%% selection: ${flagBits.join(" ")}`);
    }
  }
  if (!ctx.noTimestamp) {
    const ts = (ir.metadata as { selection?: { selectedAt?: string } }).selection?.selectedAt;
    if (ts) out.push(`%% generatedAt: ${ts}`);
  }
}

/**
 * Mermaid container ids: `svc_<8-hex>`, `mod_<8-hex>`, `type_<8-hex>`.
 * The underlying ids in the IR are arbitrary strings; we hash them only
 * if necessary by taking the first 8 chars from the right side of the
 * id (after the last separator) — keeps Mermaid identifier rules happy
 * without depending on a hash function.
 */
function mermaidContainerId(node: IRNode): string {
  const tag =
    node.tier === "service" ? "svc" :
    node.tier === "module"  ? "mod" :
    node.tier === "type"    ? "type" :
    "node";
  return `${tag}_${idShort(node.id as string)}`;
}

function mermaidContainerLabel(node: IRNode): string {
  const name = (node as { name?: string }).name ?? "";
  const path = (node as { path?: string }).path;
  if (node.tier === "service") {
    return path ? `${name} (service · ${path})` : `${name} (service)`;
  }
  if (node.tier === "module") {
    return path ?? name;
  }
  if (node.tier === "type") {
    return name;
  }
  return name || (node.id as string);
}

function mermaidLeafId(node: IRNode): string {
  if (node.tier === "service") return mermaidContainerId(node);
  if (node.tier === "module") return mermaidContainerId(node);
  if (node.tier === "type") return mermaidContainerId(node);
  if (node.tier === "function") return `fn_${idShort(node.id as string)}`;
  if (node.tier === "expression") {
    const ex = node as {
      leaf?: { flavor?: string };
      sink?: { flavor?: string };
    };
    if (ex.sink) return `snk_${idShort(node.id as string)}`;
    if (ex.leaf?.flavor === "literal") return `lit_${idShort(node.id as string)}`;
    if (ex.leaf) return `env_${idShort(node.id as string)}`;
    return `expr_${idShort(node.id as string)}`;
  }
  return `n_${idShort(node.id as string)}`;
}

function mermaidLeafLabel(node: IRNode, _ctx: Ctx): string {
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
          return `exec`;
        case "log":
          return `log`;
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
          return `db-read`;
        default:
          return l.flavor ?? "leaf";
      }
    }
    return (node as { name?: string }).name ?? (node.id as string);
  }
  return (node as { name?: string }).name ?? (node.id as string);
}

function mermaidNodeClass(node: IRNode): string | null {
  if (node.tier === "expression") {
    const ex = node as { sink?: unknown; leaf?: unknown };
    if (ex.sink) return "sinkNode";
    if (ex.leaf) return "leafNode";
    return null;
  }
  if (node.tier === "function") {
    const f = node as { pure?: boolean };
    if (f.pure === true) return "pure";
    if (f.pure === false) return "effectful";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Identifier and label sanitization
// ---------------------------------------------------------------------------

function idShort(id: string): string {
  // BLAKE3 ids are hex; for that case we want the leading 8 hex chars.
  // For arbitrary path-shaped ids we pick the last 8 alnum chars to make
  // identifiers that look like the IR hint while still satisfying the
  // identifier regex `[A-Za-z_][A-Za-z0-9_]*`.
  const hexMatch = /^[0-9a-fA-F]+$/.test(id);
  if (hexMatch) return id.slice(0, 8).padStart(8, "0");
  // Strip everything Mermaid won't accept and fold to alnum.
  const safe = id.replace(/[^A-Za-z0-9]/g, "_");
  // Take last 8 chars but ensure non-digit start.
  const tail = safe.slice(Math.max(0, safe.length - 8));
  return /^[0-9]/.test(tail) ? `n${tail}` : tail || "x";
}

/** Replace `<` / `>` with `~` per §2.3 (Mermaid renders `<` as HTML). */
function mermaidEscapeGeneric(s: string): string {
  return s.replace(/[<>]/g, "~").replace(/[{}]/g, (m) => (m === "{" ? "~" : "~"));
}

/**
 * Escape a string used inside a Mermaid string literal. Used in node
 * labels and edge labels; replaces `"` and angle brackets.
 */
function mermaidEscapeLabel(s: string): string {
  return s.replace(/"/g, "'").replace(/[<>]/g, "~");
}

/** Same as mermaidEscapeLabel but applied to node labels (keeps quotes safe). */
function escapeMermaidLabel(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "'")
    .replace(/[<>]/g, "~")
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
