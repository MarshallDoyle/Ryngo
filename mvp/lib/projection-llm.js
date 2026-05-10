/**
 * Tier-4 LLM projections.
 *
 * Five deterministic functions that convert the canonical IR into formats
 * suited for an LLM consumer. Pure JS — no LLM at runtime, no network. The
 * point is to give an agent a vocabulary smaller than the full IR while
 * preserving stable node ids so its edits round-trip.
 *
 * Public API:
 *   compactJson(ir, opts?)         → minimal IR (drops layout/diff fields)
 *   englishSignature(node)         → "function login that takes ... and returns ..."
 *   topology(ir)                   → bullet-list bird's-eye view (~300 tokens)
 *   slice(ir, rootId, opts?)       → k-hop subgraph + optional annotations
 *   prd(ir, regionId, kind, opts?) → markdown PRD for a named region
 *
 * All functions are stable: same IR + same args → byte-equal output.
 */

// ---------------------------------------------------------------------------
// 1. compactJson
// ---------------------------------------------------------------------------

const COMPACT_NODE_KINDS = new Set([
  "file",
  "function",
  "class",
  "cell",
  "package",
  "http-route",
  "db-model",
  "env",
  "infra-resource",
]);

const COMPACT_EDGE_KINDS = new Set([
  "imports-file",
  "imports-package",
  "calls",
  "defines-route",
  "route-handler",
  "db-read",
  "db-write",
  "env-read",
]);

export function compactJson(ir, opts = {}) {
  const { includeUnused = false, includePackages = true } = opts;
  const nodes = (ir.nodes || [])
    .filter((n) => COMPACT_NODE_KINDS.has(n.kind))
    .filter((n) => includePackages || n.kind !== "package")
    .map((n) => stripNode(n));

  const referenced = new Set();
  if (!includeUnused) {
    for (const n of nodes) referenced.add(n.id);
  }
  const edges = (ir.edges || [])
    .filter((e) => COMPACT_EDGE_KINDS.has(e.kind))
    .filter((e) =>
      includeUnused
        ? true
        : referenced.has(e.source) && referenced.has(e.target),
    )
    .map(stripEdge);

  return {
    repo: ir.repo,
    ref: ir.ref || "HEAD",
    version: 1,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      analyzedFiles: ir.stats?.analyzedFiles ?? null,
    },
    nodes,
    edges,
  };
}

function stripNode(n) {
  const out = { id: n.id, kind: n.kind, label: n.label };
  if (n.parentId) out.parent = n.parentId;
  if (n.source) out.source = n.source;
  if (n.confidence) out.confidence = n.confidence;
  if (n.facts?.length) {
    out.facts = n.facts.slice(0, 6).map((fact) => ({
      kind: fact.kind,
      text: fact.text,
      confidence: fact.confidence || "unknown",
      source: fact.source || null,
    }));
  }
  if (n.data) {
    const d = n.data;
    const compact = {};
    if (d.path) compact.path = d.path;
    if (d.file) compact.file = d.file;
    if (d.line) compact.line = d.line;
    if (d.lang) compact.lang = d.lang;
    if (d.params?.length) compact.params = d.params;
    if (d.returnType) compact.returnType = d.returnType.display || d.returnType;
    if (d.members?.methods?.length) {
      compact.methods = d.members.methods.map((mt) => ({
        name: mt.name,
        params: mt.params || [],
        returnType: mt.returnType?.display || null,
      }));
    }
    if (d.members?.fields?.length) {
      compact.fields = d.members.fields.map((f) => ({
        name: f.name,
        type: f.typeDisplay,
      }));
    }
    if (d.baseClasses?.length) compact.baseClasses = d.baseClasses;
    if (d.method) compact.method = d.method;
    if (d.framework) compact.framework = d.framework;
    if (d.handler) compact.handler = d.handler;
    if (Object.keys(compact).length) out.data = compact;
  }
  if (n.effects?.length) out.effects = [...new Set(n.effects)];
  return out;
}

function stripEdge(e) {
  const out = {
    id: e.id,
    source: e.source,
    target: e.target,
    kind: e.kind,
  };
  if (e.resolution && e.resolution !== "lexical") out.resolution = e.resolution;
  if (e.confidence) out.confidence = e.confidence;
  if (e.provenance) out.provenance = e.provenance;
  if (e.valueType) out.valueType = e.valueType.display || e.valueType;
  if (e.op) out.op = e.op;
  return out;
}

