/**
 * Corpus harness — run analyzeRepo against every entry in test/corpus.js,
 * compute classification counts, and write three artifacts under
 * test/results/:
 *
 *   <ISO-timestamp>.json   - full per-repo results for this run
 *   latest.md              - human-readable summary table (overwritten)
 *   history.json           - one row per run with totals + per-classification
 *                            sums; lets you see deltas over time
 *
 * Each repo is given CORPUS_TIMEOUT_MS to clone + analyze. Failures are
 * captured (not fatal). Concurrency = CORPUS_CONCURRENCY (default 3) so we
 * don't thrash the network.
 *
 * Usage:
 *   node scripts/corpus-run.js                # run once
 *   node scripts/corpus-run.js --filter=fastapi    # only repos whose URL contains 'fastapi'
 *   node scripts/corpus-run.js --json              # write JSON only, skip MD + history
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRepo } from "../lib/analyze.js";
import { CORPUS } from "../test/corpus.js";
import { CLASSIFICATIONS, computeAll } from "../test/classifications.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "..", "test", "results");
const HISTORY_PATH = path.join(RESULTS_DIR, "history.json");
const LATEST_PATH = path.join(RESULTS_DIR, "latest.md");

const CORPUS_TIMEOUT_MS = Number(process.env.CORPUS_TIMEOUT_MS) || 90_000;
const CORPUS_CONCURRENCY = Number(process.env.CORPUS_CONCURRENCY) || 3;

const argv = process.argv.slice(2);
const filterArg = argv.find((a) => a.startsWith("--filter="));
const filter = filterArg ? filterArg.slice("--filter=".length) : null;
const jsonOnly = argv.includes("--json");

async function main() {
  await fs.mkdir(RESULTS_DIR, { recursive: true });

  const tasks = CORPUS.filter(
    (e) => !filter || e.url.toLowerCase().includes(filter.toLowerCase()),
  );
  if (tasks.length === 0) {
    console.error(`no corpus entries match filter "${filter}"`);
    process.exit(1);
  }

  console.log(
    `corpus: ${tasks.length} repos, concurrency=${CORPUS_CONCURRENCY}, timeout=${CORPUS_TIMEOUT_MS}ms`,
  );
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();

  const results = await runWithConcurrency(tasks, CORPUS_CONCURRENCY, runOne);

  const totalMs = Date.now() - startedAt;
  const summary = summarize(results, startedIso, totalMs);

  // ---- write per-run JSON ------------------------------------------------
  const safeIso = startedIso.replace(/[:.]/g, "-");
  const runPath = path.join(RESULTS_DIR, `${safeIso}.json`);
  await fs.writeFile(runPath, JSON.stringify({ summary, results }, null, 2));
  console.log(`wrote ${path.relative(process.cwd(), runPath)}`);

  if (jsonOnly) return;

  // Filtered runs are not representative of the corpus; writing them to
  // history.json would poison delta calculations on the next full run.
  // The per-run JSON file still gets written above so the filtered output
  // is recoverable; we just don't treat it as the new baseline.
  if (filter) {
    console.log(`(filter active: skipping history.json + latest.md update)`);
    return;
  }

  // ---- update history.json ----------------------------------------------
  const history = await readJson(HISTORY_PATH, []);
  const previous = history[history.length - 1] || null;
  history.push(summary);
  // Keep last 200 runs.
  while (history.length > 200) history.shift();
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(`updated ${path.relative(process.cwd(), HISTORY_PATH)}`);

  // ---- render latest.md -------------------------------------------------
  const md = renderLatest(summary, results, previous);
  await fs.writeFile(LATEST_PATH, md);
  console.log(`updated ${path.relative(process.cwd(), LATEST_PATH)}`);

  // ---- log a short stdout summary --------------------------------------
  console.log("\n--- summary ---");
  console.log(
    `repos:  ${summary.ok}/${summary.total} ok  (${summary.errors} errored, ${summary.skipped} skipped)`,
  );
  console.log(`elapsed: ${(totalMs / 1000).toFixed(1)}s`);
  for (const c of CLASSIFICATIONS) {
    const v = summary.classifications[c.id] ?? 0;
    const prev = previous?.classifications?.[c.id] ?? 0;
    const delta = v - prev;
    if (v === 0 && delta === 0) continue;
    const sign = delta > 0 ? `+${delta}` : `${delta}`;
    const arrow = delta === 0 ? "·" : delta > 0 ? "▲" : "▼";
    console.log(`  ${arrow} ${c.label.padEnd(40)} ${String(v).padStart(7)}  (Δ ${sign})`);
  }

  // ---- expects (Phase 6.3): print + non-zero exit on min violations ----
  if (summary.violations.length > 0) {
    console.log(
      `\n--- ${summary.violations.length} expects violation${summary.violations.length === 1 ? "" : "s"} (${summary.minViolations} hard, ${summary.maxViolations} soft) ---`,
    );
    for (const v of summary.violations) {
      const repo = v.url.replace("https://github.com/", "");
      const op = v.kind === "min" ? "<" : ">";
      const sev = v.kind === "min" ? "🔴 min" : "🟡 max";
      console.log(
        `  ${sev}  ${repo.padEnd(40)}  ${v.classification.padEnd(28)}  ${v.actual} ${op} ${v.expected}`,
      );
    }
  } else {
    console.log("\nexpects: all repos within declared bounds.");
  }
  // CI gate: hard `min` violations exit non-zero so PR-blocking workflows
  // (Phase 6.4) can refuse to merge. Soft `max` violations are warnings
  // only — they're surfaced but don't fail the run.
  if (summary.minViolations > 0) {
    console.error(
      `\nFAIL: ${summary.minViolations} hard min-violation${summary.minViolations === 1 ? "" : "s"} — exiting 1.`,
    );
    process.exit(1);
  }
}

async function runOne(entry) {
  if (entry.skip) {
    return {
      url: entry.url,
      family: entry.family,
      lang: entry.lang,
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
          () => reject(new Error(`timeout after ${CORPUS_TIMEOUT_MS}ms`)),
          CORPUS_TIMEOUT_MS,
        ),
      ),
    ]);
    const ms = Date.now() - t0;
    const counts = computeAll(ir);
    const violations = checkExpects(entry.expects, counts);
    return {
      url: entry.url,
      family: entry.family,
      lang: entry.lang,
      note: entry.note,
      ok: true,
      ms,
      ir_stats: ir.stats,
      ranAdapters: ir.stats?.ranAdapters || [],
      truncated: !!ir.stats?.truncated,
      diagnostics: (ir.diagnostics || []).slice(0, 5),
      classifications: counts,
      expects: entry.expects || null,
      violations,
    };
  } catch (err) {
    const ms = Date.now() - t0;
    return {
      url: entry.url,
      family: entry.family,
      lang: entry.lang,
      note: entry.note,
      ok: false,
      ms,
      error: err.message || String(err),
    };
  }
}

/**
 * Validate per-repo expectations from corpus.js. Returns an array of
 * { kind: 'min' | 'max', classification, expected, actual } violations;
 * an empty array when the repo passes all its declared bounds.
 *
 * `min` violations are hard regressions (parser/adapter dropped a
 * signal we depend on). `max` violations are soft alarms (an adapter
 * is over-emitting; usually a false-positive bug like the original
 * Express axios=239 problem).
 */
