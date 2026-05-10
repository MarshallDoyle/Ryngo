/**
 * Token-efficiency benchmark — implementation of `mvp/docs/EVALS.md`.
 *
 * For each repo in `test/corpus.js`:
 *   1. Run `analyzeRepo(url)`. The same call that powers `npm run corpus`.
 *   2. From the canonical IR, compute byte / char / token counts for the
 *      raw analyzable source AND for each of the five Tier-4 projections
 *      defined in `lib/projection-llm.js` + the view-model from
 *      `lib/view-model.js`.
 *   3. Roll up per-language and per-representation medians.
 *
 * The output is two artifacts under `test/results/`:
 *   - token-efficiency-latest.json  ── full per-repo numbers (machine-readable)
 *   - token-efficiency-latest.md    ── human table (per-repo + roll-ups)
 *   - token-efficiency-history.json ── one row per run, totals only
 *
 * Methodology — token estimation
 * ------------------------------
 * We use the OpenAI rule-of-thumb 1 token ≈ 4 characters for English+code.
 * It overstates by ~5–10% on dense code (real cl100k_base averages 3.5–3.8
 * chars/token) and understates by ~10–15% on highly-indented JSON. We
 * record `chars` and `tokens` so anyone with tiktoken installed can
 * recompute with a real tokenizer without re-running the harness.
 *
 * Usage:
 *   npm run eval:tokens                       # full corpus
 *   npm run eval:tokens -- --filter=fastapi   # substring filter on URL
 *   npm run eval:tokens -- --json             # JSON only, skip MD + history
 *   npm run eval:tokens -- --limit=8          # first N repos
 *
 * Env:
 *   EVAL_TOKENS_TIMEOUT_MS  per-repo wall clock (default 180000)
 *   EVAL_TOKENS_CONCURRENCY parallel clones    (default 3)
 *   EVAL_TOKENS_SLICE_HOPS  subgraph depth     (default 2)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRepo } from "../lib/analyze.js";
import { CORPUS } from "../test/corpus.js";
import {
  compactJson,
  englishSignature,
  topology,
  slice,
} from "../lib/projection-llm.js";
import { buildViewModel } from "../lib/view-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "..", "test", "results");
const LATEST_JSON = path.join(RESULTS_DIR, "token-efficiency-latest.json");
const LATEST_MD = path.join(RESULTS_DIR, "token-efficiency-latest.md");
const HISTORY_JSON = path.join(RESULTS_DIR, "token-efficiency-history.json");

// Slim summary served by the landing page. The full per-repo JSON in
// test/results/ is gitignored (large, regenerated on demand); the
// landing only needs medians + a handful of representative rows for
// the bar chart and per-language table.
const LANDING_DATA_DIR = path.join(__dirname, "..", "landing", "data");
const LANDING_SUMMARY = path.join(LANDING_DATA_DIR, "tokens-summary.json");

const TIMEOUT_MS = Number(process.env.EVAL_TOKENS_TIMEOUT_MS) || 180_000;
const CONCURRENCY = Number(process.env.EVAL_TOKENS_CONCURRENCY) || 3;
const SLICE_HOPS = Number(process.env.EVAL_TOKENS_SLICE_HOPS) || 2;
const CHARS_PER_TOKEN = 4;

const argv = process.argv.slice(2);
const filterArg = argv.find((a) => a.startsWith("--filter="));
const filter = filterArg ? filterArg.slice("--filter=".length) : null;
const limitArg = argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : null;
const jsonOnly = argv.includes("--json");

// ---------------------------------------------------------------------------
// Per-repo measurement
// ---------------------------------------------------------------------------

/**
 * Map a corpus entry's `lang` to a coarser language family used in the
 * roll-ups. Keeps TypeScript and JavaScript together since they share a
 * parser; keeps Python and Jupyter together for the same reason.
 */
function langFamily(lang) {
  if (lang === "ts" || lang === "js") return "TypeScript/JavaScript";
  if (lang === "py" || lang === "ipynb") return "Python/Jupyter";
  if (lang === "go") return "Go";
  if (lang === "rust") return "Rust";
  if (lang === "java") return "Java";
  if (lang === "ruby") return "Ruby";
  if (lang === "csharp") return "C#";
  if (lang === "hcl") return "HCL/Terraform";
  return lang || "other";
}

