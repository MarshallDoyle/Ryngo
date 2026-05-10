/**
 * Top-level renderer. Composes the section files in `./sections/` and
 * applies the truncation strategy from `design/pr-comment.md` §7.
 *
 * Every section is a pure `(input) => string` function defined in its own
 * file under `./sections/` so a teammate can rewrite a single section
 * without touching the rest. `renderPRComment` here is just orchestration:
 * pick which sections fire (the decision table in §11b), assemble, then
 * truncate from the bottom if we breach the 10 KB soft cap.
 */

import type { GraphDiff } from "../diff/types.js";

import { renderHeader } from "./sections/header.js";
import { renderSummary } from "./sections/summary.js";
import { renderHighSeverity, type HighSeverityItem } from "./sections/high-severity.js";
import { renderArchitectural, type ArchRow } from "./sections/architectural.js";
import { renderTypeChanges, type TypeRow } from "./sections/type-changes.js";
import {
  renderFullBreakdown,
  type BreakdownInput,
  truncateBreakdown,
} from "./sections/full-breakdown.js";
import { renderFooter } from "./sections/footer.js";

// =============================================================================
// Public types
// =============================================================================

/**
 * Sticky-comment marker. Lives at the very top of every rendered comment.
 * The Action greps for this exact string when deciding whether to PATCH an
 * existing comment vs. POST a new one (`design/pr-comment.md` §5).
 *
 * The version suffix is intentional — if we ever need to invalidate old
 * comments (e.g. format incompatible across major), we bump it and the
 * Action posts a new comment instead of editing the v1 one.
 */
export const COMMENT_MARKER = "<!-- codegraph:comment:v1 -->";

/** Soft cap (`design/pr-comment.md` §2) — start truncating at this size. */
const SOFT_CAP_BYTES = 10 * 1024;

/** Hard cap — refuse to emit anything larger; final fallback collapses. */
const HARD_CAP_BYTES = 65 * 1024;

export type CommentMode = "always" | "on-change" | "never";

export type SeverityLabel = "trivial" | "low" | "medium" | "high" | "critical";

/**
 * Optional bag of PR-context metadata. None of these fields are present on
 * a `GraphDiff` (the diff engine doesn't know about the PR — it knows
 * about commits and graphs), so the caller — the Action or the CLI — must
 * supply them. Every field has a sensible fallback so unit tests can call
 * the renderer with just a `GraphDiff` and still get a structured comment.
 */
export interface PRMeta {
  /** Human-readable PR title. Falls back to `"<base_short>…<head_short>"`. */
  title?: string;
  /** Number of base SHA chars to render. Default 7 (Git's default). */
  shaShortLength?: number;
}

export interface RenderOptions {
  /**
   * URL of the hosted viewer for this diff. When absent, all "view in
   * viewer" links collapse to plain text per §12 ("Viewer URL not
   * configured" edge case).
   */
  viewerUrl?: string;

  /**
   * `"always"` — always emit a comment, even on empty diffs.
   * `"on-change"` — emit only if the diff has at least one bucket non-empty.
   * `"never"` — return the empty string. Caller is expected to skip posting.
   *
   * The Action passes through `comment:` from the workflow input; the CLI
   * defaults to `"always"`.
   */
  commentMode: CommentMode;

  /** PR-context metadata not derivable from the diff. See `PRMeta`. */
  pr?: PRMeta;
}

// =============================================================================
// Public entry point
// =============================================================================

/**
 * Render a `GraphDiff` to the sticky PR-comment markdown.
 *
 * Returns the empty string when `commentMode === "never"`, or when
 * `commentMode === "on-change"` and the diff carries no changes.
 */
