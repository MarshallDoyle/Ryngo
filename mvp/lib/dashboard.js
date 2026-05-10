/**
 * Pure derivations off an IR — drives the Dashboard tab. No filesystem,
 * no network. Run on the IR you already have.
 *
 *   {
 *     repo, ref,
 *     totals: { files, analyzedFiles, definitions, cells, packages, edges, callEdges },
 *     byLang: { ts: 12, py: 4, ... },
 *     topPackages: [{ name, count }],
 *     hotspots:    [{ label, file, count }],   // top files by edge traffic
 *     denseFiles:  [{ file, defs }],           // top files by definition count
 *   }
 */
export function dashboardStats(ir) {
  if (!ir) return null;

  // -- by-language count over file nodes -----------------------------------
  const byLang = {};
  for (const n of ir.nodes) {
    if (n.kind !== "file") continue;
    const lang = n.data?.lang || extOf(n.label) || "other";
    byLang[lang] = (byLang[lang] || 0) + 1;
  }

  // -- top external packages by inbound import-edges -----------------------
  const pkgInbound = {};
  for (const e of ir.edges) {
    if (!e.target.startsWith("pkg:")) continue;
    if (e.kind !== "imports-package" && e.kind !== "calls") continue;
    pkgInbound[e.target] = (pkgInbound[e.target] || 0) + 1;
  }
  const topPackages = Object.entries(pkgInbound)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, count]) => {
      const node = ir.nodes.find((n) => n.id === id);
      return { name: node?.label || id.replace(/^pkg:/, ""), count };
    });

  // -- hotspots: files with the most edge traffic --------------------------
  // Edges where either endpoint is a file:* OR a child of a file:* count
  // toward the file's traffic. We use parentId for child→file rollup.
  const idToParentFile = new Map();
  for (const n of ir.nodes) {
    if (n.kind === "file") idToParentFile.set(n.id, n.id);
    else if (n.parentId?.startsWith?.("file:"))
      idToParentFile.set(n.id, n.parentId);
  }
  const fileTraffic = {};
  for (const e of ir.edges) {
    const sFile = idToParentFile.get(e.source);
    const tFile = idToParentFile.get(e.target);
    if (sFile) fileTraffic[sFile] = (fileTraffic[sFile] || 0) + 1;
    if (tFile && tFile !== sFile)
      fileTraffic[tFile] = (fileTraffic[tFile] || 0) + 1;
  }
  const hotspots = Object.entries(fileTraffic)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, count]) => {
      const node = ir.nodes.find((n) => n.id === id);
      return {
        label: node?.label || id,
        file: node?.data?.path || id,
        count,
      };
    });

  // -- dense files: top by definition count --------------------------------
  const defsByFile = {};
  for (const n of ir.nodes) {
    if (n.kind !== "function" && n.kind !== "class") continue;
    const file = n.data?.file;
    if (!file) continue;
    defsByFile[file] = (defsByFile[file] || 0) + 1;
  }
  const denseFiles = Object.entries(defsByFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([file, defs]) => ({ file, defs }));

  return {
    repo: ir.repo,
    ref: ir.ref || "HEAD",
    totals: {
      files: ir.stats?.files ?? ir.nodes.filter((n) => n.kind === "file").length,
      analyzedFiles: ir.stats?.analyzedFiles ?? 0,
      definitions:
        ir.stats?.definitions ??
        ir.nodes.filter((n) => n.kind === "function" || n.kind === "class").length,
      cells: ir.stats?.cells ?? ir.nodes.filter((n) => n.kind === "cell").length,
      packages: ir.stats?.packages ?? ir.nodes.filter((n) => n.kind === "package").length,
      edges: ir.stats?.edges ?? ir.edges.length,
      callEdges:
        ir.stats?.callEdges ?? ir.edges.filter((e) => e.kind === "calls").length,
    },
    byLang,
    topPackages,
    hotspots,
    denseFiles,
  };
}

function extOf(name) {
  if (!name) return null;
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : null;
}