// ---------------------------------------------------------------------------
// 2. englishSignature
// ---------------------------------------------------------------------------

/**
 * Convert a function/method node into a one-sentence prose description:
 *   "asynchronous function `login` that takes an email string and a password
 *    string and returns a user or null."
 *
 * Falls back gracefully on missing types or missing names. Does not invent
 * facts.
 */
export function englishSignature(node) {
  if (!node) return "";
  const data = node.data || {};
  if (node.kind === "class") {
    const base = data.baseClasses?.length
      ? ` extending ${joinList(data.baseClasses.map(quoteName))}`
      : "";
    const methodCount = data.members?.methods?.length || 0;
    const fieldCount = data.members?.fields?.length || 0;
    const memBits = [
      methodCount ? `${methodCount} method${methodCount === 1 ? "" : "s"}` : null,
      fieldCount ? `${fieldCount} field${fieldCount === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    const memStr = memBits.length ? ` with ${joinList(memBits)}` : "";
    return `class \`${node.label}\`${base}${memStr}`;
  }
  if (node.kind !== "function" && node.kind !== "cell") return "";
  if (node.kind === "cell") {
    return `notebook cell \`${node.label}\``;
  }
  const params = data.params || [];
  const paramText = params.length
    ? `that takes ${joinList(params.map(describeParam))}`
    : "with no parameters";
  const returnText = data.returnType
    ? ` and returns ${describeType(
        data.returnType.display || data.returnType,
      )}`
    : "";
  return `function \`${node.label}\` ${paramText}${returnText}`;
}

function describeParam(p) {
  let core = `\`${p.name}\``;
  if (p.typeDisplay) core += `: ${describeType(p.typeDisplay)}`;
  if (p.optional) core += " (optional)";
  if (p.default) core += ` = ${p.default}`;
  if (p.rest) core = "..." + core;
  return core;
}

function describeType(t) {
  if (!t) return "anything";
  return t.replace(/\s+/g, " ").trim();
}

function joinList(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
}

function quoteName(s) {
  return `\`${s}\``;
}

// ---------------------------------------------------------------------------
// 3. topology
// ---------------------------------------------------------------------------

/**
 * Bird's-eye summary as a markdown bullet list. ~300 tokens for a typical
 * mid-sized repo. The LLM uses this when planning, before requesting the
 * detailed slice for a specific node.
 */
export function topology(ir) {
  const nodes = ir.nodes || [];
  const edges = ir.edges || [];
  const stats = ir.stats || {};

  const files = nodes.filter((n) => n.kind === "file");
  const routes = nodes.filter((n) => n.kind === "http-route");
  const models = nodes.filter((n) => n.kind === "db-model");
  const envs = nodes.filter((n) => n.kind === "env");
  const packages = nodes.filter((n) => n.kind === "package");

  const langCounts = new Map();
  for (const f of files) {
    const lang = f.data?.lang || "other";
    langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
  }

  const fileEdge = new Map();
  for (const e of edges) {
    if (e.kind === "imports-file" || e.kind === "calls") {
      bump(fileEdge, e.source);
      bump(fileEdge, e.target);
    }
  }
  const hotspots = [...fileEdge.entries()]
    .filter(([id]) => id.startsWith("file:"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, n]) => ({ file: id.replace(/^file:/, ""), count: n }));

  const topPkgs = packages
    .map((p) => ({
      name: p.label,
      count: edges.filter(
        (e) => e.target === p.id && e.kind === "imports-package",
      ).length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const lines = [];
  lines.push(`# Repo: ${ir.repo} @ ${ir.ref || "HEAD"}`);
  lines.push("");
  lines.push(
    `**Totals:** ${stats.files ?? files.length} files · ${
      stats.analyzedFiles ?? "?"
    } analyzed · ${nodes.filter((n) => n.kind === "function").length} functions · ${
      nodes.filter((n) => n.kind === "class").length
    } classes · ${packages.length} packages.`,
  );
  if (langCounts.size) {
    const langLine = [...langCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    lines.push(`**Languages:** ${langLine}.`);
  }
  if (routes.length) {
    lines.push("");
    lines.push("## HTTP routes");
    for (const r of routes.slice(0, 24)) {
      lines.push(
        `- \`${r.data?.method || ""} ${r.data?.path || r.label}\` (${r.data?.framework || "?"}) → ${
          r.data?.file || ""
        }${r.data?.line ? `:${r.data.line}` : ""}`,
      );
    }
    if (routes.length > 24) lines.push(`- …and ${routes.length - 24} more.`);
  }
  if (models.length) {
    lines.push("");
    lines.push("## Data models");
    for (const m of models.slice(0, 16)) {
      lines.push(`- \`${m.label}\` (${m.data?.fields?.length || 0} fields)`);
    }
    if (models.length > 16) lines.push(`- …and ${models.length - 16} more.`);
  }
  if (envs.length) {
    lines.push("");
    lines.push(
      `## Env reads (${envs.length}): ${envs
        .slice(0, 16)
        .map((e) => `\`${e.label}\``)
        .join(", ")}${envs.length > 16 ? `, …` : ""}`,
    );
  }
  if (topPkgs.length) {
    lines.push("");
    lines.push("## Top external packages");
    for (const p of topPkgs) {
      lines.push(`- \`${p.name}\` (imported by ${p.count} files)`);
    }
  }
  if (hotspots.length) {
    lines.push("");
    lines.push("## Hotspots (most-connected files)");
    for (const h of hotspots) {
      lines.push(`- \`${h.file}\` (${h.count} edges)`);
    }
  }
  return lines.join("\n");
}

function bump(map, k) {
  map.set(k, (map.get(k) || 0) + 1);
}

// ---------------------------------------------------------------------------
// 4. slice
// ---------------------------------------------------------------------------

/**
 * Return the k-hop subgraph around `rootId`. Useful when an LLM needs to
 * understand the local neighborhood of a node it's about to edit.
 *
 * Options:
 *   hops          : default 1
 *   includeKinds  : restrict edge kinds (default all)
 *   includeAnnotations : if true and `annotations` is provided, attach matching
 *                        annotation snippets to the returned object
 */
export function slice(ir, rootId, opts = {}) {
  const { hops = 1, includeKinds, includeAnnotations = false, annotations = "" } = opts;
  const nodeMap = new Map((ir.nodes || []).map((n) => [n.id, n]));
  if (!nodeMap.has(rootId)) {
    return { root: rootId, nodes: [], edges: [], notFound: true };
  }
  const visited = new Set([rootId]);
  let frontier = [rootId];
  const collected = [];
  for (let i = 0; i < hops; i++) {
    const nextFrontier = [];
    for (const e of ir.edges || []) {
      if (includeKinds && !includeKinds.has(e.kind)) continue;
      if (frontier.includes(e.source) && !visited.has(e.target)) {
        visited.add(e.target);
        collected.push(e);
        nextFrontier.push(e.target);
      } else if (frontier.includes(e.target) && !visited.has(e.source)) {
        visited.add(e.source);
        collected.push(e);
        nextFrontier.push(e.source);
      } else if (frontier.includes(e.source) && visited.has(e.target)) {
        if (!collected.includes(e)) collected.push(e);
      } else if (frontier.includes(e.target) && visited.has(e.source)) {
        if (!collected.includes(e)) collected.push(e);
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }
  const nodes = [...visited]
    .map((id) => nodeMap.get(id))
    .filter(Boolean)
    .map(stripNode);
  const edges = collected.map(stripEdge);
  const out = { root: rootId, hops, nodes, edges };
  if (includeAnnotations && annotations) {
    out.annotations = filterAnnotationsToIds(annotations, [...visited]);
  }
  return out;
}

function filterAnnotationsToIds(text, ids) {
  const idSet = new Set(ids);
  const lines = text.split("\n");
  const out = [];
  let keep = false;
  for (const ln of lines) {
    const m = ln.match(/^##\s+node:\s*(\S+)/);
    if (m) keep = idSet.has(m[1]);
    if (keep) out.push(ln);
  }
  return out.join("\n").trim();
}

// ---------------------------------------------------------------------------
// 5. prd — deterministic markdown spec from a region
// ---------------------------------------------------------------------------

/**
 * Generate a markdown PRD describing a named region (subgraph). Pure
 * template — no LLM. The kind argument shapes the PRD into one of
 *   'extract' | 'refactor' | 'delete' | 'tests' | 'rename' | 'overview'.
 *
 * `region` shape: { id, label, nodes: [nodeId] } — usually loaded from
 * `.ryngo/regions.json`.
 */
export function prd(ir, region, kind = "overview", opts = {}) {
  const idSet = new Set(region.nodes || []);
  const nodes = (ir.nodes || []).filter((n) => idSet.has(n.id));
  const edges = (ir.edges || []).filter(
    (e) => idSet.has(e.source) && idSet.has(e.target),
  );
  const externalIn = (ir.edges || []).filter(
    (e) => !idSet.has(e.source) && idSet.has(e.target),
  );
  const externalOut = (ir.edges || []).filter(
    (e) => idSet.has(e.source) && !idSet.has(e.target),
  );
  const fileSet = new Set();
  for (const n of nodes) {
    if (n.data?.file) fileSet.add(n.data.file);
    if (n.kind === "file" && n.data?.path) fileSet.add(n.data.path);
  }

  const title = opts.title || `${capitalize(kind)} ${region.label || region.id}`;
  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(
    `> Generated by Ryngo from region \`${region.id}\`. ${nodes.length} nodes, ${edges.length} internal edges, ${externalIn.length} inbound, ${externalOut.length} outbound.`,
  );
  lines.push("");
  lines.push("## Files in scope");
  for (const f of [...fileSet].sort()) lines.push(`- \`${f}\``);
  lines.push("");
  lines.push("## Nodes");
  for (const n of nodes) {
    const sig = englishSignature(n);
    const file = n.data?.file ? ` (${n.data.file}${n.data?.line ? `:${n.data.line}` : ""})` : "";
    lines.push(`- \`${n.id}\` — ${n.kind}${sig ? `: ${sig}` : ""}${file}`);
  }
  lines.push("");
  lines.push("## External callers (inbound)");
  if (externalIn.length === 0) {
    lines.push("_none — this region is a leaf, nothing depends on it._");
  } else {
    for (const e of externalIn.slice(0, 24)) {
      lines.push(`- \`${e.source}\` —[${e.kind}]→ \`${e.target}\``);
    }
    if (externalIn.length > 24)
      lines.push(`- …and ${externalIn.length - 24} more.`);
  }
  lines.push("");
  lines.push("## External callees (outbound)");
  if (externalOut.length === 0) {
    lines.push("_none — this region calls only itself._");
  } else {
    for (const e of externalOut.slice(0, 24)) {
      lines.push(`- \`${e.source}\` —[${e.kind}]→ \`${e.target}\``);
    }
    if (externalOut.length > 24)
      lines.push(`- …and ${externalOut.length - 24} more.`);
  }
  lines.push("");
  lines.push("## Acceptance check (Ryngo re-analyses after the AI applies the change)");
  for (const line of acceptanceFor(kind, region, nodes)) {
    lines.push(`- [ ] ${line}`);
  }
  return lines.join("\n");
}

function acceptanceFor(kind, region, nodes) {
  switch (kind) {
    case "delete":
      return [
        `every node in region \`${region.id}\` no longer appears in the IR`,
        "no edge in the IR references any of those node ids",
      ];
    case "extract":
      return [
        `the listed nodes are relocated under a new top-level boundary`,
        "external callers (inbound edges above) still resolve to the new location",
        "no new edge crosses architectural rules in `.ryngo/rules.md`",
      ];
    case "refactor":
      return [
        "the listed nodes still exist (same ids), but their internal edges may have changed",
        "any signature change is intentional and matches the rationale below",
      ];
    case "tests":
      return [
        "every function/class node in this region has at least one inbound `calls` edge from a test file",
      ];
    case "rename":
      return [
        "the old node ids are gone from the IR; the new ids are present",
        "no caller still references the old name (`name-match` resolution count drops to zero)",
      ];
    default:
      return [
        "no acceptance criteria for this overview-only PRD; capture them in your intent file",
      ];
  }
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