export function renderPRComment(diff: GraphDiff, opts: RenderOptions): string {
  if (opts.commentMode === "never") return "";

  const empty = isEmptyDiff(diff);
  if (opts.commentMode === "on-change" && empty) return "";

  const { score, label } = computeSeverity(diff);
  const counts = countsForSummary(diff);
  const servicesTouched = collectServicesTouched(diff);

  const baseShort = shortenSha(diff.base.commit, opts.pr?.shaShortLength ?? 7);
  const headShort = shortenSha(diff.head.commit, opts.pr?.shaShortLength ?? 7);
  const title = opts.pr?.title ?? `${baseShort}…${headShort}`;

  // Section assembly. Every helper returns the empty string when the
  // section is conditionally skipped (decision table in §11b).
  const parts: string[] = [];

  parts.push(
    renderHeader({
      marker: COMMENT_MARKER,
      title,
      baseShort,
      headShort,
      severityScore: score,
      severityLabel: label,
      viewerUrl: opts.viewerUrl,
    }),
  );

  parts.push(
    renderSummary({
      counts,
      servicesTouched,
      empty,
    }),
  );

  if (empty) {
    parts.push(renderFooter({ viewerUrl: opts.viewerUrl }));
    return joinSections(parts);
  }

  const highSev = collectHighSeverity(diff);
  parts.push(renderHighSeverity({ items: highSev, viewerUrl: opts.viewerUrl }));

  const archRows = collectArchitectural(diff);
  parts.push(renderArchitectural({ rows: archRows }));

  const typeRows = collectTypeChanges(diff);
  parts.push(renderTypeChanges({ rows: typeRows }));

  const breakdown = collectBreakdown(diff);
  parts.push(renderFullBreakdown(breakdown));

  parts.push(renderFooter({ viewerUrl: opts.viewerUrl }));

  let out = joinSections(parts);

  // §7 truncation. The breakdown is always last before the footer, so we
  // can shave it down without touching the high-severity / architectural /
  // type-changes sections. We never trim sections 1–3.
  if (byteLen(out) > SOFT_CAP_BYTES) {
    const truncated = truncateBreakdown(breakdown, opts.viewerUrl);
    parts[parts.length - 2] = renderFullBreakdown(truncated);
    out = joinSections(parts);
  }

  if (byteLen(out) > HARD_CAP_BYTES) {
    // Final fallback (§12). Replace the breakdown with a single link.
    parts[parts.length - 2] = renderFullBreakdownFallback(breakdown, opts.viewerUrl);
    out = joinSections(parts);
  }

  return out;
}

// =============================================================================
// Severity (per `design/pr-comment.md` §4 — distinct from diff-algorithm §6)
// =============================================================================

interface ScoredHigh {
  score: number;
  // Component scores feed both the comment-level severity and the
  // high-severity bullet list. Same source of truth.
}

/**
 * Compute the comment's 0-100 severity score and label per §4 of
 * `design/pr-comment.md`. The score is `max(component_scores)` — one
 * critical change isn't averaged away by a long tail of low ones.
 *
 * The diff-algorithm engine has its own severity rubric (`severity.ts` in
 * the diff package) used to *order* `topItems`. The comment renderer's
 * rubric is intentionally different and lives here, scoped to comment
 * presentation. Mixing the two would couple presentation to a buckets
 * choice that the comment design says is per-component, not per-bucket.
 */
function computeSeverity(diff: GraphDiff): { score: number; label: SeverityLabel } {
  let max = 0;

  // Adds: pick the largest from the rubric.
  for (const e of diff.addedEdges) {
    if (e.edge.category === "http-route") {
      // §4 component rubric: "Added route with auth-edge present" 55,
      // "Added route with no auth-edge" 90. We don't carry auth-edge
      // analysis on the bare GraphDiff yet (`design/diff-algorithm.md`
      // §6 lists this as a comment-time consideration, not an IR-time
      // one), so default to the conservative "no auth-edge" branch
      // when the route has no `auth` tag. This will tighten when the
      // adapter layer starts emitting auth tags.
      max = Math.max(max, hasAuthTag(e.edge) ? 55 : 90);
    } else if (e.edge.category === "db-write") {
      max = Math.max(max, 45);
    } else if (e.edge.category === "db-read") {
      max = Math.max(max, 30);
    } else if (e.edge.category === "network") {
      max = Math.max(max, 50);
    } else if (e.edge.category === "exec" || e.edge.category === "fs-write") {
      max = Math.max(max, 40);
    } else if (e.edge.category === "call") {
      // Cross-service call to an unlinked service: 75. Same-service: 5.
      // We can't tell without service-id resolution from the diff alone,
      // so leave at 10 ("calls only same-service module").
      max = Math.max(max, 10);
    }

    // Untyped edge into a critical path: §4 says 85 (or 95 if the
    // target is in auth/payment). We approximate "untyped" as
    // `valueType?.display === "unknown"` and "critical path" as the
    // target carrying `critical` / `auth` / `payment` in `tags`.
    if (e.edge.valueType?.display === "unknown") {
      const target = findNode(diff, e.edge.targetId);
      if (target?.tags?.some((t) => t === "auth" || t === "payment")) {
        max = Math.max(max, 95);
      } else if (target?.tags?.some((t) => t === "critical")) {
        max = Math.max(max, 85);
      }
    }
  }

  // New service-tier nodes are architectural; the new-service event
  // doesn't have a direct row in §4's rubric but is implicitly the
  // strongest possible "added module" category. We treat it as 75 (new
  // cross-service edge to a previously unlinked service is the closest
  // numbered analog).
  for (const n of diff.addedNodes) {
    if (n.node.tier === "service") max = Math.max(max, 75);
  }

  // Dead code (§4): "New dead-code region (>= 1 reachable-from-entry node
  // became unreachable) — 40". Approximation: any removed function with
  // remaining incoming references would not be a "dead code region", but
  // the diff already places those in `removedNodes` (their id is gone),
  // so we score every removed function with no replacement at +40 only
  // when there is a corresponding rename hint that *was not* taken. To
  // stay conservative we score plain function removes at 40 only when
  // the diff itself flagged it via a rename hint, which means the
  // upstream function *did* leave a dangling reference shape.
  for (const hint of diff.renameHints) {
    if (hint.confidence === "medium") {
      max = Math.max(max, 40);
    }
  }

  return { score: max, label: labelFor(max) };
}

