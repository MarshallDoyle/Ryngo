/**
 * Build deterministic compiler-quality reports from a Ryngo IR.
 */
export function buildCompileReport(ir) {
  const fileNodes = (ir.nodes || []).filter((node) => node.kind === "file");
  const childCounts = countChildren(ir.nodes || []);
  const degree = countDegree(ir.edges || []);
  const languages = new Map();
  const parserBackends = new Map();
  const parseStatuses = new Map();
  const flags = new Map();
  const weakFiles = [];
  const provenance = ir.provenance || provenanceStats(ir.nodes || [], ir.edges || []);

  for (const file of fileNodes) {
    const data = file.data || {};
    const lang = data.lang || "other";
    const backend = data.parserBackend || (data.analyzable ? "unknown" : "unsupported");
    const status = data.parseStatus || (data.analyzable ? "unknown" : "unsupported");
    const defs = childCounts.get(file.id) || 0;
    const links = degree.get(file.id) || 0;
    const fileFlags = qualityFlags({ data, defs, links });

    bump(parserBackends, backend);
    bump(parseStatuses, status);
    for (const flag of fileFlags) bump(flags, flag);

    const langStats = languages.get(lang) || emptyLanguageStats(lang);
    langStats.files += 1;
    if (data.analyzable) langStats.analyzable += 1;
    if (status === "ok") langStats.parsed += 1;
    if (status === "stub") langStats.stubbed += 1;
    if (status === "unsupported") langStats.unsupported += 1;
    if (status === "error") langStats.errors += 1;
    if (defs > 0) langStats.filesWithDefs += 1;
    langStats.definitions += defs;
    langStats.links += links;
    languages.set(lang, langStats);

    if (fileFlags.length) {
      weakFiles.push({
        id: file.id,
        path: data.path || file.id.replace(/^file:/, ""),
        lang,
        parseStatus: status,
        parserBackend: backend,
        defs,
        links,
        flags: fileFlags,
      });
    }
  }

  const stats = {
    files: fileNodes.length,
    analyzableFiles: fileNodes.filter((file) => file.data?.analyzable).length,
    parsedFiles: fileNodes.filter((file) => file.data?.parseStatus === "ok").length,
    stubbedFiles: fileNodes.filter((file) => file.data?.parseStatus === "stub").length,
    unsupportedFiles: fileNodes.filter((file) => file.data?.parseStatus === "unsupported").length,
    skippedLargeFiles: fileNodes.filter((file) => file.data?.parseStatus === "skipped_large").length,
    erroredFiles: fileNodes.filter((file) => file.data?.parseStatus === "error").length,
    filesWithDefs: [...childCounts.keys()].filter((id) =>
      fileNodes.some((file) => file.id === id),
    ).length,
    isolatedFiles: fileNodes.filter((file) => (degree.get(file.id) || 0) === 0).length,
    diagnostics: (ir.diagnostics || []).length,
  };
  const score = qualityScore(stats);
  const status = qualityStatus(score, stats);

  return {
    repo: ir.repo || null,
    ref: ir.ref || "HEAD",
    status,
    score,
    summary: {
      status,
      score,
      parsedFileRatio: ratio(stats.parsedFiles, stats.analyzableFiles),
      definitionFileRatio: ratio(stats.filesWithDefs, stats.analyzableFiles),
      isolatedFileRatio: ratio(stats.isolatedFiles, stats.files),
      diagnosticCount: stats.diagnostics,
      sourceAnchorCoverage: provenance.sourceAnchorCoverage,
      factProvenanceCoverage: provenance.factProvenanceCoverage,
      confidence: provenance.confidence || {},
      edgesByConfidence: provenance.edgesByConfidence || {},
      nodesMissingSourceByKind: provenance.missingSourceByKind || {},
      factsMissingProvenance: provenance.factsMissingProvenance || 0,
      topFlags: topEntries(flags, 8),
    },
    stats,
    parserBackends: entriesObject(parserBackends),
    parseStatuses: entriesObject(parseStatuses),
    languages: Object.fromEntries(
      [...languages.values()]
        .sort((a, b) => b.files - a.files || compareText(a.lang, b.lang))
        .map((entry) => [entry.lang, entry]),
    ),
    weakFiles: weakFiles
      .sort(compareWeakFiles)
      .slice(0, 20),
    provenance,
    recommendations: recommendations(stats, flags),
  };
}

