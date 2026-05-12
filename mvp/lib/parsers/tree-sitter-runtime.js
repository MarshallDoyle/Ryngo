/**
 * Tree-sitter runtime — Phase 5.1.0.
 *
 * Wraps the `tree-sitter` native bindings with a per-language cache,
 * a `.scm` query loader, and a small set of helpers the per-language
 * extractors (`ts-tree-sitter.js`, `py-tree-sitter.js`, …) reuse.
 *
 * Synchronous API. Tree-sitter native bindings parse synchronously
 * and we load grammars eagerly via `createRequire` so the per-file
 * dispatch in `parsers/index.js` can stay sync.
 *
 * Public API:
 *   getParser(lang)      ── cached Parser with the grammar loaded
 *   getQuery(lang, name) ── cached Query compiled from .scm source
 *   parse(lang, text)    ── parse, return root node (null if unavailable)
 *   matches(query, root) ── iterate matches, yield grouped captures
 *   isAvailable(lang)    ── does this language have a tree-sitter
 *                           backend installed?
 *
 * Languages registered today: "ts", "tsx", "js", "py". Adding a new
 * one means: install its npm grammar + extend GRAMMAR_LOADERS + drop
 * .scm files in `queries/<lang>/`.
 *
 * Feature flag: `RYNGO_PARSERS=regex` forces the legacy regex
 * extractor everywhere — `isAvailable` returns false for all
 * languages. Lets us ship this code with the flag-off default while
 * still smoke-testing tree-sitter end-to-end locally.
 */

