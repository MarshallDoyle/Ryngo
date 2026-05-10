/**
 * Jupyter notebook parser — wraps the Python parser per cell.
 *
 * Returns a ParsedFile with `cells: [{ index, source, label, imports, calls }]`
 * for the IR builder to materialize as cell nodes. The file-level imports/
 * defs/calls arrays stay empty: the IR routes import/call edges through cell
 * nodes rather than the notebook itself.
 */
import { parse as parsePython } from "./py.js";

export function parse(content /*, opts */) {
  const cells = extractCells(content);
  const analyzedCells = cells.map((c) => {
    const inner = parsePython(c.source, {});
    return {
      ...c,
      imports: inner.imports,
      defs: inner.defs,
      calls: inner.calls.map((call) => ({
        ...call,
        from: "__cell__", // synthetic; analyze.js rewrites to the cell node id
      })),
    };
  });
  return {
    lang: "jupyter",
    backend: "regex",
    imports: [],
    defs: [],
    calls: [],
    cells: analyzedCells,
  };
}

function extractCells(content) {
  let nb;
  try {
    nb = JSON.parse(content);
  } catch {
    return [];
  }
  const cells = Array.isArray(nb.cells) ? nb.cells : [];
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c?.cell_type !== "code") continue;
    const source = Array.isArray(c.source)
      ? c.source.join("")
      : c.source || "";
    if (!source.trim()) continue;
    out.push({
      index: i,
      source,
      label: cellLabel(source),
    });
  }
  return out;
}

function cellLabel(source) {
  const MAX = 26;
  const lines = source.split("\n");
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    if (t.startsWith("#") && !/^#!|^# %%|^# ---/.test(t)) {
      return truncate(t.replace(/^#+\s*/, ""), MAX);
    }
    break;
  }
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    if (/^(import|from)\s/.test(t)) continue;
    return truncate(t, MAX);
  }
  for (const ln of lines) {
    const t = ln.trim();
    if (t) return truncate(t, MAX);
  }
  return "(empty cell)";
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