function checkExpects(expects, classifications) {
  if (!expects) return [];
  const out = [];
  for (const [id, bounds] of Object.entries(expects)) {
    const actual = classifications[id] ?? 0;
    if (bounds.min != null && actual < bounds.min) {
      out.push({ kind: "min", classification: id, expected: bounds.min, actual });
    }
    if (bounds.max != null && actual > bounds.max) {
      out.push({ kind: "max", classification: id, expected: bounds.max, actual });
    }
  }
  return out;
}

async function runWithConcurrency(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const my = i++;
      if (my >= items.length) return;
      const start = Date.now();
      const result = await fn(items[my]);
      out[my] = result;
      done++;
      const ms = Date.now() - start;
      const status = result.skipped
        ? "skip"
        : result.ok
          ? `ok  ${result.ms}ms`
          : `ERR ${result.ms}ms — ${result.error?.slice(0, 60)}`;
      console.log(
        `[${done}/${items.length}] ${status.padEnd(20)} ${items[my].url}`,
      );
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

function summarize(results, iso, totalMs) {
  const ok = results.filter((r) => r.ok).length;
  const errors = results.filter((r) => r.ok === false).length;
  const skipped = results.filter((r) => r.skipped).length;
  const totals = {};
  for (const c of CLASSIFICATIONS) totals[c.id] = 0;
  for (const r of results) {
    if (!r.ok || !r.classifications) continue;
    for (const c of CLASSIFICATIONS) {
      totals[c.id] += r.classifications[c.id] || 0;
    }
  }
  // Adapter coverage: how many repos triggered each adapter.
  const adapterCoverage = {};
  for (const r of results) {
    for (const a of r.ranAdapters || []) {
      adapterCoverage[a] = (adapterCoverage[a] || 0) + 1;
    }
  }
  // Phase 6.3: aggregate expects-violations across all repos.
  const violations = [];
  for (const r of results) {
    if (!r.violations?.length) continue;
    for (const v of r.violations) {
      violations.push({ url: r.url, ...v });
    }
  }
  const minViolations = violations.filter((v) => v.kind === "min").length;
  const maxViolations = violations.filter((v) => v.kind === "max").length;
  return {
    iso,
    elapsedMs: totalMs,
    total: results.length,
    ok,
    errors,
    skipped,
    classifications: totals,
    adapterCoverage,
    violations,
    minViolations,
    maxViolations,
  };
}

function renderLatest(summary, results, previous) {
  const lines = [];
  lines.push(`# Ryngo corpus — last run ${summary.iso}`);
  lines.push("");
  lines.push(
    `**${summary.ok}/${summary.total}** repos analyzed ok (${summary.errors} errored, ${summary.skipped} skipped). Elapsed: **${(summary.elapsedMs / 1000).toFixed(1)}s**.`,
  );
  if (previous) {
    lines.push("");
    lines.push(
      `_Previous run: ${previous.iso} (${previous.ok}/${previous.total} ok, ${(previous.elapsedMs / 1000).toFixed(1)}s)._`,
    );
  }

  // -- per-classification table -------------------------------------------
  lines.push("");
  lines.push("## Classification coverage");
  lines.push("");
  lines.push("| Group | Classification | Count | Δ since last run |");
  lines.push("|---|---|---:|---:|");
  for (const c of CLASSIFICATIONS) {
    const v = summary.classifications[c.id] ?? 0;
    const prev = previous?.classifications?.[c.id] ?? 0;
    const delta = v - prev;
    const sign = delta === 0 ? "—" : delta > 0 ? `+${delta}` : `${delta}`;
    lines.push(`| ${c.group} | ${c.label} | ${v} | ${sign} |`);
  }

  // -- expects violations (Phase 6.3) ------------------------------------
  if (summary.violations?.length) {
    lines.push("");
    lines.push(
      `## Expects violations (${summary.minViolations} hard, ${summary.maxViolations} soft)`,
    );
    lines.push("");
    lines.push("| Severity | Repo | Classification | Actual | Bound |");
    lines.push("|---|---|---|---:|---|");
    for (const v of summary.violations) {
      const repo = v.url.replace("https://github.com/", "");
      const sev = v.kind === "min" ? "🔴 hard" : "🟡 soft";
      const op = v.kind === "min" ? "≥" : "≤";
      lines.push(
        `| ${sev} | ${repo} | ${v.classification} | ${v.actual} | ${op} ${v.expected} |`,
      );
    }
  }

  // -- adapter coverage ---------------------------------------------------
  lines.push("");
  lines.push("## Adapter coverage (repos that triggered each)");
  lines.push("");
  lines.push("| Adapter | Repos |");
  lines.push("|---|---:|");
  for (const [name, n] of Object.entries(summary.adapterCoverage).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`| ${name} | ${n} |`);
  }

  // -- per-repo --------------------------------------------------------
  lines.push("");
  lines.push("## Per-repo");
  lines.push("");
  lines.push("| Repo | Lang | Status | ms | Files | Defs | Classes | Routes | DB | Env | Adapters |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  const sorted = [...results].sort((a, b) => a.url.localeCompare(b.url));
  for (const r of sorted) {
    if (r.skipped) {
      lines.push(`| ${shortRepo(r.url)} | ${r.lang} | skip — ${r.reason} | – | – | – | – | – | – | – | – |`);
      continue;
    }
    if (!r.ok) {
      lines.push(
        `| ${shortRepo(r.url)} | ${r.lang} | **ERR** | ${r.ms} | – | – | – | – | – | – | (${r.error?.slice(0, 60) || ""}) |`,
      );
      continue;
    }
    const c = r.classifications;
    lines.push(
      `| ${shortRepo(r.url)} | ${r.lang} | ok${r.truncated ? " (truncated)" : ""} | ${r.ms} | ${c.file_total} | ${c.fn_total} | ${c.class_total} | ${c.http_routes} | ${c.db_models + c.db_read_edges + c.db_write_edges} | ${c.env_nodes} | ${(r.ranAdapters || []).join(", ") || "—"} |`,
    );
  }
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}`);
  return lines.join("\n");
}

function shortRepo(url) {
  const m = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : url;
}

async function readJson(p, fallback) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

main().catch((err) => {
  console.error(`corpus: fatal ${err.message || err}`);
  console.error(err.stack);
  process.exit(1);
});
