/**
 * Entry-point aggregation for dead-code reachability.
 *
 * Per `design/dead-code.md` §1–§2: an entry point is any IR node that seeds
 * the forward reachability traversal. The full set is the union of
 * auto-detected entries (heuristics that look at the IR + repo manifest)
 * and user-declared entries from `.codegraph.yml#entryPoints.include`,
 * minus anything matched by `entryPoints.exclude`.
 *
 * This module is a *pure* function of (IR, config). Adapters do their own
 * detection upstream (HTTP routes are emitted as `http-route` edges; framework
 * pages live in adapter outputs); we simply aggregate what's already in the IR
 * and overlay the user's overrides.
 */

import type {
  IR,
  Node,
  FunctionNode,
  ModuleNode,
  HttpRouteEdge,
  NodeId,
  Diagnostic,
} from "../../ir/types.js";
import {
  isFunctionNode,
  isModuleNode,
  isHttpRouteEdge,
} from "../../ir/types.js";
import type {
  EntryPointInclude,
  EntryPointExclude,
  CodegraphConfig,
} from "../../config/types.js";

/** Reasons an entry can be flagged. The set is intentionally small —
 *  surface enough to debug "why is this dead?", not to taxonomize. */
export type EntryKind =
  | "http-route"
  | "cli-bin"
  | "library-export"
  | "test"
  | "framework-page"
  | "framework-component"
  | "main-module"
  | "lifecycle-hook"
  | "worker"
  | "user-declared"
  | `x-${string}`;

export interface EntryPointRef {
  nodeId: NodeId;
  kind: EntryKind;
  /** "auto:<detector>" for auto-detected; "config:include[N]" for user-declared. */
  source: string;
  label?: string;
}

export interface CollectEntryPointsResult {
  entries: EntryPointRef[];
  diagnostics: Diagnostic[];
}

// Test-path patterns. Substring-matched on the module path. Cheap and good
// enough at this layer — adapters/CI can refine later.
const TEST_PATH_HINTS = [
  ".test.",
  ".spec.",
  "/__tests__/",
  "/tests/",
  "_test.go",
  "test_",
];

// Framework-page filename markers (Next.js / SvelteKit / Remix). Conservative.
const PAGE_BASENAME_PREFIXES = [
  "page.",
  "layout.",
  "loading.",
  "error.",
  "not-found.",
  "route.",
  "+page.",
  "+layout.",
  "+server.",
  "middleware.",
];

// Worker-file markers.
const WORKER_BASENAME_PATTERNS = [".worker.", "/sw.", "service-worker."];

// Module path markers for Python/Go main entry points.
const MAIN_MODULE_HINTS = ["__main__", "/cmd/"];

const NODE_LIFECYCLE_SCRIPTS = new Set([
  "prepare",
  "postinstall",
  "preinstall",
  "prepublishOnly",
  "postpublish",
  "start",
  "build",
]);

