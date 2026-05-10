/**
 * Ryngo annotation storage — directory layout and slug helpers.
 *
 * For the MVP, annotations live SERVER-SIDE in `mvp/.ryngo/<owner>__<repo>/`.
 * They do NOT roundtrip to the user's git repo automatically (that's a later
 * "commit annotations to GitHub" feature). This is good enough to demo the
 * LLM loop end-to-end: user marks → file written → AI reads.
 *
 *   mvp/.ryngo/
 *   └── karpathy__autoresearch/
 *       ├── annotations.md
 *       ├── regions.json
 *       ├── rules.md
 *       ├── wires.md
 *       ├── intents/
 *       │   └── 2026-05-09-extract-auth.md
 *       └── (cart-*.md ephemeral, snapshots/ later)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RYNGO_ROOT = path.resolve(__dirname, "..", ".ryngo");

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

export function repoSlug(repo) {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    throw new Error(`Invalid repo: "${repo}" (expected owner/name)`);
  }
  return repo.replace("/", "__");
}

export function repoDir(repo) {
  return path.join(RYNGO_ROOT, repoSlug(repo));
}

export async function ensureRepoDir(repo) {
  const dir = repoDir(repo);
  await fs.mkdir(path.join(dir, "intents"), { recursive: true });
  return dir;
}

/** Read a file from the repo's `.ryngo/` dir; returns `''` if it doesn't exist. */
export async function readMaybe(repo, relPath) {
  try {
    return await fs.readFile(path.join(repoDir(repo), relPath), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

/** Read a JSON file from the repo's `.ryngo/` dir; returns `fallback` if missing or unparseable. */
export async function readJson(repo, relPath, fallback) {
  const text = await readMaybe(repo, relPath);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export async function writeFile(repo, relPath, content) {
  await ensureRepoDir(repo);
  const full = path.join(repoDir(repo), relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

export async function writeJson(repo, relPath, data) {
  return writeFile(repo, relPath, JSON.stringify(data, null, 2) + "\n");
}

export function todayISO() {
  return new Date().toISOString().split("T")[0];
}

/** Slugify a free-form string for filenames: lowercase, dashes, no special chars. */
export function slugify(s, max = 40) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "intent";
}