import { promises as fsPromises, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERY_ROOT = path.join(__dirname, "queries");
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Grammar registry
// ---------------------------------------------------------------------------

/**
 * Lazy + safe grammar loader. Loads each grammar exactly once. If
 * the npm package is missing (e.g. the Cloud Run image was built
 * before this PR), returns null and the language degrades to regex.
 *
 * `tree-sitter-typescript` ships two grammars in one package, exposed
 * as `.typescript` and `.tsx` on the default export — we handle that
 * here so the public `resolveLanguage("tsx")` is one call.
 */
const GRAMMAR_LOADERS = {
  ts: () => safeRequire("tree-sitter-typescript")?.typescript ?? null,
  tsx: () => safeRequire("tree-sitter-typescript")?.tsx ?? null,
  js: () => safeRequire("tree-sitter-javascript") ?? null,
  py: () => safeRequire("tree-sitter-python") ?? null,
  go: () => safeRequire("tree-sitter-go") ?? null,
  rust: () => safeRequire("tree-sitter-rust") ?? null,
};

function safeRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Eager init — at module load
// ---------------------------------------------------------------------------

const ParserCtor = safeRequire("tree-sitter");
const grammarCache = new Map();

/**
 * Per-language flag semantics:
 *   - ts / tsx / js / py: the regex extractor already works. Treat the
 *     tree-sitter backend as opt-in (RYNGO_PARSERS=tree-sitter) until
 *     parser-parity is gated on the corpus.
 *   - go / rust: the previous floor was a stub (file nodes only).
 *     Tree-sitter is a strict upgrade with zero regression risk — use
 *     it whenever the grammar is installed, regardless of the flag.
 *     RYNGO_PARSERS=regex forces stubs back on (for emergency rollback
 *     only).
 */
function isLanguageEnabled(lang) {
  const flag = process.env.RYNGO_PARSERS;
  if (flag === "regex") return false; // emergency rollback for every lang
  if (flag === "tree-sitter") return true; // explicit opt-in everywhere
  // default: upgrade-only languages get tree-sitter; existing-regex
  // languages stay on regex until we flip the master switch.
  return lang === "go" || lang === "rust";
}

function resolveLanguage(lang) {
  if (!isLanguageEnabled(lang)) return null;
  if (!ParserCtor) return null;
  if (grammarCache.has(lang)) return grammarCache.get(lang);
  const loader = GRAMMAR_LOADERS[lang];
  if (!loader) {
    grammarCache.set(lang, null);
    return null;
  }
  const grammar = loader();
  grammarCache.set(lang, grammar);
  return grammar;
}

// ---------------------------------------------------------------------------
// Parser + Query caches
// ---------------------------------------------------------------------------

const parserCache = new Map(); // lang → Parser
const queryCache = new Map(); // `${lang}/${name}` → Query | null

export function getParser(lang) {
  const cached = parserCache.get(lang);
  if (cached) return cached;
  const grammar = resolveLanguage(lang);
  if (!grammar || !ParserCtor) return null;
  const parser = new ParserCtor();
  try {
    parser.setLanguage(grammar);
  } catch (err) {
    if (process.env.RYNGO_PARSER_DEBUG === "1") {
      console.warn(`tree-sitter setLanguage(${lang}) failed: ${err.message}`);
    }
    return null;
  }
  parserCache.set(lang, parser);
  return parser;
}

export function getQuery(lang, name) {
  const key = `${lang}/${name}`;
  if (queryCache.has(key)) return queryCache.get(key);
  const grammar = resolveLanguage(lang);
  if (!grammar || !ParserCtor) {
    queryCache.set(key, null);
    return null;
  }
  const dirLang = lang === "tsx" ? "ts" : lang;
  const queryPath = path.join(QUERY_ROOT, dirLang, `${name}.scm`);
  let source;
  try {
    source = readFileSync(queryPath, "utf8");
  } catch {
    queryCache.set(key, null);
    return null;
  }
  try {
    const Q = ParserCtor.Query;
    if (!Q) throw new Error("tree-sitter.Query not exposed");
    const query = new Q(grammar, source);
    queryCache.set(key, query);
    return query;
  } catch (err) {
    if (process.env.RYNGO_PARSER_DEBUG === "1") {
      console.warn(
        `tree-sitter query compile failed: ${queryPath} — ${err.message}`,
      );
    }
    queryCache.set(key, null);
    return null;
  }
}

/**
 * Parse `source` with the grammar for `lang`. Returns the root node
 * or null if the grammar isn't available.
 */
export function parse(lang, source) {
  const parser = getParser(lang);
  if (!parser) return null;
  const tree = parser.parse(source);
  return tree.rootNode;
}

/**
 * Iterate matches of a query against a root node. Yields a record
 * per match with captures grouped by name. Repeated capture names
 * collapse into an array.
 */
export function* matches(query, rootNode) {
  if (!query || !rootNode) return;
  for (const match of query.matches(rootNode)) {
    const captures = {};
    for (const cap of match.captures) {
      if (captures[cap.name] !== undefined) {
        if (!Array.isArray(captures[cap.name])) {
          captures[cap.name] = [captures[cap.name]];
        }
        captures[cap.name].push(cap.node);
      } else {
        captures[cap.name] = cap.node;
      }
    }
    yield { patternIndex: match.patternIndex, captures };
  }
}

export function isAvailable(lang) {
  return Boolean(resolveLanguage(lang));
}

export function status() {
  return {
    flag: process.env.RYNGO_PARSERS || "(default — go/rust on, others off)",
    nativeBindingLoaded: Boolean(ParserCtor),
    parsersInitialized: Array.from(parserCache.keys()),
    queriesCompiled: Array.from(queryCache.keys()).filter(
      (k) => queryCache.get(k) !== null,
    ),
    available: {
      ts: isAvailable("ts"),
      tsx: isAvailable("tsx"),
      js: isAvailable("js"),
      py: isAvailable("py"),
      go: isAvailable("go"),
      rust: isAvailable("rust"),
    },
  };
}

// ---------------------------------------------------------------------------
// Node helpers — shared by every language extractor
// ---------------------------------------------------------------------------

export function nodeText(node) {
  if (!node) return "";
  return node.text || "";
}

/** 1-based line. Tree-sitter is 0-based; Ryngo IR is 1-based. */
export function nodeLine(node) {
  if (!node) return 0;
  return (node.startPosition?.row ?? 0) + 1;
}

export function firstDescendantOfType(node, types) {
  if (!node) return null;
  const wanted = new Set(Array.isArray(types) ? types : [types]);
  const queue = [node];
  while (queue.length) {
    const n = queue.shift();
    if (wanted.has(n.type)) return n;
    for (const c of n.namedChildren) queue.push(c);
  }
  return null;
}

export function firstChildOfType(node, type) {
  if (!node) return null;
  for (const c of node.namedChildren) {
    if (c.type === type) return c;
  }
  return null;
}

// Re-export fsPromises so callers that need filesystem access from a
// shared place can grab it without adding their own node:fs import.
export { fsPromises };