function labelFor(score: number): SeverityLabel {
  if (score >= 85) return "critical";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  if (score >= 10) return "low";
  return "trivial";
}

// =============================================================================
// Section data collectors
// =============================================================================

function isEmptyDiff(diff: GraphDiff): boolean {
  return (
    diff.addedNodes.length === 0 &&
    diff.removedNodes.length === 0 &&
    diff.changedNodes.length === 0 &&
    diff.addedEdges.length === 0 &&
    diff.removedEdges.length === 0 &&
    diff.changedEdges.length === 0
  );
}

interface SummaryCounts {
  nodesAdded: number;
  nodesRemoved: number;
  nodesChanged: number;
  edgesAdded: number;
  edgesRemoved: number;
  edgesChanged: number;
}

function countsForSummary(diff: GraphDiff): SummaryCounts {
  return {
    nodesAdded: diff.addedNodes.length,
    nodesRemoved: diff.removedNodes.length,
    nodesChanged: diff.changedNodes.length,
    edgesAdded: diff.addedEdges.length,
    edgesRemoved: diff.removedEdges.length,
    edgesChanged: diff.changedEdges.length,
  };
}

/**
 * Walk the diff and return the union of *service tier* names that appear
 * on either side of any added/removed/changed record. The summary table
 * surfaces this as "services touched". Sorted alphabetically.
 *
 * Resolution: a node's containing service is found by walking up parent
 * pointers until tier === "service". We do that lookup on the head side
 * first, then base for removed-only ids; this picks up new services and
 * doesn't misattribute a removed node to a vanished parent.
 */
function collectServicesTouched(diff: GraphDiff): string[] {
  const services = new Set<string>();
  const all: Array<{ id: string; node: { tier: string; name?: string; parentId?: string } }> = [];

  for (const a of diff.addedNodes) all.push({ id: a.id, node: a.node });
  for (const r of diff.removedNodes) all.push({ id: r.id, node: r.node });
  for (const c of diff.changedNodes) {
    // Look up either side; for changed, the node still exists in head.
    const n = findNode(diff, c.id);
    if (n) all.push({ id: c.id, node: n });
  }

  for (const item of all) {
    const svc = resolveServiceName(diff, item.id);
    if (svc) services.add(svc);
  }

  return [...services].sort();
}

/**
 * Walk parent pointers up the tree to find the containing service node.
 * Tries head first (where most live nodes are) then base (for removed).
 */
function resolveServiceName(diff: GraphDiff, id: string): string | null {
  // First: is the id itself a service?
  for (const a of diff.addedNodes) {
    if (a.id === id && a.node.tier === "service") return a.node.name ?? null;
  }
  for (const r of diff.removedNodes) {
    if (r.id === id && r.node.tier === "service") return r.node.name ?? null;
  }
  // Otherwise walk parents. We don't have the full IR here, only the
  // diff records — so we walk the parent graph as represented in the
  // diff's added/removed/changed sets. This is sufficient when a PR
  // actually touches the service node (architectural change), and a
  // single fallback "(unknown)" otherwise.
  const visited = new Set<string>();
  let cur: string | undefined = id;
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const n = findNode(diff, cur);
    if (!n) return null;
    if (n.tier === "service") return n.name ?? null;
    cur = n.parentId as string | undefined;
  }
  return null;
}

