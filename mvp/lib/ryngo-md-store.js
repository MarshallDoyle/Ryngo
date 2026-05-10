/**
 * Ryngo.md storage layer (Phase 11.2).
 *
 * Reads + writes the per-repo manifest at
 *   mvp/.ryngo/<owner>__<repo>/Ryngo.md
 *
 * The hosted Ryngo can't write to the user's actual GitHub repo;
 * this server-side mirror is what persists between viewer sessions.
 * The viewer's "View Ryngo.md" UI hands the rendered text back so
 * the user can copy + commit it manually.
 *
 * On first read for a repo that has the legacy `.ryngo/<slug>/annotations.md`
 * but no `Ryngo.md` yet, we fold every existing annotation into a
 * fresh state and write it through. The legacy file stays on disk
 * (read-only) for one release cycle; later phases delete it.
 */

import { readMaybe, writeFile, repoSlug, ensureRepoDir } from "./storage.js";
import {
  parse,
  serialize,
  addComment,
  addSuppression,
  removeSuppression,
  emptyState,
} from "./ryngo-md.js";

const RYNGO_MD = "Ryngo.md";
const LEGACY_ANNOTATIONS = "annotations.md";

/**
 * Read the parsed manifest for a repo. If `Ryngo.md` doesn't exist
 * but the legacy `annotations.md` does, migrate on the fly and
 * persist the new file before returning.
 */
export async function read(repo) {
  const raw = await readMaybe(repo, RYNGO_MD);
  if (raw) return { state: parse(raw), raw };
  // Legacy migration path.
  const legacy = await readMaybe(repo, LEGACY_ANNOTATIONS);
  if (legacy && legacy.trim()) {
    const state = migrateLegacyAnnotations(legacy);
    await write(repo, state);
    const newRaw = serialize(state);
    return { state, raw: newRaw, migratedFromLegacy: true };
  }
  // Fresh repo — return an empty state but DON'T write to disk yet
  // (no point creating a file the user hasn't asked for).
  return { state: emptyState(), raw: "" };
}

/**
 * Write a parsed state back to disk. Returns the serialized text.
 * Atomic: serializes first, then writes via lib/storage.js helpers.
 */
export async function write(repo, state) {
  await ensureRepoDir(repo);
  const text = serialize(state);
  await writeFile(repo, RYNGO_MD, text);
  return text;
}

/** Append a comment + persist. */
export async function appendComment(repo, { nodeId, text, author, date }) {
  const { state } = await read(repo);
  addComment(state, { nodeId, text, author, date });
  const raw = await write(repo, state);
  return { state, raw };
}

/** Add a suppression + persist (idempotent). */
export async function appendSuppression(repo, { nodeId, kind, reason, author, date }) {
  const { state } = await read(repo);
  addSuppression(state, { nodeId, kind, reason, author, date });
  const raw = await write(repo, state);
  return { state, raw };
}

/** Remove a suppression + persist. Returns whether anything was removed. */
export async function dropSuppression(repo, nodeId, kind) {
  const { state } = await read(repo);
  const changed = removeSuppression(state, nodeId, kind);
  if (changed) await write(repo, state);
  return { state, changed };
}

/**
 * Replace the full file contents from a raw markdown string. Used by
 * the PUT /api/ryngo-md endpoint when the user has hand-edited the
 * manifest in their editor and wants to push the new version through
 * the viewer.
 */
export async function replaceRaw(repo, raw) {
  const state = parse(raw);
  await write(repo, state);
  return { state, raw: serialize(state) };
}

/**
 * Slug helper exposed so callers (server.js / mcp.js) can echo the
 * canonical repo identifier back to the user.
 */
export { repoSlug };

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/**
 * Translate the old append-only annotations.md format into a parsed
 * Ryngo.md state. The legacy format:
 *
 *   ## node: <id>
 *   > "comment text"
 *   > — author, date
 *
 * Multiple entries per node id are concatenated under the same
 * `### <id>` heading in the new format.
 */
export function migrateLegacyAnnotations(legacyText) {
  const state = emptyState();
  if (!legacyText) return state;
  const lines = legacyText.split("\n");
  let currentId = null;
  let buf = [];
  const flush = () => {
    if (!currentId) return;
    const entries = collectLegacyEntries(buf);
    for (const e of entries) {
      addComment(state, {
        nodeId: currentId,
        text: e.text,
        author: e.author,
        date: e.date,
      });
    }
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+node:\s*(\S+)\s*$/.exec(line);
    if (m) {
      flush();
      currentId = m[1];
    } else if (currentId !== null) {
      buf.push(line);
    }
  }
  flush();
  return state;
}

function collectLegacyEntries(bodyLines) {
  // Same shape as the Ryngo.md comments parser: blockquote-only lines,
  // separated by blank lines. The legacy format also puts comments in
  // double-quotes; strip those when the entire text is one quoted run.
  const entries = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const lines = buf.map((l) => l.replace(/^>\s?/, ""));
    let attribution = null;
    const last = lines[lines.length - 1];
    const m = /^—\s*(.+?),\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(last);
    if (m) {
      attribution = { author: m[1].trim(), date: m[2] };
      lines.pop();
    }
    let text = lines.join("\n").trim();
    // Strip surrounding double-quotes if the whole comment is one
    // quoted phrase (canonical legacy shape).
    if (/^".*"$/s.test(text)) text = text.slice(1, -1).trim();
    if (text) {
      entries.push({
        text,
        author: attribution?.author,
        date: attribution?.date,
      });
    }
    buf = [];
  };
  for (const line of bodyLines) {
    if (/^>/.test(line)) buf.push(line);
    else if (!line.trim()) flush();
  }
  flush();
  return entries;
}
