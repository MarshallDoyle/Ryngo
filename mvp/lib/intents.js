/**
 * `.ryngo/intents/<id>.md` — one file per "I want this changed" marker.
 *
 * Each intent is markdown with a YAML-style frontmatter block. The
 * frontmatter is small and hand-rolled — no YAML lib needed.
 *
 *   ---
 *   id: 2026-05-09-extract-auth
 *   created: 2026-05-09
 *   status: open
 *   type: refactor
 *   ---
 *
 *   # Extract auth into its own service
 *
 *   ## What
 *   …
 *
 *   ## Affected nodes
 *   - file:src/auth/login.ts
 *
 *   ## Acceptance check (Ryngo verifies after the AI applies the change)
 *   - [ ] all 3 nodes appear under a new service
 *   …
 *
 * The right-click → "mark for refactor / delete / tests / extract" UI emits
 * a stub intent file that the user (or their AI) fills in.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ensureRepoDir,
  readMaybe,
  repoDir,
  todayISO,
  slugify,
} from "./storage.js";

const DIR = "intents";

const KIND_LABELS = {
  refactor: "Refactor",
  delete: "Delete",
  tests: "Add tests for",
  extract: "Extract",
  rename: "Rename",
};

export async function listIntents(repo) {
  const intentsDir = path.join(repoDir(repo), DIR);
  let files;
  try {
    files = await fs.readdir(intentsDir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const name of files) {
    if (!name.endsWith(".md")) continue;
    const text = await fs.readFile(path.join(intentsDir, name), "utf8");
    out.push({ id: name.replace(/\.md$/, ""), file: name, text });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export async function readIntent(repo, id) {
  return readMaybe(repo, path.join(DIR, `${id}.md`));
}

/**
 * Parse an intent file into its frontmatter + body + extracted node ids.
 * Returns null if the file isn't a recognisable Ryngo intent.
 */
export function parseIntent(text) {
  if (!text) return null;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fm) return null;
  const meta = {};
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  const body = text.slice(fm[0].length);
  // Affected nodes: take the frontmatter `node:` first, then any other ids
  // referenced in the body (so multi-node intents work too).
  const nodeRe = /\b(?:file|def|cell|pkg):[A-Za-z0-9._/#@:_-]+/g;
  const ids = new Set();
  if (meta.node) ids.add(meta.node);
  let m;
  while ((m = nodeRe.exec(body)) !== null) ids.add(m[0]);
  return { meta, nodeIds: [...ids], body };
}

/** Update only the `status:` field in the intent's frontmatter. */
export async function setStatus(repo, id, status) {
  const filePath = path.join(repoDir(repo), DIR, `${id}.md`);
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return false;
  }
  const next = /^status:.*$/m.test(text)
    ? text.replace(/^status:.*$/m, `status: ${status}`)
    : text.replace(/^---\n/, `---\nstatus: ${status}\n`);
  if (next === text) return false;
  await fs.writeFile(filePath, next, "utf8");
  return true;
}

/**
 * `{ [nodeId]: [{ id, kind }] }` — which intents touch each node, found by
 * scanning the body of each intent file for the first `(file|def|cell|pkg):…`
 * reference. Intents that touch multiple nodes show under each.
 */
export async function indexByNode(repo) {
  const list = await listIntents(repo);
  const out = {};
  for (const it of list) {
    const kindMatch = it.text.match(/^type:\s*(\w+)/m);
    const kind = kindMatch ? kindMatch[1] : "intent";
    // Only match valid id characters: alphanumerics, slashes, dots, hashes,
    // colons (for `pkg:node:fs`), at-signs (for `pkg:@scope/pkg`), hyphens,
    // and underscores. Excludes the unicode ellipsis used in template
    // placeholders like `file:…`.
    const re = /\b(?:file|def|cell|pkg):[A-Za-z0-9._/#@:_-]+/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(it.text)) !== null) {
      const nodeId = m[0];
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      if (!out[nodeId]) out[nodeId] = [];
      out[nodeId].push({ id: it.id, kind });
    }
  }
  return out;
}

export async function createIntent(repo, { kind, nodeId, nodeLabel }) {
  if (!kind || !KIND_LABELS[kind]) {
    throw new Error(
      `createIntent: kind must be one of ${Object.keys(KIND_LABELS).join("/")}`,
    );
  }
  if (!nodeId) {
    throw new Error("createIntent: nodeId is required");
  }
  const date = todayISO();
  const labelHint = nodeLabel || nodeIdToHint(nodeId);
  const id = `${date}-${kind}-${slugify(labelHint, 40)}`;

  const dir = await ensureRepoDir(repo);
  const file = path.join(dir, DIR, `${id}.md`);

  const body = renderIntent({ id, date, kind, nodeId, nodeLabel: labelHint });
  await fs.writeFile(file, body, "utf8");
  return { id, file: `${id}.md`, kind };
}

export async function updateIntentStatus(repo, id, status) {
  const filePath = path.join(repoDir(repo), DIR, `${id}.md`);
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return false;
  }
  const next = text.replace(/^status:.*$/m, `status: ${status}`);
  if (next === text) return false;
  await fs.writeFile(filePath, next, "utf8");
  return true;
}

function nodeIdToHint(nodeId) {
  // def:path/to/file.ts#name → "name" or "file.ts#name"
  // file:path/to/file.ts → "file.ts"
  // pkg:react → "react"
  // cell:foo.ipynb#3 → "foo.ipynb-cell-3"
  const colonAt = nodeId.indexOf(":");
  const tail = colonAt === -1 ? nodeId : nodeId.slice(colonAt + 1);
  const hashAt = tail.indexOf("#");
  if (hashAt === -1) {
    const segs = tail.split("/");
    return segs[segs.length - 1] || tail;
  }
  const before = tail.slice(0, hashAt);
  const after = tail.slice(hashAt + 1);
  const seg = before.split("/").slice(-1)[0] || before;
  return `${seg}-${after}`;
}

function renderIntent({ id, date, kind, nodeId, nodeLabel }) {
  const verb = KIND_LABELS[kind];
  return `---
id: ${id}
created: ${date}
status: open
type: ${kind}
node: ${nodeId}
---

# ${verb} \`${nodeLabel}\`

## What

> Replace this paragraph with your specific change. Be concrete: name
> the new structure you want, the old structure you want gone, or the
> specific behaviour the tests should cover.

## Affected nodes

- ${nodeId}

> Add more node ids here (file:… / def:… / cell:… / pkg:…) if this
> intent touches more than one node.

## Constraints (from \`.ryngo/rules.md\`)

> List any architectural rules the AI must honour while making this
> change. Leave blank if none apply.

## Acceptance check

> Ryngo will re-analyze the repo after the AI applies the change and
> auto-tick these boxes by comparing IRs.

- [ ] structural ${kind} of \`${nodeLabel}\` is reflected in the new IR
- [ ] no new violations of \`.ryngo/rules.md\`
- [ ] no new dead-code nodes introduced

## Notes for the agent

> Free-form context the LLM should know. Linked tickets, prior PRs,
> historical decisions, etc.
`;
}