function bytesToTokens(bytes) {
  return Math.round(bytes / CHARS_PER_TOKEN);
}

function stringTokens(str) {
  if (!str) return { chars: 0, tokens: 0 };
  const chars = typeof str === "string" ? str.length : JSON.stringify(str).length;
  return { chars, tokens: Math.round(chars / CHARS_PER_TOKEN) };
}

/**
 * Sum the on-disk byte size of every analyzable file in the IR. This is
 * the closest fair estimate for "what would I have to send the LLM if I
 * dumped the repo at it?". Non-analyzable files (binary assets, lockfiles)
 * are excluded because nobody would send them in a prompt either.
 */
function rawSourceMeasurement(ir) {
  let bytes = 0;
  let files = 0;
  for (const node of ir.nodes || []) {
    if (node.kind !== "file") continue;
    if (!node.data?.analyzable) continue;
    bytes += node.data.size || 0;
    files += 1;
  }
  return { chars: bytes, tokens: bytesToTokens(bytes), files };
}

/**
 * Pick a representative "hub" def for slice() — the node with the most
 * incoming + outgoing call edges. Falls back to the first def. The same
 * hub is fed to englishSignature() so both projections describe the same
 * symbol on every run.
 */
function pickHubDef(ir) {
  const defs = (ir.nodes || []).filter(
    (n) => n.kind === "function" || n.kind === "class",
  );
  if (defs.length === 0) return null;
  const degree = new Map();
  for (const e of ir.edges || []) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  let best = defs[0];
  let bestScore = degree.get(best.id) || 0;
  for (const d of defs) {
    const s = degree.get(d.id) || 0;
    if (s > bestScore) {
      best = d;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Compute every representation's token cost for one IR. Pure function:
 * no I/O, no globals. Returned shape is what lands in tokens-latest.json.
 */
function measureRepresentations(ir) {
  // Raw source baseline.
  const raw = rawSourceMeasurement(ir);

  // Topology — short bird's-eye markdown.
  const topologyStr = topology(ir);
  const topologyM = stringTokens(topologyStr);

  // Compact IR — JSON-serialised minimal IR.
  const compactObj = compactJson(ir);
  const compactStr = JSON.stringify(compactObj);
  const compactM = stringTokens(compactStr);

  // View-model — what the React Flow viewer + ChatGPT widget receive.
  const viewModelObj = buildViewModel(ir);
  const viewModelStr = JSON.stringify(viewModelObj);
  const viewModelM = stringTokens(viewModelStr);

  // Focused subgraph + signature — keyed on the same hub def, deterministic.
  const hub = pickHubDef(ir);
  let sliceM = { chars: 0, tokens: 0, hubId: null };
  let signatureM = { chars: 0, tokens: 0, hubId: null };
  if (hub) {
    const sliceObj = slice(ir, hub.id, { hops: SLICE_HOPS });
    const sliceStr = JSON.stringify(sliceObj);
    sliceM = { ...stringTokens(sliceStr), hubId: hub.id };
    const sigStr = englishSignature(hub);
    signatureM = { ...stringTokens(sigStr), hubId: hub.id };
  }

  return {
    rawFiles: raw,
    topology: topologyM,
    compactIR: compactM,
    viewModel: viewModelM,
    focusedSubgraph: sliceM,
    englishSignature: signatureM,
  };
}

function compressionRatio(repTokens, rawTokens) {
  if (!rawTokens) return null;
  return repTokens / rawTokens;
}

function ratiosFor(measurement) {
  const raw = measurement.rawFiles.tokens;
  if (!raw) return null;
  return {
    topology: compressionRatio(measurement.topology.tokens, raw),
    compactIR: compressionRatio(measurement.compactIR.tokens, raw),
    viewModel: compressionRatio(measurement.viewModel.tokens, raw),
    focusedSubgraph: compressionRatio(measurement.focusedSubgraph.tokens, raw),
    englishSignature: compressionRatio(
      measurement.englishSignature.tokens,
      raw,
    ),
  };
}

// ---------------------------------------------------------------------------
// Roll-ups
// ---------------------------------------------------------------------------

function median(values) {
  const sorted = values.filter((v) => v != null && !Number.isNaN(v)).slice();
  sorted.sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function mean(values) {
  const filtered = values.filter((v) => v != null && !Number.isNaN(v));
  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

/**
 * Build per-language median ratios. The headline landing-page number
 * (e.g. "compact IR is 8% of raw") comes from `byLanguage["all"].compactIR`.
 */
function rollUpByLanguage(rows) {
  const byLang = new Map();
  byLang.set("all", []);
  for (const r of rows) {
    if (!r.ok || !r.ratios) continue;
    const fam = langFamily(r.lang);
    if (!byLang.has(fam)) byLang.set(fam, []);
    byLang.get(fam).push(r);
    byLang.get("all").push(r);
  }
  const out = {};
  for (const [fam, list] of byLang.entries()) {
    out[fam] = {
      repos: list.length,
      medianRatios: {
        topology: median(list.map((r) => r.ratios.topology)),
        compactIR: median(list.map((r) => r.ratios.compactIR)),
        viewModel: median(list.map((r) => r.ratios.viewModel)),
        focusedSubgraph: median(list.map((r) => r.ratios.focusedSubgraph)),
        englishSignature: median(list.map((r) => r.ratios.englishSignature)),
      },
      meanRatios: {
        topology: mean(list.map((r) => r.ratios.topology)),
        compactIR: mean(list.map((r) => r.ratios.compactIR)),
        viewModel: mean(list.map((r) => r.ratios.viewModel)),
        focusedSubgraph: mean(list.map((r) => r.ratios.focusedSubgraph)),
        englishSignature: mean(list.map((r) => r.ratios.englishSignature)),
      },
      totalRawTokens: list.reduce(
        (a, r) => a + (r.measurement?.rawFiles?.tokens || 0),
        0,
      ),
    };
  }
  return out;
}

/**
 * Build per-representation roll-up: median ratio across all successful
 * repos, plus min / max for the landing page caveats.
 */
function rollUpByRepresentation(rows) {
  const reps = [
    "topology",
    "compactIR",
    "viewModel",
    "focusedSubgraph",
    "englishSignature",
  ];
  const out = {};
  for (const rep of reps) {
    const ratios = rows
      .filter((r) => r.ok && r.ratios)
      .map((r) => r.ratios[rep])
      .filter((v) => v != null);
    out[rep] = {
      medianRatio: median(ratios),
      meanRatio: mean(ratios),
      minRatio: ratios.length ? Math.min(...ratios) : null,
      maxRatio: ratios.length ? Math.max(...ratios) : null,
      samples: ratios.length,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runOne(entry) {
  if (entry.skip) {
    return {
      url: entry.url,
      lang: entry.lang,
      family: entry.family,
      note: entry.note,
      skipped: true,
      reason: entry.skip,
    };
  }
  const t0 = Date.now();
  try {
    const ir = await Promise.race([
      analyzeRepo(entry.url, entry.ref || ""),
      new Promise((_r, reject) =>
        setTimeout(
          () => reject(new Error(`timeout after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        ),
      ),
    ]);
    const ms = Date.now() - t0;
    const measurement = measureRepresentations(ir);
    const ratios = ratiosFor(measurement);
    return {
      url: entry.url,
      lang: entry.lang,
      family: entry.family,
      note: entry.note,
      ok: true,
      ms,
      stats: {
        files: ir.stats?.files,
        analyzedFiles: ir.stats?.analyzedFiles,
        definitions: ir.stats?.definitions,
        nodes: (ir.nodes || []).length,
        edges: (ir.edges || []).length,
        routes: ir.stats?.routes,
        dbModels: ir.stats?.dbModels,
        packages: ir.stats?.packages,
      },
      measurement,
      ratios,
    };
  } catch (err) {
    return {
      url: entry.url,
      lang: entry.lang,
      family: entry.family,
      note: entry.note,
      ok: false,
      ms: Date.now() - t0,
      error: err?.message || String(err),
    };
  }
}

async function runWithConcurrency(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const my = i++;
      if (my >= items.length) return;
      const result = await fn(items[my]);
      out[my] = result;
      done++;
      const status = result.skipped
        ? "skip"
        : result.ok
          ? `ok  ${result.ms}ms  raw=${result.measurement.rawFiles.tokens.toLocaleString()}t  compact=${result.measurement.compactIR.tokens.toLocaleString()}t  (${(result.ratios?.compactIR * 100).toFixed(1)}%)`
          : `ERR ${result.ms}ms — ${result.error?.slice(0, 60)}`;
      console.log(`[${done}/${items.length}] ${items[my].url}\n          ${status}`);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function fmt(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
function pct(r) {
  if (r == null || Number.isNaN(r)) return "—";
  if (r < 0.001) return (r * 100).toFixed(3) + "%";
  if (r < 0.01) return (r * 100).toFixed(2) + "%";
  return (r * 100).toFixed(1) + "%";
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("# Token-efficiency report\n");
  lines.push(`Generated: \`${report.iso}\`  ·  elapsed: ${(report.totalMs / 1000).toFixed(1)}s  ·  ${report.summary.ok}/${report.summary.total} repos OK\n`);
  lines.push("> Methodology: chars / 4 = tokens (OpenAI rule of thumb). `chars` is recorded alongside every count so anyone with tiktoken installed can recompute with a real cl100k_base tokenizer.\n");

  lines.push("\n## Headline\n");
  const all = report.rollUps.byLanguage.all;
  if (all) {
    lines.push(`Across ${all.repos} repos, the median Ryngo representation uses:\n`);
    lines.push("");
    lines.push("| Representation | Median % of raw | Mean % of raw |");
    lines.push("|---|---:|---:|");
    lines.push(`| Topology markdown | ${pct(all.medianRatios.topology)} | ${pct(all.meanRatios.topology)} |`);
    lines.push(`| Compact IR | ${pct(all.medianRatios.compactIR)} | ${pct(all.meanRatios.compactIR)} |`);
    lines.push(`| RyngoViewModel | ${pct(all.medianRatios.viewModel)} | ${pct(all.meanRatios.viewModel)} |`);
    lines.push(`| Focused subgraph (k=${SLICE_HOPS}) | ${pct(all.medianRatios.focusedSubgraph)} | ${pct(all.meanRatios.focusedSubgraph)} |`);
    lines.push(`| English signature (one symbol) | ${pct(all.medianRatios.englishSignature)} | ${pct(all.meanRatios.englishSignature)} |`);
  }

  lines.push("\n## By language\n");
  lines.push("| Language | Repos | Topology | Compact IR | ViewModel | Subgraph | Signature |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const [lang, m] of Object.entries(report.rollUps.byLanguage)) {
    if (lang === "all") continue;
    lines.push(
      `| ${lang} | ${m.repos} | ${pct(m.medianRatios.topology)} | ${pct(m.medianRatios.compactIR)} | ${pct(m.medianRatios.viewModel)} | ${pct(m.medianRatios.focusedSubgraph)} | ${pct(m.medianRatios.englishSignature)} |`,
    );
  }

  lines.push("\n## Per repo (sorted by raw token count)\n");
  lines.push("| Repo | Lang | Raw | Topology | Compact IR | ViewModel | Subgraph | Signature |");
  lines.push("|---|:---:|---:|---:|---:|---:|---:|---:|");
  const sorted = report.rows
    .filter((r) => r.ok)
    .sort((a, b) => (b.measurement.rawFiles.tokens || 0) - (a.measurement.rawFiles.tokens || 0));
  for (const r of sorted) {
    const repo = r.url.replace("https://github.com/", "");
    const m = r.measurement;
    // Some repos (e.g. HCL-only fixtures while we don't yet count HCL as
    // analyzable) have rawFiles.tokens === 0, which makes every ratio
    // null. Render those rows with em-dash placeholders so the table
    // stays well-formed.
    const ratio = r.ratios || {};
    lines.push(
      `| ${repo} | ${r.lang || "?"} | ${fmt(m.rawFiles.tokens)} | ${fmt(m.topology.tokens)} (${pct(ratio.topology)}) | ${fmt(m.compactIR.tokens)} (${pct(ratio.compactIR)}) | ${fmt(m.viewModel.tokens)} (${pct(ratio.viewModel)}) | ${fmt(m.focusedSubgraph.tokens)} (${pct(ratio.focusedSubgraph)}) | ${fmt(m.englishSignature.tokens)} (${pct(ratio.englishSignature)}) |`,
    );
  }

  const failures = report.rows.filter((r) => r.ok === false);
  if (failures.length) {
    lines.push("\n## Failures\n");
    for (const f of failures) {
      lines.push(`- \`${f.url}\` — ${f.error}`);
    }
  }

  const skipped = report.rows.filter((r) => r.skipped);
  if (skipped.length) {
    lines.push("\n## Skipped\n");
    for (const s of skipped) {
      lines.push(`- \`${s.url}\` — ${s.reason}`);
    }
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await fs.mkdir(RESULTS_DIR, { recursive: true });

  let tasks = CORPUS.filter(
    (e) => !filter || e.url.toLowerCase().includes(filter.toLowerCase()),
  );
  if (tasks.length === 0) {
    console.error(`no corpus entries match filter "${filter}"`);
    process.exit(1);
  }
  if (limit && limit > 0) tasks = tasks.slice(0, limit);

  console.log(
    `eval-tokens: ${tasks.length} repos, concurrency=${CONCURRENCY}, timeout=${TIMEOUT_MS}ms, slice hops=${SLICE_HOPS}`,
  );
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();

  const rows = await runWithConcurrency(tasks, CONCURRENCY, runOne);
  const totalMs = Date.now() - startedAt;

  const summary = {
    total: rows.length,
    ok: rows.filter((r) => r.ok).length,
    errors: rows.filter((r) => r.ok === false).length,
    skipped: rows.filter((r) => r.skipped).length,
  };
  const rollUps = {
    byLanguage: rollUpByLanguage(rows),
    byRepresentation: rollUpByRepresentation(rows),
  };

  const report = {
    iso: startedIso,
    totalMs,
    summary,
    methodology: {
      charsPerToken: CHARS_PER_TOKEN,
      sliceHops: SLICE_HOPS,
      timeoutMs: TIMEOUT_MS,
      note: "1 token ≈ 4 chars (OpenAI rule of thumb). `chars` recorded alongside every count so anyone with tiktoken installed can recompute with a real tokenizer.",
    },
    rollUps,
    rows,
  };

  await fs.writeFile(LATEST_JSON, JSON.stringify(report, null, 2) + "\n");
  if (!jsonOnly) {
    await fs.writeFile(LATEST_MD, renderMarkdown(report));
    await appendHistory(report);
    await writeLandingSummary(report);
  }

  // stdout summary
  console.log(`\n--- token efficiency summary ---`);
  console.log(`repos:   ${summary.ok}/${summary.total} ok  (${summary.errors} errored, ${summary.skipped} skipped)`);
  console.log(`elapsed: ${(totalMs / 1000).toFixed(1)}s`);
  const all = rollUps.byLanguage.all;
  if (all) {
    console.log(`\nMedian compression ratio (representation / raw):`);
    console.log(`  topology         ${pct(all.medianRatios.topology)}`);
    console.log(`  compact IR       ${pct(all.medianRatios.compactIR)}`);
    console.log(`  view-model       ${pct(all.medianRatios.viewModel)}`);
    console.log(`  focused subgraph ${pct(all.medianRatios.focusedSubgraph)}`);
    console.log(`  english sig.     ${pct(all.medianRatios.englishSignature)}`);
  }
  if (filter) {
    console.log(`\n(filter active: history.json not updated)`);
  }
}

/**
 * Slim summary for the landing page. Strips raw per-repo measurement
 * dictionaries and keeps just what the bar chart + per-language table
 * + featured-repos panel need. Committed to git so the landing page
 * always has a baseline even if the corpus hasn't been re-run on the
 * deploying machine.
 *
 * The full per-repo JSON in test/results/ stays gitignored — anyone
 * who wants to dig deeper runs `npm run eval:tokens` locally.
 */
export async function writeLandingSummary(report) {
  await fs.mkdir(LANDING_DATA_DIR, { recursive: true });
  const all = report.rollUps.byLanguage.all || { medianRatios: {}, meanRatios: {}, repos: 0 };

  // Pick 12 featured repos: top by raw-token count, but always include
  // the small "explainer" repos (vercel/ms, p-limit) so the chart shows
  // small + medium + large fairly.
  const okRows = report.rows.filter((r) => r.ok && r.measurement?.rawFiles?.tokens);
  const sortedByRaw = okRows
    .slice()
    .sort((a, b) => b.measurement.rawFiles.tokens - a.measurement.rawFiles.tokens);
  const featured = sortedByRaw
    .slice(0, 12)
    .map((r) => ({
      repo: r.url.replace("https://github.com/", ""),
      lang: r.lang,
      rawTokens: r.measurement.rawFiles.tokens,
      tokensPerRepresentation: {
        topology: r.measurement.topology.tokens,
        compactIR: r.measurement.compactIR.tokens,
        viewModel: r.measurement.viewModel.tokens,
        focusedSubgraph: r.measurement.focusedSubgraph.tokens,
        englishSignature: r.measurement.englishSignature.tokens,
      },
      ratios: r.ratios,
    }));

  // Corpus-wide totals for the live stats banner's baseline block.
  // These are the numbers `lib/stats-baseline.js` reads when there's no
  // live events-DB data to add — so the banner never shows zeros even
  // on a fresh deploy. Summed across every successfully-parsed repo in
  // the corpus.
  const corpusTotals = okRows.reduce(
    (acc, r) => ({
      files: acc.files + (r.stats?.files || 0),
      analyzedFiles: acc.analyzedFiles + (r.stats?.analyzedFiles || 0),
      nodes: acc.nodes + (r.stats?.nodes || 0),
      edges: acc.edges + (r.stats?.edges || 0),
      definitions: acc.definitions + (r.stats?.definitions || 0),
      routes: acc.routes + (r.stats?.routes || 0),
      dbModels: acc.dbModels + (r.stats?.dbModels || 0),
      packages: acc.packages + (r.stats?.packages || 0),
      rawTokens: acc.rawTokens + (r.measurement?.rawFiles?.tokens || 0),
    }),
    {
      files: 0,
      analyzedFiles: 0,
      nodes: 0,
      edges: 0,
      definitions: 0,
      routes: 0,
      dbModels: 0,
      packages: 0,
      rawTokens: 0,
    },
  );

  const summary = {
    iso: report.iso,
    repos: report.summary.ok,
    methodology: report.methodology,
    headline: {
      medianRatios: all.medianRatios,
      meanRatios: all.meanRatios,
      sampleSize: all.repos,
    },
    corpusTotals,
    byLanguage: Object.fromEntries(
      Object.entries(report.rollUps.byLanguage)
        .filter(([k]) => k !== "all")
        .map(([k, v]) => [k, { repos: v.repos, medianRatios: v.medianRatios }]),
    ),
    byRepresentation: report.rollUps.byRepresentation,
    featured,
  };
  await fs.writeFile(LANDING_SUMMARY, JSON.stringify(summary, null, 2) + "\n");
}

async function appendHistory(report) {
  if (filter) return; // poisoning the history with partial runs is the bug
                      // that wrecked corpus-run; same rule applies here.
  let history = [];
  try {
    history = JSON.parse(await fs.readFile(HISTORY_JSON, "utf8"));
  } catch {
    /* file doesn't exist yet */
  }
  const all = report.rollUps.byLanguage.all || { medianRatios: {} };
  history.push({
    iso: report.iso,
    totalMs: report.totalMs,
    repos: report.summary.ok,
    medianRatios: all.medianRatios,
    totalRawTokens: all.totalRawTokens || 0,
  });
  // keep last 200 rows; history files shouldn't grow forever
  if (history.length > 200) history = history.slice(-200);
  await fs.writeFile(HISTORY_JSON, JSON.stringify(history, null, 2) + "\n");
}

// Only execute when invoked directly (`node scripts/eval-tokens.js …`).
// When imported (e.g. by a rerender-from-json helper) the module's pure
// functions are still available without triggering a full corpus run.
// Note: `node -e ...` leaves process.argv[1] as "", so the guard
// short-circuits correctly there too.
const argv1 = process.argv[1] || "";
const invokedDirectly =
  argv1.length > 0 &&
  fileURLToPath(import.meta.url) === path.resolve(argv1);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("eval-tokens failed:", err);
    process.exit(1);
  });
}
