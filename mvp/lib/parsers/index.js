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
import * as pyParser from "./py.js";
import * as jupyterParser from "./jupyter.js";

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
  // stubbed languages — return BackendUnavailable
  go: stubBackend("go", "go list"),
  rust: stubBackend("rust", "rust-analyzer scip"),
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
    return p.parse(content, { filePath });
  } catch (err) {
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