function findNode(
  diff: GraphDiff,
  id: string,
): { tier: string; name?: string; parentId?: string; tags?: string[] } | null {
  for (const a of diff.addedNodes) if (a.id === id) return a.node;
  for (const r of diff.removedNodes) if (r.id === id) return r.node;
  // changedNodes only carry an id, not the node body, so we can't recover
  // tier here without the IR. Caller falls back to null.
  return null;
}

function hasAuthTag(edge: { tags?: string[] }): boolean {
  return edge.tags?.includes("auth") ?? false;
}

/**
 * Build the high-severity bullets per §3. Cap at 5. Items are ordered by
 * `summary.topItems` (the diff engine's severity ranking), which is
 * already sorted descending. We only surface items the comment design
 * recognizes as high-severity (§4 rubric).
 */
function collectHighSeverity(diff: GraphDiff): HighSeverityItem[] {
  const out: HighSeverityItem[] = [];

  // Walk topItems in the order the diff engine sorted them so the
  // headline bullet is the headliner.
  for (const item of diff.summary.topItems) {
    if (out.length >= 5) break;
    const bullet = describeTopItem(item, diff);
    if (bullet) out.push(bullet);
  }

  // Fallback: if topItems didn't carry the right kind of info but we
  // have, e.g., new services (architectural high-sev), surface them.
  if (out.length === 0) {
    for (const a of diff.addedNodes) {
      if (out.length >= 5) break;
      if (a.node.tier === "service" && a.node.name) {
        out.push({
          kind: "new service",
          description: `\`${a.node.name}\` introduced`,
          locationLabel: a.node.name,
          locationHref: viewerNodeHref(a.id),
        });
      }
    }
  }

  return out;
}

/**
 * Translate a `ScoredItem` from the diff engine into a high-severity
 * bullet. Returns null if the item doesn't meet the comment's bar.
 *
 * The bar: severity bucket >= "high" OR a category we've manually
 * promoted (new sinks, new routes, untyped edges into critical paths).
 * Diff-engine severity buckets are coarser than the comment's score, so
 * we re-check the underlying record where we can.
 */
function describeTopItem(
  item: { ref: string; score: number; severity: string },
  diff: GraphDiff,
): HighSeverityItem | null {
  // ref form is "node:<id>" or "edge:<key>" per diff types.
  if (item.ref.startsWith("edge:")) {
    const key = item.ref.slice("edge:".length);
    const added = diff.addedEdges.find((e) => e.key === key);
    if (added) return describeAddedEdge(added);
    const changed = diff.changedEdges.find((e) => e.key === key);
    if (changed) return describeChangedEdge(changed);
    return null;
  }
  if (item.ref.startsWith("node:")) {
    const id = item.ref.slice("node:".length);
    const added = diff.addedNodes.find((n) => n.id === id);
    if (added) return describeAddedNode(added);
    return null;
  }
  return null;
}

function describeAddedEdge(e: { key: string; edge: { category: string; valueType?: { display: string }; tags?: string[]; targetId: string } }): HighSeverityItem | null {
  const cat = e.edge.category;
  if (cat === "http-route") {
    const auth = hasAuthTag(e.edge);
    return {
      kind: "new public route",
      description: auth
        ? "route exposed, auth edge present"
        : "route exposed, no auth edge detected",
      locationLabel: e.edge.targetId,
      locationHref: viewerEdgeHref(e.key),
    };
  }
  if (cat === "db-write") {
    return {
      kind: "new DB sink",
      description: "writes to a database table",
      locationLabel: e.edge.targetId,
      locationHref: viewerEdgeHref(e.key),
    };
  }
  if (cat === "network") {
    return {
      kind: "new network sink",
      description: "outbound network call",
      locationLabel: e.edge.targetId,
      locationHref: viewerEdgeHref(e.key),
    };
  }
  if (cat === "exec") {
    return {
      kind: "new exec sink",
      description: "process exec sink",
      locationLabel: e.edge.targetId,
      locationHref: viewerEdgeHref(e.key),
    };
  }
  if (cat === "call" && e.edge.valueType?.display === "unknown") {
    return {
      kind: "untyped edge",
      description: "edge carries `unknown` (request body not validated)",
      locationLabel: e.edge.targetId,
      locationHref: viewerEdgeHref(e.key),
    };
  }
  return null;
}

