/**
 * Smoke test compiler-quality reporting against a small public repo.
 */
import assert from "node:assert/strict";
import { analyzeRepo } from "../lib/analyze.js";

const url = process.argv[2] || "https://github.com/vercel/ms";

console.log(`compile-report smoke: analyzing ${url} ...`);
const ir = await analyzeRepo(url);
const report = ir.quality;

assert.ok(report, "IR should include a compile report");
assert.equal(report.repo, ir.repo);
assert.equal(report.ref, ir.ref);
assert.ok(["strong", "usable", "thin", "unsupported", "empty"].includes(report.status));
assert.ok(report.score >= 0 && report.score <= 1, "score should be normalized");
assert.ok(report.stats.files > 0, "file count should be present");
assert.ok(report.stats.analyzableFiles > 0, "analyzable count should be present");
assert.ok(report.stats.parsedFiles > 0, "parsed files should be present for smoke repo");
assert.ok(Object.keys(report.languages).length > 0, "language breakdown should be present");
assert.ok(Array.isArray(report.recommendations), "recommendations should be present");

console.log(
  `compile-report smoke: ok ${report.status} (${Math.round(report.score * 100)}%) ` +
    `${report.stats.parsedFiles}/${report.stats.analyzableFiles} analyzable files parsed`,
);
