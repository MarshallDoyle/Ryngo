/**
 * Share short-lived successful repo analysis results across HTTP and MCP.
 */
import { analyzeRepo } from "./analyze.js";
import { parseGitHubRepoUrl, preflightGitHubRepo } from "./github.js";

const ANALYSIS_CACHE_MS = 5 * 60 * 1000;
const MAX_ANALYSIS_CACHE_ENTRIES = 8;

const irCache = new Map();

/** Return an analyzed IR, cached by normalized GitHub URL and ref. */
export async function getCachedIR(githubUrl, ref = "", opts = {}) {
  const meta = opts.preflight === false
    ? parseGitHubRepoUrl(githubUrl)
    : await preflightGitHubRepo(githubUrl);
  const cleanRef = ref || "";
  const key = `${meta.normalizedUrl}@${cleanRef || "HEAD"}`;
  const hit = irCache.get(key);
  if (hit && Date.now() - hit.ts < ANALYSIS_CACHE_MS) {
    return { ir: hit.ir, cached: true, meta };
  }

  const ir = await analyzeRepo(meta.normalizedUrl, cleanRef);
  irCache.set(key, { ts: Date.now(), ir });
  if (irCache.size > MAX_ANALYSIS_CACHE_ENTRIES) {
    const oldest = [...irCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) irCache.delete(oldest[0]);
  }
  return { ir, cached: false, meta };
}