function provenanceStats(nodes, edges) {
  const confidence = {};
  const edgesByConfidence = {};
  const missingSourceByKind = {};
  let sourceBackedNodes = 0;
  let sourceBackedFacts = 0;
  let factCount = 0;
  for (const node of nodes) {
    const c = node.confidence || "unknown";
    confidence[c] = (confidence[c] || 0) + 1;
    if (node.source) sourceBackedNodes += 1;
    else missingSourceByKind[node.kind] = (missingSourceByKind[node.kind] || 0) + 1;
    for (const fact of node.facts || []) {
      factCount += 1;
      if (fact.source) sourceBackedFacts += 1;
    }
  }
  for (const edge of edges) {
    const c = edge.confidence || "unknown";
    edgesByConfidence[c] = (edgesByConfidence[c] || 0) + 1;
  }
  return {
    sourceAnchorCoverage: ratio(sourceBackedNodes, nodes.length),
    factProvenanceCoverage: ratio(sourceBackedFacts, factCount),
    confidence,
    edgesByConfidence,
    missingSourceByKind: entriesObject(new Map(Object.entries(missingSourceByKind))),
    factsMissingProvenance: Math.max(0, factCount - sourceBackedFacts),
  };
}

function countChildren(nodes) {
  const out = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (node.kind !== "function" && node.kind !== "class" && node.kind !== "cell") continue;
    bump(out, node.parentId);
  }
  return out;
}

function countDegree(edges) {
  const out = new Map();
  for (const edge of edges) {
    bump(out, edge.source);
    bump(out, edge.target);
  }
  return out;
}

function qualityFlags({ data, defs, links }) {
  const flags = [];
  if (data.parseStatus === "stub") flags.push("stub_backend");
  if (data.parseStatus === "unsupported") flags.push("unsupported_language");
  if (data.parseStatus === "skipped_large") flags.push("skipped_large_file");
  if (data.parseStatus === "error") flags.push("parse_error");
  if (data.analyzable && data.parseStatus === "ok" && defs === 0 && (data.size || 0) > 200) {
    flags.push("zero_defs_nontrivial_file");
  }
  if (links === 0) flags.push("isolated_file");
  return flags;
}

function qualityScore(stats) {
  const parsed = ratio(stats.parsedFiles, stats.analyzableFiles);
  const defs = ratio(stats.filesWithDefs, stats.analyzableFiles);
  const connected = 1 - ratio(stats.isolatedFiles, stats.files);
  const unsupportedPenalty = ratio(stats.stubbedFiles + stats.erroredFiles, stats.files) * 0.25;
  const diagnosticPenalty = Math.min(0.2, stats.diagnostics / 100);
  const score = parsed * 0.5 + defs * 0.25 + connected * 0.25 - unsupportedPenalty - diagnosticPenalty;
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

function qualityStatus(score, stats) {
  if (!stats.files) return "empty";
  if (stats.analyzableFiles === 0) return "unsupported";
  if (score >= 0.75) return "strong";
  if (score >= 0.5) return "usable";
  return "thin";
}

function recommendations(stats, flags) {
  const out = [];
  if ((flags.get("stub_backend") || 0) > 0) {
    out.push("Add or enable parsers for stubbed languages before trusting inner nodes.");
  }
  if ((flags.get("zero_defs_nontrivial_file") || 0) > 0) {
    out.push("Inspect nontrivial files with zero definitions; parser patterns are probably missing constructs.");
  }
  if (stats.isolatedFiles > stats.files * 0.4) {
    out.push("Improve import and call resolution to reduce isolated file nodes.");
  }
  if (stats.diagnostics > 0) {
    out.push("Review compiler diagnostics and convert repeated misses into corpus expectations.");
  }
  if (!out.length) {
    out.push("Compiler output looks healthy enough for high-level navigation.");
  }
  return out;
}

function emptyLanguageStats(lang) {
  return {
    lang,
    files: 0,
    analyzable: 0,
    parsed: 0,
    stubbed: 0,
    unsupported: 0,
    errors: 0,
    filesWithDefs: 0,
    definitions: 0,
    links: 0,
  };
}

function compareWeakFiles(a, b) {
  return (
    severity(b.flags) - severity(a.flags) ||
    b.links - a.links ||
    compareText(a.path, b.path)
  );
}

function severity(flags) {
  const weights = {
    parse_error: 5,
    stub_backend: 4,
    skipped_large_file: 3,
    zero_defs_nontrivial_file: 2,
    unsupported_language: 1,
    isolated_file: 1,
  };
  return flags.reduce((sum, flag) => sum + (weights[flag] || 0), 0);
}

function ratio(num, den) {
  return den > 0 ? Number((num / den).toFixed(3)) : 0;
}

function topEntries(map, max) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .slice(0, max)
    .map(([flag, count]) => ({ flag, count }));
}

function entriesObject(map) {
  return Object.fromEntries(
    [...map.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])),
  );
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function compareText(a = "", b = "") {
  return String(a).localeCompare(String(b));
}