function isTestModulePath(path: string): boolean {
  for (const hint of TEST_PATH_HINTS) {
    if (path.includes(hint)) return true;
  }
  return false;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function isFrameworkPagePath(path: string): boolean {
  const b = basename(path);
  for (const pre of PAGE_BASENAME_PREFIXES) {
    if (b.startsWith(pre)) return true;
  }
  // Next.js `pages/**/*.{ts,tsx,js,jsx}` excluding `_*`
  if (path.includes("/pages/") && !b.startsWith("_")) {
    return /\.(tsx?|jsx?)$/.test(b);
  }
  // Remix `routes/**`
  if (path.includes("/routes/") && /\.(tsx?|jsx?)$/.test(b)) return true;
  return false;
}

function isWorkerPath(path: string): boolean {
  for (const m of WORKER_BASENAME_PATTERNS) {
    if (path.includes(m)) return true;
  }
  return false;
}

function isMainModulePath(path: string): boolean {
  for (const hint of MAIN_MODULE_HINTS) {
    if (path.includes(hint)) return true;
  }
  return false;
}

/**
 * Auto-detect entry points from the IR alone.
 *
 * Adapters emit `http-route` edges, framework-page modules (per their path
 * convention), test-file modules, etc. We do *not* re-parse `package.json` /
 * `pyproject.toml` here — that's the adapter's job (see §1.3 in the design).
 * Anything declared in those manifests but not yet lifted to the IR must be
 * declared via `entryPoints.include` in the user config.
 */
export function detectAutoEntries(ir: IR): EntryPointRef[] {
  const out: EntryPointRef[] = [];
  const seen = new Set<NodeId>();

  // 1. http-route entries: any function that is the source of an http-route edge.
  for (const e of ir.edges) {
    if (!isHttpRouteEdge(e)) continue;
    const src = e.sourceId;
    if (seen.has(src)) continue;
    seen.add(src);
    out.push({
      nodeId: src,
      kind: "http-route",
      source: `auto:http-route${(e as HttpRouteEdge).framework ? ":" + (e as HttpRouteEdge).framework : ""}`,
      label: (e as HttpRouteEdge).method
        ? `${(e as HttpRouteEdge).method} route`
        : "http route",
    });
  }

  // 2. Path-based detection on modules: tests, framework pages, workers, main.
  //    For test modules we add the *module* node itself (its closure is "live"
  //    via containment + its body's call edges). Same for framework-page and
  //    worker modules — they're loaded by the framework, so the module node is
  //    the root.
  for (const n of ir.nodes) {
    if (!isModuleNode(n)) continue;
    const m = n as ModuleNode;
    const path = m.path;

    if (isTestModulePath(path)) {
      pushOnce(out, seen, {
        nodeId: m.id,
        kind: "test",
        source: "auto:test-path",
        label: `test: ${path}`,
      });
      continue;
    }
    if (isFrameworkPagePath(path)) {
      pushOnce(out, seen, {
        nodeId: m.id,
        kind: "framework-page",
        source: "auto:framework-page",
        label: `page: ${path}`,
      });
      continue;
    }
    if (isWorkerPath(path)) {
      pushOnce(out, seen, {
        nodeId: m.id,
        kind: "worker",
        source: "auto:worker",
        label: `worker: ${path}`,
      });
      continue;
    }
    if (isMainModulePath(path)) {
      pushOnce(out, seen, {
        nodeId: m.id,
        kind: "main-module",
        source: "auto:main-module",
        label: `main: ${path}`,
      });
    }
  }

  // 3. Function-level main entry points: any exported function literally named
  //    `main` (Go, Rust binary entry, Python `if __name__ == "__main__"` blocks
  //    that the adapter emitted as a function). Conservative — gated by
  //    `exported` to avoid grabbing nested helpers.
  for (const n of ir.nodes) {
    if (!isFunctionNode(n)) continue;
    if (n.name === "main" && n.exported) {
      pushOnce(out, seen, {
        nodeId: n.id,
        kind: "main-module",
        source: "auto:func-main",
        label: "func main",
      });
    }
  }

  // 4. Tag-based entry advertisement. Adapters that know more than we do can
  //    stamp `tags: ["entry:<kind>"]` on a node and we honor it here.
  for (const n of ir.nodes) {
    const tags = (n as Node & { tags?: string[] }).tags;
    if (!tags) continue;
    for (const t of tags) {
      if (!t.startsWith("entry:")) continue;
      const rawKind = t.slice("entry:".length);
      pushOnce(out, seen, {
        nodeId: n.id,
        kind: normalizeEntryKind(rawKind),
        source: "auto:tag",
        label: t,
      });
    }
  }

  // 5. Lifecycle-hook scaffolding. We can only honor adapter-provided tags here
  //    — the manifest live in `package.json` and is the adapter's domain.
  //    If the adapter tagged a function with `lifecycle:<script-name>`, lift
  //    that to a `lifecycle-hook` entry when the script name is recognized.
  for (const n of ir.nodes) {
    const tags = (n as Node & { tags?: string[] }).tags;
    if (!tags) continue;
    for (const t of tags) {
      if (!t.startsWith("lifecycle:")) continue;
      const script = t.slice("lifecycle:".length);
      if (!NODE_LIFECYCLE_SCRIPTS.has(script)) continue;
      pushOnce(out, seen, {
        nodeId: n.id,
        kind: "lifecycle-hook",
        source: `auto:lifecycle:${script}`,
        label: `lifecycle: ${script}`,
      });
    }
  }

  return out;
}

function normalizeEntryKind(raw: string): EntryKind {
  switch (raw) {
    case "http-route":
    case "cli-bin":
    case "library-export":
    case "test":
    case "framework-page":
    case "framework-component":
    case "main-module":
    case "lifecycle-hook":
    case "worker":
    case "user-declared":
      return raw;
    default:
      return raw.startsWith("x-") ? (raw as `x-${string}`) : `x-${raw}`;
  }
}

function pushOnce(
  list: EntryPointRef[],
  seen: Set<NodeId>,
  ref: EntryPointRef,
): void {
  if (seen.has(ref.nodeId)) return;
  seen.add(ref.nodeId);
  list.push(ref);
}

/**
 * Resolve a user-declared `include` against the IR. Returns null when the
 * declared symbol/path cannot be matched — the caller emits a warning.
 */
export function resolveInclude(
  ir: IR,
  inc: EntryPointInclude,
): EntryPointRef[] | null {
  const kind = inc.kind ?? "function";

  if (inc.path !== undefined) {
    // file / export-by-path: every function inside the matching module is an entry.
    const module = ir.nodes.find(
      (n): n is ModuleNode => isModuleNode(n) && n.path === inc.path,
    );
    if (!module) return null;
    const refs: EntryPointRef[] = [
      {
        nodeId: module.id,
        kind: "user-declared",
        source: "config:include",
        label: inc.label ?? `file: ${inc.path}`,
      },
    ];
    // Add every function whose containment chain leads to this module —
    // shallow scan: direct children only. That's enough for the export-of-file
    // case; deeper containment (functions inside types inside modules) is
    // covered by reachability propagation.
    for (const n of ir.nodes) {
      if (!isFunctionNode(n)) continue;
      if ((n as FunctionNode).parentId === module.id) {
        refs.push({
          nodeId: n.id,
          kind: "user-declared",
          source: "config:include",
          label: inc.label,
        });
      }
    }
    return refs;
  }

  // symbol-form: "module-path#name" matches the function's parent module path
  // + symbol name.
  if (inc.symbol === undefined) return null;
  const hash = inc.symbol.indexOf("#");
  if (hash < 0) {
    // bare module path treated as `kind: file`
    const module = ir.nodes.find(
      (n): n is ModuleNode => isModuleNode(n) && n.path === inc.symbol,
    );
    if (!module) return null;
    return [
      {
        nodeId: module.id,
        kind: "user-declared",
        source: "config:include",
        label: inc.label ?? `module: ${inc.symbol}`,
      },
    ];
  }
  const modPath = inc.symbol.slice(0, hash);
  const symName = inc.symbol.slice(hash + 1);

  const module = ir.nodes.find(
    (n): n is ModuleNode => isModuleNode(n) && n.path === modPath,
  );
  if (!module) return null;

  // Find a function child of this module (or of any type inside this module)
  // with the matching name.
  const moduleId = module.id;
  const typeIds = new Set<NodeId>();
  for (const n of ir.nodes) {
    if (n.tier === "type" && (n as Node & { parentId?: NodeId }).parentId === moduleId) {
      typeIds.add(n.id);
    }
  }
  const fn = ir.nodes.find(
    (n): n is FunctionNode =>
      isFunctionNode(n) &&
      n.name === symName &&
      (n.parentId === moduleId || typeIds.has(n.parentId)),
  );
  if (!fn) return null;
  return [
    {
      nodeId: fn.id,
      kind: kind === "route" ? "http-route" : "user-declared",
      source: "config:include",
      label: inc.label ?? inc.symbol,
    },
  ];
}

/** Apply an exclude rule. Globs match against the module path of the entry. */
function matchesExclude(
  ir: IR,
  ref: EntryPointRef,
  excl: EntryPointExclude,
  moduleByNodeId: Map<NodeId, string>,
): boolean {
  if (typeof excl === "string") {
    const path = moduleByNodeId.get(ref.nodeId);
    if (path === undefined) return false;
    return matchGlob(excl, path);
  }
  // Object form: same shape as EntryPointInclude.
  const candidates = resolveInclude(ir, excl);
  if (!candidates) return false;
  return candidates.some((c) => c.nodeId === ref.nodeId);
}

/**
 * Tiny glob matcher covering `*` and `**`. We intentionally do not pull in a
 * dependency: this runs over <= a few hundred patterns × a few thousand
 * paths, and the YAML-config glob vocabulary is well-understood.
 */
export function matchGlob(pattern: string, path: string): boolean {
  // Convert glob to RegExp.
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // **
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1; // collapse `**/` so it can match zero dirs
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

/**
 * Build the final entry-point set: auto + include − exclude. Diagnostics are
 * accumulated for unresolved includes (the design says drop-with-warning).
 */
export function collectEntryPoints(
  ir: IR,
  config?: Pick<CodegraphConfig, "entryPoints"> | undefined,
): CollectEntryPointsResult {
  const diagnostics: Diagnostic[] = [];
  const entries = detectAutoEntries(ir);
  const seen = new Set(entries.map((e) => e.nodeId));

  const include = config?.entryPoints.include ?? [];
  const exclude = config?.entryPoints.exclude ?? [];

  for (let i = 0; i < include.length; i++) {
    const inc = include[i];
    const refs = resolveInclude(ir, inc);
    if (!refs || refs.length === 0) {
      diagnostics.push({
        severity: "warn",
        analyzer: "dead-code/entry-points",
        code: "entry-point-unresolved",
        message: `entryPoints.include[${i}] could not be resolved against the IR: ${
          inc.symbol ?? inc.path ?? "<empty>"
        }`,
      });
      continue;
    }
    for (const r of refs) {
      if (seen.has(r.nodeId)) continue;
      seen.add(r.nodeId);
      entries.push({ ...r, source: `config:include[${i}]` });
    }
  }

  if (exclude.length === 0) return { entries, diagnostics };

  // Index module path per node for glob excludes. Functions/types/expressions
  // inherit the module path of their enclosing module — we walk the parent
  // chain.
  const moduleByNodeId = computeModulePaths(ir);

  const filtered = entries.filter(
    (e) => !exclude.some((x) => matchesExclude(ir, e, x, moduleByNodeId)),
  );
  return { entries: filtered, diagnostics };
}

/** Map every node to the path of its enclosing module (or the module itself). */
function computeModulePaths(ir: IR): Map<NodeId, string> {
  const result = new Map<NodeId, string>();
  const byId = new Map<NodeId, Node>();
  for (const n of ir.nodes) byId.set(n.id, n);

  for (const n of ir.nodes) {
    let cur: Node | undefined = n;
    while (cur) {
      if (isModuleNode(cur)) {
        result.set(n.id, cur.path);
        break;
      }
      const parentId = (cur as Node & { parentId?: NodeId }).parentId;
      if (!parentId) break;
      cur = byId.get(parentId);
    }
  }
  return result;
}

/** Helper exposed for `reachability.ts`: predicate "is this node in a test module?" */
export function buildTestModuleSet(ir: IR): Set<NodeId> {
  const result = new Set<NodeId>();
  for (const n of ir.nodes) {
    if (!isModuleNode(n)) continue;
    if (isTestModulePath((n as ModuleNode).path)) result.add(n.id);
  }
  return result;
}

// Internal export used by tests.
export const __internal = {
  isTestModulePath,
  isFrameworkPagePath,
  isWorkerPath,
  isMainModulePath,
};
