/**
 * Parser registry — Tier 0 of the universal-compiler pipeline.
 *
 * Each language declares one parser module that exports
 *   parse(text, opts) → ParsedFile
 *
 * ParsedFile shape:
 *   {
 *     lang:     'ts' | 'py' | 'jupyter' | 'go' | 'rust' | ...
 *     backend:  'regex' | 'tree-sitter' | 'go-list' | 'scip-rust' | ...
 *     imports:  [{ spec, bindings, isRelative }]
 *     defs:     [{ name, kind, line, params?, returnType?, members? }]
 *     calls:    [{ from, to, fullTarget }]
 *     cells?:   [{ index, source, label, imports, calls }]   // notebooks
 *     diagnostics?: [string]
 *   }
 *
 * Where:
 *   params     = [{ name, typeDisplay?, optional?, default?, rest? }]
 *   returnType = { display: string } | null
 *   members    = { methods: [...defs], fields: [{ name, typeDisplay?, default? }],
 *                  baseClasses: string[] }
 *
 * The shape is additive: every consumer downstream (resolver, adapters, viewer,
 * diff) keys off `id` and falls back gracefully when extra fields are absent.
 *
 * Backend resolution order per language:
 *   1. The strongest backend whose dependencies are present.
 *   2. Fallback: regex (always available).
 *
 * For Go/Rust/Java/C# we expose stubs that throw `BackendUnavailableError` so
 * the orchestrator can degrade gracefully (and report the missing toolchain to
 * the user) instead of producing silent empty results.
 */
import path from "node:path";
import * as tsParser from "./ts.js";
import * as tsTreeSitterParser from "./ts-tree-sitter.js";
import * as pyParser from "./py.js";
import * as pyTreeSitterParser from "./py-tree-sitter.js";
import * as goTreeSitterParser from "./go-tree-sitter.js";
import * as rustTreeSitterParser from "./rust-tree-sitter.js";
import * as jupyterParser from "./jupyter.js";
import { isAvailable as treeSitterAvailable } from "./tree-sitter-runtime.js";
import { detectAstWarnings } from "../warnings-ast.js";

const LANG_BY_EXT = {
  // tier-0 first-class
  ".ts": "ts",
  ".tsx": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".py": "py",
  ".ipynb": "jupyter",
  // tier-0 stubs (parser exists, backend not installed)
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".kt": "kotlin",
  ".swift": "swift",
};

const PARSERS = {
  ts: tsParser,
  py: pyParser,
  jupyter: jupyterParser,
  // tree-sitter backed (Phase 5.4 / 5.5). The dispatcher in
  // parseFile routes Go and Rust files to the tree-sitter extractors
  // directly when the grammar is available, so these stub entries
  // act as the regex floor + ultimate fallback when the grammar
  // failed to load.
  go: stubBackend("go", "tree-sitter-go"),
  rust: stubBackend("rust", "tree-sitter-rust"),
  // stubbed languages — return BackendUnavailable
  java: stubBackend("java", "scip-java"),
  ruby: stubBackend("ruby", "tree-sitter-ruby (not bundled)"),
  csharp: stubBackend("csharp", "scip-csharp"),
  c: stubBackend("c", "scip-clang"),
  cpp: stubBackend("cpp", "scip-clang"),
  kotlin: stubBackend("kotlin", "tree-sitter-kotlin (not bundled)"),
  swift: stubBackend("swift", "tree-sitter-swift (not bundled)"),
};

export function detectLang(filePath) {
  return LANG_BY_EXT[path.extname(filePath).toLowerCase()] || null;
}

export function isAnalyzable(filePath) {
  return PARSERS[detectLang(filePath)]?.parse !== undefined;
}

/**
 * Parse a file. Returns a ParsedFile or null when the language has no parser.
 * Stub backends emit a diagnostic + empty result so the IR builder can keep
 * going (the file still appears as a node, it just has no inner structure).
 */
