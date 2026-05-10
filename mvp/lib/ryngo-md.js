/**
 * Ryngo.md — per-repo manifest format (Phase 11.1).
 *
 * The user-facing source of truth for per-node comments and warning
 * suppressions. Parsed + serialized here; storage is in
 * lib/ryngo-md-store.js; the API is at /api/ryngo-md*.
 *
 * Format (markdown, human-editable):
 *
 *   # Ryngo
 *   > Per-repo manifest…
 *
 *   ## Comments
 *   ### def:src/auth.ts#login
 *   > handles refresh tokens
 *   > — marshall, 2026-05-10
 *
 *   ## Suppressions
 *   ### def:src/auth.ts#login
 *   - nested-loop · intentional brute force
 *   - recursion · tail-recursive
 *
 * Other ## sections (Connections / Expose / Flags) are preserved
 * verbatim on round-trip but not yet acted on.
 *
 * Round-trip property:
 *   parse(serialize(parse(x))) === parse(x)
 * for any input markdown. The unknown-section preservation is what
 * makes that hold for forward-compat: a future Connections section
 * the user wrote by hand survives an unrelated viewer write.
 */

const HEADER_BANNER =
  "> Per-repo manifest. Edit directly or via the Ryngo viewer; both\n" +
  "> round-trip cleanly. The Ryngo MCP server reads this file when\n" +
  "> your AI agent queries the codebase.\n" +
  ">\n" +
  "> Stable node ids the sections below reference:\n" +
  ">   file:<path>   def:<path>#<name>   cell:<path>#<index>\n" +
  ">   pkg:<name>    route:<path>#<METHOD>:<path>   db-model:<name>\n" +
  ">   gql-type:<name>   infra-resource:<type>.<name>";

const KNOWN_SECTIONS = new Set([
  "Comments",
  "Suppressions",
  "Connections",
  "Expose",
  "Flags",
]);

/**
 * Parse a Ryngo.md text into a state object.
 * @param {string} text
 * @returns {{
 *   comments: Map<string, Array<{ text: string, author?: string, date?: string }>>,
 *   suppressions: Map<string, Array<{ kind: string, reason?: string, author?: string, date?: string }>>,
 *   unknownSections: Array<{ name: string, body: string }>
 * }}
 */
export function parse(text) {
  const state = {
    comments: new Map(),
    suppressions: new Map(),
    unknownSections: [],
  };
  if (!text || typeof text !== "string") return state;

  const sections = splitSections(text);
  for (const { name, body } of sections) {
    if (name === "Comments") {
      parseCommentsSection(body, state.comments);
    } else if (name === "Suppressions") {
      parseSuppressionsSection(body, state.suppressions);
    } else if (KNOWN_SECTIONS.has(name)) {
      // Reserved for v2 (Connections / Expose / Flags) — preserve verbatim.
      state.unknownSections.push({ name, body });
    } else {
      // User's freeform sections — preserved untouched.
      state.unknownSections.push({ name, body });
    }
  }
  return state;
}

/**
 * Serialize a state object back to markdown. Emits Comments and
 * Suppressions in canonical order, then any preserved unknown sections.
 *
 * @param {ReturnType<typeof parse>} state
 * @returns {string}
 */
