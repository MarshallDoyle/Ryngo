/**
 * String-name heuristic for the false-positive bound.
 *
 * Per `design/dead-code.md` §4.4: scan every `expression`-tier literal of
 * `kind: string` in the IR; build a single corpus; substring-search each
 * candidate-dead function name against it.
 *
 * A hit demotes a candidate from "definitively dead" (tier 1) to "probably
 * dead" (tier 2). This catches dictionary-dispatch / decorator-registered /
 * config-driven calls that the static analyzer cannot resolve.
 *
 * Stop list: short / generic names (`get`, `do`, `init`, ...) match almost
 * any non-trivial codebase; the heuristic is bypassed for them so they
 * remain tier 1 candidates by reachability alone.
 *
 * Corpus exclusions: OpenAPI / JSON corpora that mirror the schema's symbol
 * names would keep the entire codebase "probably-live" — we filter those by
 * module path before adding their literals.
 */

import type {
  IR,
  Node,
  ExpressionNode,
  ModuleNode,
  NodeId,
  LeafLiteral,
} from "../../ir/types.js";
import { isExpressionNode, isModuleNode, isLeafLiteral } from "../../ir/types.js";

/** Default short-name stop list per design §4.4.2. */
export const DEFAULT_SHORT_NAME_STOP_LIST = new Set<string>([
  "get",
  "set",
  "do",
  "go",
  "run",
  "init",
  "main",
  "new",
  "add",
  "del",
  "rm",
  "ok",
  "fn",
  "is",
  "to",
  "of",
  "as",
  "at",
]);

/** Module-path globs whose string literals are excluded from the corpus by default. */
export const DEFAULT_CORPUS_IGNORE_PATTERNS: readonly string[] = [
  "**/*.openapi.json",
  "**/*.openapi.yaml",
  "**/*.openapi.yml",
  "**/openapi.json",
  "**/openapi.yaml",
  "**/openapi.yml",
];

export interface StringCorpus {
  /** Concatenation of every accepted literal, NUL-separated. */
  buffer: string;
  /** For each candidate name match the literal that hit (debug aid). */
  literalCount: number;
}

export interface BuildCorpusOptions {
  /** Glob patterns matched against the literal's enclosing module path. */
  ignoreModulePatterns?: readonly string[];
  /** Extra raw text appended after the IR-derived corpus. */
  extraText?: readonly string[];
  /** Minimum substring length for short-name skipping (default 4). */
  minNameLength?: number;
  /** Stop list of names to never demote (default `DEFAULT_SHORT_NAME_STOP_LIST`). */
  stopList?: ReadonlySet<string>;
  /** Glob matcher; defaults to a tiny built-in. */
  matchGlob?: (pattern: string, path: string) => boolean;
}

/**
 * Build the literal corpus from the IR plus user-supplied extra text.
 *
 * The corpus is one giant NUL-separated string — fast to build, fast to
 * search via `String.prototype.includes`. We do not bother with a suffix-array
 * or Aho–Corasick here: substring-includes on a few-MB buffer is well under
 * the 100ms budget for the design's target repo size.
 */
export function buildLiteralCorpus(
  ir: IR,
  options: BuildCorpusOptions = {},
): StringCorpus {
  const ignore = options.ignoreModulePatterns ?? DEFAULT_CORPUS_IGNORE_PATTERNS;
  const matcher = options.matchGlob ?? defaultMatchGlob;

  // Index every node's enclosing module path so we can apply ignore globs.
  const modulePathByNodeId = computeModulePaths(ir);

  let buffer = "\0"; // leading NUL so `includes(name)` won't accidentally match a prefix
  let literalCount = 0;

  for (const n of ir.nodes) {
    if (!isExpressionNode(n)) continue;
    const expr = n as ExpressionNode;
    const leaf = expr.leaf;
    if (!leaf || !isLeafLiteral(leaf)) continue;
    const lit = leaf as LeafLiteral;
    if (typeof lit.value !== "string") continue;

    const path = modulePathByNodeId.get(n.id);
    if (path !== undefined && ignore.some((p) => matcher(p, path))) continue;

    buffer += lit.value;
    buffer += "\0";
    literalCount += 1;
  }

  if (options.extraText) {
    for (const t of options.extraText) {
      buffer += t;
      buffer += "\0";
    }
  }

  return { buffer, literalCount };
}

/**
 * For a given function name, decide whether the heuristic applies and (if so)
 * whether the corpus contains the name.
 *
 * Returns:
 *   - "skipped"  — name on the stop list / too short; do not demote.
 *   - "matched"  — name appears in the corpus; demote to tier 2.
 *   - "missing"  — name does not appear in the corpus; tier 1 stands.
 */
export type StringRefVerdict = "skipped" | "matched" | "missing";

export function checkName(
  name: string,
  corpus: StringCorpus,
  options: Pick<BuildCorpusOptions, "minNameLength" | "stopList"> = {},
): StringRefVerdict {
  const minLen = options.minNameLength ?? 4;
  const stop = options.stopList ?? DEFAULT_SHORT_NAME_STOP_LIST;
  if (!name) return "skipped";
  if (name.length < minLen) return "skipped";
  if (stop.has(name)) return "skipped";
  return corpus.buffer.includes(name) ? "matched" : "missing";
}

/** Resolve the module path enclosing each node. Same shape as in entry-points. */
function computeModulePaths(ir: IR): Map<NodeId, string> {
  const result = new Map<NodeId, string>();
  const byId = new Map<NodeId, Node>();
  for (const n of ir.nodes) byId.set(n.id, n);
  for (const n of ir.nodes) {
    let cur: Node | undefined = n;
    while (cur) {
      if (isModuleNode(cur)) {
        result.set(n.id, (cur as ModuleNode).path);
        break;
      }
      const parentId = (cur as Node & { parentId?: NodeId }).parentId;
      if (!parentId) break;
      cur = byId.get(parentId);
    }
  }
  return result;
}

/** Tiny built-in glob matcher. Local copy to avoid the entry-points <-> string-ref dep. */
function defaultMatchGlob(pattern: string, path: string): boolean {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (".+^$(){}|[]\\".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += "$";
  try {
    return new RegExp(re).test(path);
  } catch {
    return false;
  }
}
