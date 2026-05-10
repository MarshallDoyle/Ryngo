/**
 * Auto-narrative for a diff IR — a small paragraph rendered above the
 * graph when in compare mode. Feature #15 in the roadmap. Deterministic,
 * no LLM at runtime: same diff → same sentence.
 *
 * The output is intentionally short (≤ 3 sentences) and concrete: counts
 * by kind, the file with the most affected nodes, and any new/removed
 * external packages. PMs read it in 5 seconds.
 *
 * Returns "" when the IR is not a diff IR.
 */
export function diffNarrative(ir) {
  if (!ir?.diff) return "";

  const a = ir.diff.counts.nodes.added;
  const r = ir.diff.counts.nodes.removed;
  const ae = ir.diff.counts.edges.added;
  const re = ir.diff.counts.edges.removed;

  if (a === 0 && r === 0 && ae === 0 && re === 0) {
    return "No structural changes between these refs.";
  }

  const parts = [];

  // Sentence 1: top-line counts.
  const baseRef = ir.diff.base?.ref || "base";
  const headRef = ir.diff.head?.ref || "head";
  if (a > 0 && r > 0) {
    parts.push(
      `Going from \`${baseRef}\` → \`${headRef}\` adds ${a} structural element${a === 1 ? "" : "s"} and removes ${r}.`,
    );
  } else if (a > 0) {
    parts.push(
      `Going from \`${baseRef}\` → \`${headRef}\` adds ${a} structural element${a === 1 ? "" : "s"}.`,
    );
  } else if (r > 0) {
    parts.push(
      `Going from \`${baseRef}\` → \`${headRef}\` removes ${r} structural element${r === 1 ? "" : "s"}.`,
    );
  }

  // Sentence 2: kind breakdown for kinds with ≥ 2 changes.
  const byKind = ir.diff.byKind || {};
  const significant = Object.entries(byKind)
    .filter(([, c]) => (c.added || 0) + (c.removed || 0) >= 2)
    .sort(
      (a, b) =>
        (b[1].added || 0) +
        (b[1].removed || 0) -
        ((a[1].added || 0) + (a[1].removed || 0)),
    );
  if (significant.length > 0) {
    const items = significant.slice(0, 3).map(([kind, c]) => {
      const bits = [];
      if (c.added) bits.push(`+${c.added}`);
      if (c.removed) bits.push(`−${c.removed}`);
      return `${bits.join(" ")} ${pluralKind(kind, c.added + c.removed)}`;
    });
    parts.push(`Breakdown: ${items.join(", ")}.`);
  }

  // Sentence 3: most-affected file.
  const fileImpact = {};
  for (const n of ir.nodes) {
    if (!n._diff || n._diff === "unchanged") continue;
    const file = n.data?.file || (n.kind === "file" ? n.data?.path : null);
    if (!file) continue;
    fileImpact[file] = (fileImpact[file] || 0) + 1;
  }
  const top = Object.entries(fileImpact).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 3) {
    parts.push(
      `The biggest change touches \`${top[0]}\` (${top[1]} affected nodes).`,
    );
  }

  // Sentence 4: new/removed packages.
  const newPkgs = ir.nodes
    .filter((n) => n.kind === "package" && n._diff === "added")
    .map((n) => n.label);
  const goneP = ir.nodes
    .filter((n) => n.kind === "package" && n._diff === "removed")
    .map((n) => n.label);
  const pkgPhrases = [];
  if (newPkgs.length > 0 && newPkgs.length <= 5) {
    pkgPhrases.push(`new external dependencies: ${newPkgs.join(", ")}`);
  } else if (newPkgs.length > 5) {
    pkgPhrases.push(`${newPkgs.length} new external dependencies`);
  }
  if (goneP.length > 0 && goneP.length <= 5) {
    pkgPhrases.push(`dropped: ${goneP.join(", ")}`);
  } else if (goneP.length > 5) {
    pkgPhrases.push(`${goneP.length} removed dependencies`);
  }
  if (pkgPhrases.length > 0) {
    parts.push(capitalize(pkgPhrases.join("; ")) + ".");
  }

  return parts.join(" ");
}

function pluralKind(kind, total) {
  // function → functions, class → classes, package → packages, cell → cells, file → files
  if (total === 1) return kind;
  if (kind === "class") return "classes";
  return kind + "s";
}

function capitalize(s) {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