function describeChangedEdge(
  e: { key: string; before: { display?: string } | null; after: { display?: string } | null },
): HighSeverityItem {
  return {
    kind: "edge type changed",
    description: `value type changed from \`${e.before?.display ?? "—"}\` to \`${e.after?.display ?? "—"}\``,
    locationLabel: e.key.split("|")[1] ?? e.key,
    locationHref: viewerEdgeHref(e.key),
  };
}

function describeAddedNode(n: { id: string; node: { tier: string; name?: string } }): HighSeverityItem | null {
  if (n.node.tier === "service") {
    return {
      kind: "new service",
      description: `\`${n.node.name ?? n.id}\` introduced`,
      locationLabel: n.node.name ?? n.id,
      locationHref: viewerNodeHref(n.id),
    };
  }
  return null;
}

function viewerNodeHref(id: string): string {
  return `#node=${id}`;
}

function viewerEdgeHref(key: string): string {
  return `#edge=${key}`;
}

// ---------------------------------------------------------------------------

function collectArchitectural(diff: GraphDiff): ArchRow[] {
  const rows: ArchRow[] = [];

  for (const a of diff.addedNodes) {
    if (a.node.tier === "service" || a.node.tier === "module") {
      rows.push({
        change: "added",
        kind: a.node.tier,
        name: a.node.name ?? a.id,
        scope: scopeOf(diff, a.id),
      });
    }
  }
  for (const r of diff.removedNodes) {
    if (r.node.tier === "service" || r.node.tier === "module") {
      rows.push({
        change: "removed",
        kind: r.node.tier,
        name: r.node.name ?? r.id,
        scope: scopeOf(diff, r.id),
      });
    }
  }
  // Routes appear as added/removed http-route edges; we surface the
  // route literal (target node) as the architectural "name".
  for (const e of diff.addedEdges) {
    if (e.edge.category === "http-route") {
      rows.push({
        change: "added",
        kind: "route",
        name: routeNameOf(e.edge),
        scope: scopeOf(diff, e.edge.targetId) ?? "",
      });
    }
  }
  for (const e of diff.removedEdges) {
    if (e.edge.category === "http-route") {
      rows.push({
        change: "removed",
        kind: "route",
        name: routeNameOf(e.edge),
        scope: scopeOf(diff, e.edge.targetId) ?? "",
      });
    }
  }
  // Changed modules: a module-tier node with a non-empty edgeDelta or
  // any field change.
  for (const c of diff.changedNodes) {
    const n = findNode(diff, c.id);
    if (n && n.tier === "module") {
      rows.push({
        change: "changed",
        kind: "module",
        name: n.name ?? c.id,
        scope: scopeOf(diff, c.id) ?? "",
      });
    }
  }

  // Stable sort: change asc, kind asc, name asc.
  rows.sort((a, b) => {
    return cmp(a.change, b.change) || cmp(a.kind, b.kind) || cmp(a.name, b.name);
  });

  return rows;
}

function routeNameOf(edge: { category: string; method?: string; targetId: string; valueType?: { display: string } }): string {
  // The literal route path lives on the target expression node's
  // `valueType.display` or in the edge's `valueType`. Without IR
  // visibility we fall back to the targetId — adequate for breakdown
  // purposes; the action layer can post-process for nicer names.
  const method = edge.method ?? "ANY";
  const path = edge.valueType?.display ?? edge.targetId;
  return `${method} ${path}`;
}

function scopeOf(diff: GraphDiff, id: string): string {
  const n = findNode(diff, id);
  if (!n) return "";
  if (n.tier === "service") return "repo";
  // For module tiers we want the service name. resolveServiceName walks
  // parents — same logic.
  return resolveServiceName(diff, id) ?? "";
}

// ---------------------------------------------------------------------------

function collectTypeChanges(diff: GraphDiff): TypeRow[] {
  const rows: TypeRow[] = [];

  for (const c of diff.changedEdges) {
    rows.push({
      edge: edgeDisplay(c.key),
      before: c.before?.display ?? "—",
      after: c.after?.display ?? "—",
    });
  }
  // Per §8: cap at 20.
  return rows.slice(0, 20);
}

function edgeDisplay(key: string): string {
  // EdgeKey form: "<sourceId>|<targetId>|<category>|<attrsHash>"
  const parts = key.split("|");
  if (parts.length >= 2) return `${parts[0]} → ${parts[1]}`;
  return key;
}

// ---------------------------------------------------------------------------

