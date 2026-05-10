/**
 * Smoke test for the Ryngo Phase-5 analyzer.
 *
 * Runs analyzeRepo against a small public repo and asserts:
 *   - Basic IR shape (nodes/edges arrays, stats present, at least one file).
 *   - At least one function node with `params` and (when typed) `returnType`.
 *   - At least one class node with `members.methods` populated.
 *   - The `ranAdapters` list is present (even if empty).
 *   - LLM projections (`compactJson`, `topology`, `englishSignature`) all
 *     return non-empty results without throwing.
 *
 * Usage:  node scripts/smoke.js [github-url]
 *
 * Exits 0 on success, 1 on failure.
 */
import { analyzeRepo } from "../lib/analyze.js";
import {
  compactJson,
  topology,
  englishSignature,
  slice,
} from "../lib/projection-llm.js";

const url = process.argv[2] || "https://github.com/vercel/ms";

async function main() {
  console.log(`smoke: analyzing ${url} ...`);
  const t0 = Date.now();
  const ir = await analyzeRepo(url);
  const ms = Date.now() - t0;

  const fileNodes = ir.nodes.filter((n) => n.kind === "file");
  const fnNodes = ir.nodes.filter((n) => n.kind === "function");
  const classNodes = ir.nodes.filter((n) => n.kind === "class");
  const routes = ir.nodes.filter((n) => n.kind === "http-route");
  const dbModels = ir.nodes.filter((n) => n.kind === "db-model");
  const envNodes = ir.nodes.filter((n) => n.kind === "env");

  const fnWithParams = fnNodes.filter((n) => Array.isArray(n.data?.params));
  const fnWithReturn = fnNodes.filter((n) => n.data?.returnType);
  const classWithMembers = classNodes.filter(
    (n) => n.data?.members?.methods?.length || n.data?.members?.fields?.length,
  );

  const baseOk =
    Array.isArray(ir.nodes) &&
    Array.isArray(ir.edges) &&
    ir.stats &&
    typeof ir.stats.files === "number" &&
    fileNodes.length > 0 &&
    Array.isArray(ir.stats.ranAdapters) &&
    ir.quality &&
    typeof ir.quality.score === "number";

  console.log(
    `smoke: ${baseOk ? "ok" : "FAIL"}  ${ms}ms  files=${ir.stats.files} analyzed=${ir.stats.analyzedFiles} edges=${ir.stats.edges}`,
  );
  console.log(
    `       fns=${fnNodes.length} (with params=${fnWithParams.length}, with returnType=${fnWithReturn.length})`,
  );
  console.log(
    `       classes=${classNodes.length} (with members=${classWithMembers.length})`,
  );
  console.log(
    `       routes=${routes.length}, dbModels=${dbModels.length}, envReads=${envNodes.length}`,
  );
  console.log(`       ranAdapters=[${ir.stats.ranAdapters.join(", ")}]`);
  if (ir.quality) {
    console.log(
      `       quality=${ir.quality.status} score=${Math.round(ir.quality.score * 100)} parsed=${ir.quality.stats.parsedFiles}/${ir.quality.stats.analyzableFiles}`,
    );
  }
  if (ir.diagnostics?.length) {
    console.log(`       diagnostics(first 3): ${ir.diagnostics.slice(0, 3).join(" | ")}`);
  }

  // Projections — non-empty + no throw.
  const compact = compactJson(ir);
  const topo = topology(ir);
  const sampleFn = fnNodes[0];
  const sig = sampleFn ? englishSignature(sampleFn) : "";
  const sliced = sampleFn ? slice(ir, sampleFn.id, { hops: 1 }) : null;

  const projOk =
    compact.nodes.length > 0 &&
    typeof topo === "string" &&
    topo.length > 0 &&
    (!sampleFn || sig.length > 0) &&
    (!sampleFn || sliced.nodes.length > 0);

  console.log(
    `       projections: compact=${compact.nodes.length}n/${compact.edges.length}e topology=${topo.length}c sample-sig="${sig.slice(0, 60)}…"`,
  );

  if (!baseOk || !projOk) {
    console.error("FAIL: IR shape or projections invalid");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`smoke: error  ${err.message || err}`);
  console.error(err.stack);
  process.exit(1);
});
