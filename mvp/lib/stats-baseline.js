/**
 * Static baseline numbers for the landing-page stats banner.
 *
 * The banner reads `/api/stats/public`, which combines:
 *   - **live** counters aggregated from `analysis_runs` (events DB)
 *   - **baseline** counters from the most recent corpus token-efficiency
 *     run (`mvp/landing/data/tokens-summary.json`)
 *
 * This module loads the baseline. Even if the events DB is empty
 * (fresh deploy, local dev, RYNGO_EVENTS=off), the banner can still
 * render real, defensible numbers from the corpus benchmark. The
 * stats endpoint's invariant: never show zeros.
 *
 * Pure module — no Postgres, no network, just JSON-on-disk reads.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_SUMMARY_PATH = path.join(
  __dirname,
  "..",
  "landing",
  "data",
  "tokens-summary.json",
);

let cached = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // baseline only changes when a new
                                    // corpus run lands; 5 min is plenty.

/**
 * Read the baseline numbers used for the public stats banner. Returns
 * `null` if the corpus summary hasn't been generated yet (the
 * `npm run eval:tokens` step never ran on this machine).
 */
export async function readBaseline() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;

  let raw;
  try {
    raw = await fs.readFile(TOKENS_SUMMARY_PATH, "utf8");
  } catch {
    return null; // No baseline available — caller handles by returning
                 // only `live` (which may itself be null on cold deploys).
  }

  let summary;
  try {
    summary = JSON.parse(raw);
  } catch {
    return null;
  }

  // Per-language file counts come from the per-row stats blocks in the
  // full token-efficiency-latest.json, NOT the slim summary — keep this
  // module dependency-free of that big file. The slim summary's
  // `corpusTotals` block carries the numbers we need; if it's missing
  // (older summary format) we fall back to summing `featured` raw
  // tokens, which understates slightly but never lies.
  const totals = summary.corpusTotals || {};
  const baseline = {
    reposAnalyzed: summary.repos ?? 0,
    filesParsed: totals.analyzedFiles ?? 0,
    nodesGenerated: totals.nodes ?? 0,
    edgesGenerated: totals.edges ?? 0,
    definitions: totals.definitions ?? 0,
    routesExtracted: totals.routes ?? 0,
    dbModelsExtracted: totals.dbModels ?? 0,
    packagesResolved: totals.packages ?? 0,
    rawTokensCompiled: totals.rawTokens ?? sumRaw(summary.featured),
    compressionRatios: summary.headline?.medianRatios || null,
    asOf: summary.iso,
    featured: (summary.featured || []).slice(0, 6).map((row) => ({
      repo: row.repo,
      lang: row.lang,
      rawTokens: row.rawTokens,
    })),
  };

  cached = baseline;
  cachedAt = now;
  return baseline;
}

/**
 * Sum the raw-token counts across the featured corpus repos. The slim
 * summary only keeps the top 12 by raw size, but they cover ~95 % of
 * total corpus mass (the long tail is small libs). The banner shows
 * "X+ tokens compressed" so understating slightly is fine; never
 * overstating is the rule.
 */
function sumRaw(featured) {
  if (!Array.isArray(featured)) return 0;
  return featured.reduce((acc, r) => acc + (r.rawTokens || 0), 0);
}

/**
 * Compute a banner-ready headline block from the baseline + (optional)
 * live aggregates. Returns the pre-rendered strings the landing
 * displays — no client-side math required.
 */
export function buildHeadline({ baseline, live }) {
  const reposCompiled =
    (live?.reposAnalyzed || 0) + (baseline?.reposAnalyzed || 0);
  const nodesGenerated =
    (live?.nodesGenerated || 0) + (baseline?.nodesGenerated || 0);
  const edgesGenerated =
    (live?.edgesGenerated || 0) + (baseline?.edgesGenerated || 0);
  const filesParsed =
    (live?.filesParsed || 0) + (baseline?.filesParsed || 0);
  const tokensCompressed = baseline?.rawTokensCompiled || 0;
  const topologyRatio =
    baseline?.compressionRatios?.topology ??
    live?.compressionRatios?.topology ??
    null;
  const agentReadyContext =
    topologyRatio && topologyRatio > 0
      ? `${Math.round(1 / topologyRatio)}× smaller`
      : null;

  return {
    reposCompiled,
    reposCompiledDisplay: formatNumber(reposCompiled),
    filesParsed,
    filesParsedDisplay: formatNumber(filesParsed),
    nodesGenerated,
    nodesGeneratedDisplay: formatNumber(nodesGenerated),
    edgesGenerated,
    edgesGeneratedDisplay: formatNumber(edgesGenerated),
    tokensCompressed,
    tokensCompressedDisplay: formatNumber(tokensCompressed),
    agentReadyContext,
  };
}

/**
 * Human-friendly truncation: 1234 → "1.2k", 1_000_000 → "1.0M".
 * Banner space is tight; the full integer is also available in the
 * non-display fields if the client wants tooltip detail.
 */
function formatNumber(n) {
  if (!n || n < 1000) return String(n || 0);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}
