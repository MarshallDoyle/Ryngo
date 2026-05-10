/**
 * `.ryngo/<repo>/snapshots/intent-<id>.json` — IR snapshots taken at the
 * moment an intent is created. Apply-and-verify diffs the current IR
 * against this snapshot.
 *
 * The snapshot is the same shape as a regular IR returned by /api/analyze
 * (no `_diff` annotations), so `lib/diff.js#diffIRs` works directly.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureRepoDir, readJson, repoDir } from "./storage.js";

const DIR = "snapshots";

export async function saveIntentSnapshot(repo, intentId, ir) {
  if (!ir) throw new Error("saveIntentSnapshot: ir is required");
  const dir = await ensureRepoDir(repo);
  const target = path.join(dir, DIR);
  await fs.mkdir(target, { recursive: true });
  const file = path.join(target, `intent-${intentId}.json`);
  // Strip noise that bloats the snapshot (graph layout-only; doesn't affect verify).
  const minimal = {
    repo: ir.repo,
    ref: ir.ref,
    nodes: ir.nodes,
    edges: ir.edges,
    stats: ir.stats,
  };
  await fs.writeFile(file, JSON.stringify(minimal), "utf8");
  return `${DIR}/intent-${intentId}.json`;
}

export async function loadIntentSnapshot(repo, intentId) {
  return readJson(
    repo,
    path.join(DIR, `intent-${intentId}.json`),
    null,
  );
}

export async function snapshotPath(repo, intentId) {
  return path.join(repoDir(repo), DIR, `intent-${intentId}.json`);
}
