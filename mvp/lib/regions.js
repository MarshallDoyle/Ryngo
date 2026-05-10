/**
 * `.ryngo/regions.json` — named subgraphs, populated by the lasso UI.
 *
 *   {
 *     "schemaVersion": 1,
 *     "regions": [
 *       { "id": "auth", "label": "Auth subsystem", "nodes": [...], "color": "#22c55e" }
 *     ]
 *   }
 *
 * Plan called for `regions.yaml`; we use JSON to avoid pulling in a YAML
 * parser for one file. The shape is the same and an LLM reading raw JSON
 * has no trouble with it. We can convert to YAML later if a user
 * specifically wants `.yaml`.
 */
import { readJson, writeJson, slugify } from "./storage.js";

const FILE = "regions.json";

function emptyDoc() {
  return { schemaVersion: 1, regions: [] };
}

export async function read(repo) {
  return await readJson(repo, FILE, emptyDoc());
}

export async function listRegions(repo) {
  const doc = await read(repo);
  return doc.regions || [];
}

export async function addRegion(repo, { label, nodes, color }) {
  if (!label || typeof label !== "string") {
    throw new Error("addRegion: `label` is required");
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("addRegion: `nodes` must be a non-empty array");
  }
  const doc = await read(repo);
  const id = uniqueId(doc.regions, slugify(label));
  const region = {
    id,
    label,
    nodes: [...new Set(nodes)],
    color: color || "#22c55e",
  };
  doc.regions = [...doc.regions, region];
  await writeJson(repo, FILE, doc);
  return region;
}

export async function deleteRegion(repo, id) {
  const doc = await read(repo);
  const before = doc.regions.length;
  doc.regions = doc.regions.filter((r) => r.id !== id);
  if (doc.regions.length === before) return false;
  await writeJson(repo, FILE, doc);
  return true;
}

function uniqueId(existing, base) {
  const taken = new Set(existing.map((r) => r.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