function collectBreakdown(diff: GraphDiff): BreakdownInput {
  return {
    added: diff.addedNodes.map((a) => ({
      path: a.node.tier === "service" || a.node.tier === "module" ? pathOfNode(a.node) : pathOfParent(diff, a.id),
      symbol: a.node.name ?? a.id,
      kind: kindLabel(a.node),
    })),
    removed: diff.removedNodes.map((r) => ({
      path: r.node.tier === "service" || r.node.tier === "module" ? pathOfNode(r.node) : pathOfParent(diff, r.id),
      symbol: r.node.name ?? r.id,
      kind: kindLabel(r.node),
    })),
    changed: diff.changedNodes.map((c) => {
      const n = findNode(diff, c.id);
      return {
        path: n ? (n.tier === "service" || n.tier === "module" ? pathOfNode(n) : pathOfParent(diff, c.id)) : "",
        symbol: n?.name ?? c.id,
        summary: summarizeChangedFields(c.fields, c.edgeDelta),
      };
    }),
  };
}

function pathOfNode(n: { tier: string; path?: string }): string {
  return (n as { path?: string }).path ?? "";
}

function pathOfParent(diff: GraphDiff, id: string): string {
  const n = findNode(diff, id);
  if (!n?.parentId) return "";
  const parent = findNode(diff, n.parentId);
  if (!parent) return "";
  return (parent as { path?: string }).path ?? "";
}

function kindLabel(n: { tier: string; kind?: string; sink?: { flavor: string }; leaf?: { flavor: string } }): string {
  // Map IR tier + role to the §6a vocabulary.
  if (n.tier === "service") return "service";
  if (n.tier === "module") return "module";
  if (n.tier === "type") return "type";
  if (n.tier === "function") {
    return (n as { kind?: string }).kind === "component" ? "component" : "function";
  }
  if (n.tier === "expression") {
    if (n.sink?.flavor === "db-write") return "db-write";
    if (n.sink?.flavor === "network") return "network-sink";
    if (n.sink?.flavor === "fs") return "fs-sink";
    if (n.sink?.flavor === "exec") return "exec";
    if (n.leaf?.flavor === "env") return "env-source";
    if (n.leaf?.flavor === "db-read") return "db-read";
    return "expression";
  }
  return n.tier;
}

function summarizeChangedFields(
  fields: Array<{ field: string; before: unknown; after: unknown }>,
  edgeDelta: { added: number; removed: number; changed: number },
): string {
  const parts: string[] = [];
  for (const f of fields) {
    parts.push(`${f.field}: \`${stringifyShallow(f.before)}\` → \`${stringifyShallow(f.after)}\``);
  }
  if (edgeDelta.added || edgeDelta.removed || edgeDelta.changed) {
    const ed: string[] = [];
    if (edgeDelta.added) ed.push(`+${edgeDelta.added} edges`);
    if (edgeDelta.removed) ed.push(`-${edgeDelta.removed} edges`);
    if (edgeDelta.changed) ed.push(`~${edgeDelta.changed} edges`);
    parts.push(ed.join(", "));
  }
  return parts.join("; ") || "neighborhood shifted";
}

function stringifyShallow(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function renderFullBreakdownFallback(b: BreakdownInput, viewerUrl: string | undefined): string {
  const total = b.added.length + b.removed.length + b.changed.length;
  const link = viewerUrl ? `[view in viewer](${viewerUrl})` : "view in viewer";
  return [
    "<details>",
    `<summary>Full breakdown (${total} changes)</summary>`,
    "",
    `${total} changes — ${link}`,
    "",
    "</details>",
  ].join("\n");
}

// =============================================================================
// Misc helpers
// =============================================================================

function shortenSha(sha: string, len: number): string {
  return sha.slice(0, len);
}

function joinSections(parts: string[]): string {
  // Each section already trims its own surrounding whitespace; we glue
  // them with a blank line so GitHub renders block-level boundaries.
  // Drop empty ("") sections so we don't emit triple blank lines.
  return parts.filter((p) => p.length > 0).join("\n\n") + "\n";
}

function byteLen(s: string): number {
  // GitHub's 65 KB cap is bytes, not chars. UTF-8 length is what we need.
  return Buffer.byteLength(s, "utf8");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Acknowledgement: `ScoredHigh` is reserved for a follow-up that surfaces
// per-bullet score chips in the comment. Keeping the type in source so the
// extension lands without a shape churn.
export type { ScoredHigh };
