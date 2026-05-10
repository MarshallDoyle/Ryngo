/**
 * Plinth MVP — IR diff.
 *
 * Given two IRs (the same repo at two refs) produce a single combined IR
 * where every node and every edge carries a `_diff` flag:
 *
 *   added      — present in head, not in base
 *   removed    — present in base, not in head
 *   unchanged  — present in both (matched on stable id)
 *
 * Identity is the existing id scheme:
 *   - file:<path>            stable while the path is unchanged
 *   - def:<path>#<name>      stable while file path + symbol name unchanged
 *   - cell:<path>#<index>    stable per cell index. Inserting a cell shifts
 *                            indices, which surfaces as remove+add — accept
 *                            this limitation for the MVP
 *   - pkg:<name>             stable
 *
 * The combined IR is rendered the same way as a single-ref IR; the viewer
 * adds visual treatment (saturated for added, desaturated for removed)
 * based on `_diff`.
 */

export function diffIRs(baseIR, headIR) {
  const baseNodeIds = new Set(baseIR.nodes.map((n) => n.id));
  const headNodeIds = new Set(headIR.nodes.map((n) => n.id));
  const baseEdgeIds = new Set(baseIR.edges.map((e) => e.id));
  const headEdgeIds = new Set(headIR.edges.map((e) => e.id));

  const nodes = [];
  // Walk head first so the head IR's parent containers come before any
  // base-only children that hang off them. (Removed defs need their file
  // node to also exist; if the file was removed entirely it'll come from
  // the base-only loop below alongside its children.)
  for (const n of headIR.nodes) {
    nodes.push({
      ...n,
      _diff: baseNodeIds.has(n.id) ? "unchanged" : "added",
    });
  }
  for (const n of baseIR.nodes) {
    if (!headNodeIds.has(n.id)) {
      nodes.push({ ...n, _diff: "removed" });
    }
  }

  const edges = [];
  for (const e of headIR.edges) {
    edges.push({
      ...e,
      _diff: baseEdgeIds.has(e.id) ? "unchanged" : "added",
    });
  }
  for (const e of baseIR.edges) {
    if (!headEdgeIds.has(e.id)) {
      edges.push({ ...e, _diff: "removed" });
    }
  }

  // Counts by status — useful for a "12 added, 3 removed" banner.
  const counts = {
    nodes: { added: 0, removed: 0, unchanged: 0 },
    edges: { added: 0, removed: 0, unchanged: 0 },
  };
  for (const n of nodes) counts.nodes[n._diff]++;
  for (const e of edges) counts.edges[e._diff]++;

  // Per-kind tallies so the banner can surface "+5 functions, -1 class".
  const byKind = {};
  for (const n of nodes) {
    if (n._diff === "unchanged") continue;
    if (!byKind[n.kind]) byKind[n.kind] = { added: 0, removed: 0 };
    byKind[n.kind][n._diff]++;
  }

  return {
    repo: headIR.repo,
    nodes,
    edges,
    diff: {
      base: { ref: baseIR.ref || "base", stats: baseIR.stats },
      head: { ref: headIR.ref || "head", stats: headIR.stats },
      counts,
      byKind,
    },
    stats: {
      // Combined stats — a count of *all* visible items, not just the
      // head's. Lets the viewer's existing banner keep working.
      files: nodes.filter((n) => n.kind === "file").length,
      analyzedFiles:
        Math.max(
          baseIR.stats?.analyzedFiles || 0,
          headIR.stats?.analyzedFiles || 0,
        ),
      definitions: nodes.filter(
        (n) => n.kind === "function" || n.kind === "class",
      ).length,
      cells: nodes.filter((n) => n.kind === "cell").length,
      packages: nodes.filter((n) => n.kind === "package").length,
      edges: edges.length,
      callEdges: edges.filter((e) => e.kind === "calls").length,
      truncated: !!(headIR.stats?.truncated || baseIR.stats?.truncated),
    },
  };
}