export function parseFile(filePath, content) {
  const lang = detectLang(filePath);
  if (!lang) return null;
  const p = PARSERS[lang];
  if (!p?.parse) {
    return {
      lang,
      backend: "stub",
      imports: [],
      defs: [],
      calls: [],
      diagnostics: [`no parser for language ${lang}`],
    };
  }
  try {
    // Phase 5.1.1 — for TS/JS files, prefer the tree-sitter extractor
    // when its grammar loaded successfully and the env flag allows
    // (RYNGO_PARSERS !== "regex"). On any tree-sitter parse failure
    // we fall back to the regex extractor for that file — the IR
    // builder shouldn't ever see an empty parse just because the new
    // backend choked on syntax it doesn't know.
    let parsed = null;
    if (lang === "ts") {
      const tsLang = treeSitterLangForPath(filePath);
      if (tsLang && treeSitterAvailable(tsLang)) {
        parsed = tsTreeSitterParser.parse(content, tsLang);
      }
    } else if (lang === "py" && treeSitterAvailable("py")) {
      parsed = pyTreeSitterParser.parse(content);
    } else if (lang === "go" && treeSitterAvailable("go")) {
      parsed = goTreeSitterParser.parse(content);
    } else if (lang === "rust" && treeSitterAvailable("rust")) {
      parsed = rustTreeSitterParser.parse(content);
    }
    // Either no strong backend was tried or it returned null; fall
    // through to the regex floor.
    if (!parsed) parsed = p.parse(content, { filePath });
    // Phase 10.warning-unlock — AST-based warnings layered on top of
    // the regex-body warnings already attached to defs. This call is
    // safe to make regardless of which backend produced `parsed`;
    // it's purely additive and a no-op when no grammar is available.
    attachAstWarnings(parsed, content, lang, filePath);
    return parsed;
  } catch (err) {
    // If the strong backend threw, try the regex floor once before
    // we give up. Logs the error so the corpus harness can flag a
    // backend regression.
    if (lang === "ts" || lang === "py" || lang === "go" || lang === "rust") {
      try {
        const out = p.parse(content, { filePath });
        if (out) {
          out.diagnostics = [
            ...(out.diagnostics || []),
            `tree-sitter-${lang} threw, fell back to regex: ${err.message || err}`,
          ];
          return out;
        }
      } catch {
        /* both threw — return error result below */
      }
    }
    return {
      lang,
      backend: "error",
      imports: [],
      defs: [],
      calls: [],
      diagnostics: [`parser ${lang} threw: ${err.message || err}`],
    };
  }
}

/**
 * Pick the tree-sitter grammar key for a given filepath. We dispatch
 * by extension so `.tsx` uses the tsx grammar (with JSX), `.jsx` uses
 * tsx too (closest fit for the JS+JSX combination), `.js`/`.mjs`/.cjs`
 * use the js grammar, and `.ts` uses the typescript grammar.
 */
/**
 * Layer AST-based warnings (await-in-loop, unreachable-code,
 * mutation-of-param, switch-without-default, function-defined-in-loop,
 * unhandled-promise-rejection — see `mvp/lib/warnings-ast.js`) on
 * top of whatever `parsed.defs` already has. Mutates in place. Pure
 * no-op when the grammar isn't loadable or there are no defs.
 */
function attachAstWarnings(parsed, content, lang, filePath) {
  if (!parsed?.defs?.length) return;
  // Only TS and Python have AST warning sets today. Go/Rust will get
  // their own when the catalog calls for them.
  if (lang !== "ts" && lang !== "py") return;
  const grammarLang = lang === "py" ? "py" : treeSitterLangForPath(filePath);
  if (!grammarLang) return;
  let astWarnings;
  try {
    astWarnings = detectAstWarnings(content, grammarLang, parsed.defs);
  } catch {
    // AST warnings are best-effort. A parse failure or query bug
    // shouldn't break the extractor pipeline.
    return;
  }
  if (!astWarnings?.length) return;
  // Merge by def name. The regex/tree-sitter extractor already put
  // its own warnings on the def; we append the AST-discovered ones,
  // deduping by `kind` so re-runs don't multiply.
  const byName = new Map();
  for (const def of parsed.defs) byName.set(def.name, def);
  for (const w of astWarnings) {
    const def = byName.get(w.defName);
    if (!def) continue;
    if (!def.warnings) def.warnings = [];
    if (def.warnings.some((x) => x.kind === w.kind)) continue;
    def.warnings.push({
      kind: w.kind,
      severity: w.severity,
      message: w.message,
    });
  }
}

function treeSitterLangForPath(filePath) {
  // Both JS and TS files use the tree-sitter-typescript grammar. The
  // TS grammar is a strict superset of JS syntax, so the same query
  // patterns work for both — no need to maintain separate
  // queries/js/*.scm files. Per-extension dispatch picks the right
  // variant (typescript vs tsx) so JSX files get JSX support.
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":  return "ts";
    case ".tsx": return "tsx";
    case ".jsx": return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs": return "ts";
    default:     return null;
  }
}

function stubBackend(langName, requiredTool) {
  return {
    parse() {
      return {
        lang: langName,
        backend: "stub",
        imports: [],
        defs: [],
        calls: [],
        diagnostics: [
          `${langName} support requires ${requiredTool}; falling back to file-only node`,
        ],
      };
    },
  };
}

export const __PARSERS_FOR_TEST = PARSERS;
