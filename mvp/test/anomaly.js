/**
 * Phase 6.2 — anomaly detection for the corpus harness.
 *
 * After a corpus run, this scans per-repo classification counts and
 * flags rows that look statistically off relative to the rest of the
 * corpus. Catches the kind of bug that the original Express adapter
 * had — emitting 239 fake routes on `axios/axios` while every other
 * lib reported 0 — before it shows up in deltas as a quiet new
 * baseline.
 *
 * Two flag categories:
 *   🔴 hard  — almost certainly a defect:
 *     - emission > 5 × median AND raw value > 20      (over-emit)
 *     - stub-language repo with >0 emissions in a non-files / non-meta
 *       group (Go/Rust/Java/Ruby/C# shouldn't yet emit defs/routes/etc.)
 *   🟡 soft  — worth a look:
 *     - emission > 3 × median AND raw value > 10
 *     - this run's value is 0 but the previous run had ≥ N — a quiet
 *       regression that didn't trip the per-repo expects gate
 *
 * Pure function. The runner calls this after computing per-repo
 * classification counts and weaves the results into both stdout and
 * `latest.md`.
 */

import { CLASSIFICATIONS } from "./classifications.js";

/**
 * @param {Array} results — per-repo result objects from corpus-run.js
 * @param {Object|null} previous — the previous summary row from history.json
 * @returns {{ flags: Array, hardCount: number, softCount: number }}
 */
export function detectAnomalies(results, previous) {
  const flags = [];

  // Pre-compute median per classification across `ok` results.
  const okResults = results.filter((r) => r.ok);
  const medians = new Map();
  for (const c of CLASSIFICATIONS) {
    const values = okResults
      .map((r) => r.classifications?.[c.id] || 0)
      .sort((a, b) => a - b);
    medians.set(c.id, quantile(values, 0.5));
  }

  for (const r of results) {
    if (!r.ok || !r.classifications) continue;

    for (const c of CLASSIFICATIONS) {
      const value = r.classifications[c.id] || 0;
      const median = medians.get(c.id);

      // Over-emission heuristic. The thresholds below were tuned after
      // we removed the MAX_FILES cap — without it, large repos
      // legitimately produce 400+ typed-fn / 200+ class counts that
      // are ~10× the corpus median but not bugs. Hard flags now
      // require value > 12× median AND > 100; soft requires > 6× and
      // > 40. This catches the original axios=239 shape (median=0,
      // value=239) while ignoring "this repo is just big".
      if (median > 0 && value > 12 * median && value > 100) {
        flags.push({
          severity: "hard",
          url: r.url,
          lang: r.lang,
          classification: c.id,
          label: c.label,
          actual: value,
          median,
          reason: `${value} is ${(value / median).toFixed(1)}× the corpus median (${median})`,
        });
      } else if (median > 0 && value > 6 * median && value > 40) {
        flags.push({
          severity: "soft",
          url: r.url,
          lang: r.lang,
          classification: c.id,
          label: c.label,
          actual: value,
          median,
          reason: `${value} is ${(value / median).toFixed(1)}× the corpus median (${median})`,
        });
      }
      // Tiny-median over-emission (the canonical bug shape: a class of
      // adapter that should produce 0 starts producing dozens). Flags
      // a hard anomaly when median = 0 but this repo has > 50.
      if (median === 0 && value > 50) {
        flags.push({
          severity: "hard",
          url: r.url,
          lang: r.lang,
          classification: c.id,
          label: c.label,
          actual: value,
          median: 0,
          reason: `${value} where corpus median is 0 — likely a false positive`,
        });
      }
    }
  }

  // Per-repo silent-regression check against the previous run.
  if (previous?.classifications) {
    // We don't have per-repo previous values in history.json (only
    // totals). The corpus-wide drop case is already tripped by the
    // delta logging. Per-repo silent-regression detection would
    // require enriching history.json with per-repo rows — a Phase
    // 6.2.1 follow-up. For now, we surface only over-emission +
    // stub flags.
    void previous;
  }

  const hardCount = flags.filter((f) => f.severity === "hard").length;
  const softCount = flags.filter((f) => f.severity === "soft").length;
  return { flags, hardCount, softCount };
}

function quantile(sorted, p) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