export function serialize(state) {
  const out = [];
  out.push("# Ryngo", "");
  out.push(HEADER_BANNER, "");
  out.push(serializeComments(state.comments));
  out.push(serializeSuppressions(state.suppressions));
  for (const section of state.unknownSections || []) {
    if (section.name === "Comments" || section.name === "Suppressions") continue;
    out.push(`## ${section.name}`);
    if (section.body && section.body.trim()) out.push(section.body.trimEnd());
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Append a comment to the given node id, mutating + returning state. */
export function addComment(state, { nodeId, text, author, date }) {
  if (!nodeId || !text) return state;
  if (!state.comments.has(nodeId)) state.comments.set(nodeId, []);
  state.comments.get(nodeId).push({
    text: String(text).trim(),
    author: author || undefined,
    date: date || todayISO(),
  });
  return state;
}

/** Add a suppression for a (nodeId, kind) — idempotent (no duplicates). */
export function addSuppression(state, { nodeId, kind, reason, author, date }) {
  if (!nodeId || !kind) return state;
  if (!state.suppressions.has(nodeId)) state.suppressions.set(nodeId, []);
  const list = state.suppressions.get(nodeId);
  if (list.some((s) => s.kind === kind)) return state; // already suppressed
  list.push({
    kind,
    reason: reason ? String(reason).trim() : undefined,
    author: author || undefined,
    date: date || todayISO(),
  });
  return state;
}

/** Remove a suppression. Returns true if anything was removed. */
export function removeSuppression(state, nodeId, kind) {
  const list = state.suppressions.get(nodeId);
  if (!list) return false;
  const before = list.length;
  const filtered = list.filter((s) => s.kind !== kind);
  if (filtered.length === 0) state.suppressions.delete(nodeId);
  else state.suppressions.set(nodeId, filtered);
  return filtered.length < before;
}

/** Boolean lookup used by the warnings filter. */
export function isSuppressed(state, nodeId, kind) {
  const list = state?.suppressions?.get(nodeId);
  return !!list && list.some((s) => s.kind === kind);
}

/** Convenience: render the comments section as the API response shape. */
export function commentsByNode(state) {
  const out = {};
  for (const [nodeId, list] of state.comments) {
    out[nodeId] = list.map((c) => ({ ...c }));
  }
  return out;
}

/** Convenience: render suppressions as a flat lookup. */
export function suppressionsByNode(state) {
  const out = {};
  for (const [nodeId, list] of state.suppressions) {
    out[nodeId] = list.map((s) => ({ ...s }));
  }
  return out;
}

/** Build an empty state — used to seed a brand-new Ryngo.md. */
export function emptyState() {
  return {
    comments: new Map(),
    suppressions: new Map(),
    unknownSections: [],
  };
}

// ---------------------------------------------------------------------------
// Section splitter
// ---------------------------------------------------------------------------

function splitSections(text) {
  // Strip the title line and intro blockquote — anything before the
  // first `## ` heading is preamble we re-emit on serialize.
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  let currentName = null;
  let currentBody = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && !line.startsWith("###")) {
      if (currentName !== null) {
        sections.push({ name: currentName, body: currentBody.join("\n").trim() });
      }
      currentName = m[1];
      currentBody = [];
    } else if (currentName !== null) {
      currentBody.push(line);
    }
  }
  if (currentName !== null) {
    sections.push({ name: currentName, body: currentBody.join("\n").trim() });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Comments parser + serializer
// ---------------------------------------------------------------------------

function parseCommentsSection(body, out) {
  if (!body) return;
  // Each "### <nodeId>" starts a comment block. Body lines are
  // blockquote (`>`) lines until the next ###. Trailing `> — author, date`
  // is parsed off if present.
  const blocks = splitByNodeHeading(body);
  for (const { nodeId, lines } of blocks) {
    const entries = collectCommentEntries(lines);
    if (!entries.length) continue;
    if (!out.has(nodeId)) out.set(nodeId, []);
    out.get(nodeId).push(...entries);
  }
}

function collectCommentEntries(bodyLines) {
  // A single entry is a contiguous run of blockquote lines. A blank
  // line separates entries.
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
    const text = lines.join("\n").trim();
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
    if (/^>/.test(line)) {
      buf.push(line);
    } else if (!line.trim()) {
      flush();
    }
  }
  flush();
  return entries;
}

function serializeComments(comments) {
  if (!comments.size) {
    return "## Comments\n\n_No comments yet — right-click any node in the Ryngo viewer to add one._\n";
  }
  const out = ["## Comments", ""];
  const sortedIds = [...comments.keys()].sort();
  for (const nodeId of sortedIds) {
    out.push(`### ${nodeId}`);
    const entries = comments.get(nodeId);
    for (const entry of entries) {
      const text = entry.text.split("\n").map((l) => `> ${l}`).join("\n");
      out.push(text);
      if (entry.author || entry.date) {
        const tail = [];
        if (entry.author) tail.push(entry.author);
        if (entry.date) tail.push(entry.date);
        out.push(`> — ${tail.join(", ")}`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Suppressions parser + serializer
// ---------------------------------------------------------------------------

function parseSuppressionsSection(body, out) {
  if (!body) return;
  const blocks = splitByNodeHeading(body);
  for (const { nodeId, lines } of blocks) {
    const list = [];
    for (const line of lines) {
      const m = /^-\s+([\w-]+)(?:\s*·\s*(.+))?$/.exec(line.trim());
      if (m) {
        const reason = m[2] ? m[2].trim() : undefined;
        const ent = { kind: m[1] };
        if (reason) {
          // Optional trailing "(— author, date)" attribution
          const attr = /^(.+?)\s+\(—\s*(.+?),\s*(\d{4}-\d{2}-\d{2})\)\s*$/.exec(
            reason,
          );
          if (attr) {
            ent.reason = attr[1].trim();
            ent.author = attr[2].trim();
            ent.date = attr[3];
          } else {
            ent.reason = reason;
          }
        }
        list.push(ent);
      }
    }
    if (list.length) {
      if (!out.has(nodeId)) out.set(nodeId, []);
      out.get(nodeId).push(...list);
    }
  }
}

function serializeSuppressions(suppressions) {
  if (!suppressions.size) {
    return "## Suppressions\n\n_No suppressions. Click the ⚠ on any function in the viewer to dismiss a warning._\n";
  }
  const out = ["## Suppressions", ""];
  const sortedIds = [...suppressions.keys()].sort();
  for (const nodeId of sortedIds) {
    out.push(`### ${nodeId}`);
    for (const s of suppressions.get(nodeId)) {
      let line = `- ${s.kind}`;
      if (s.reason) line += ` · ${s.reason}`;
      if (s.author && s.date) line += ` (— ${s.author}, ${s.date})`;
      out.push(line);
    }
    out.push("");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function splitByNodeHeading(body) {
  const lines = body.split("\n");
  const blocks = [];
  let currentId = null;
  let buf = [];
  for (const line of lines) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (currentId !== null) blocks.push({ nodeId: currentId, lines: buf });
      currentId = m[1].trim();
      buf = [];
    } else if (currentId !== null) {
      buf.push(line);
    }
  }
  if (currentId !== null) blocks.push({ nodeId: currentId, lines: buf });
  return blocks;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
