/**
 * `@codegraph/adapter-nextjs` — public entry point.
 *
 * Default export is an `AdapterFactory<NextjsConfig>` per spec §3.1. Calling
 * the factory with optional user config returns the `Adapter` descriptor the
 * codegraph host loads.
 *
 * Usage:
 *
 *   // codegraph.config.ts
 *   import nextjs from "@codegraph/adapter-nextjs";
 *
 *   export default { adapters: [nextjs()] };
 */

import type {
  Adapter,
  AdapterFactory,
  ParsedFile,
} from "@codegraph/adapter-sdk";

import { detect } from "./detect.js";
import { analyzeFile } from "./analyze.js";
import { resolve } from "./resolve.js";
import {
  DIAG_CODE,
  EDGE_KIND,
  NODE_KIND,
} from "./types.js";

/** Optional user-supplied configuration block from `codegraph.config.ts`. */
export interface NextjsConfig {
  /**
   * Limit `analyzeFile` to files under these globs. By default the adapter
   * runs on every TS/JS file (so it can find `fetch()` calls anywhere) but
   * a project may want to scope this for performance.
   */
  readonly include?: ReadonlyArray<string>;
  /**
   * Glob patterns to exclude. Combined with the host's repo-level ignore
   * list. Useful to skip generated `.next/` output if it slips past the
   * default scope.
   */
  readonly exclude?: ReadonlyArray<string>;
}

const ADAPTER_NAME = "nextjs";
const ADAPTER_VERSION = "0.1.0";
const ADAPTER_API_VERSION = 1;

const TS_JS_LANGUAGES = new Set<string>([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
]);

const TS_JS_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const adapterFactory: AdapterFactory<NextjsConfig> = (
  userConfig?: NextjsConfig,
): Adapter => {
  const include = userConfig?.include;
  const exclude = userConfig?.exclude;

  const appliesTo: NonNullable<Adapter["appliesTo"]> = (
    file: Pick<ParsedFile, "path" | "language" | "sizeBytes">,
  ): boolean => {
    // Cheap path / language gate first.
    const lang = file.language ?? "";
    const isTsJs =
      TS_JS_LANGUAGES.has(lang) || TS_JS_EXTENSIONS.test(file.path);
    if (!isTsJs) return false;
    // Skip declarations (they never carry runtime fetches or routes).
    if (/\.d\.ts$/i.test(file.path)) return false;
    // Skip the build artifact directory if we somehow see it.
    if (/(^|\/)\.next\//.test(file.path)) return false;
    if (include && !matchesAny(file.path, include)) return false;
    if (exclude && matchesAny(file.path, exclude)) return false;
    return true;
  };

  return {
    name: ADAPTER_NAME,
    version: ADAPTER_VERSION,
    apiVersion: ADAPTER_API_VERSION,
    description: "Next.js App Router adapter (route.ts, page.tsx, server actions, fetch)",
    homepage: "https://github.com/codegraph/codegraph/tree/main/adapters/nextjs",

    idScheme: "nextjs",
    cacheable: true,

    deps: {
      // Per the contract agreed with adapter-fastapi + adapter-express:
      // we read peer route nodes if those adapters are active. Pre-1.0
      // ranges per the cross-stack agreement.
      optional: [
        { name: "fastapi", range: "^0.1" },
        { name: "express", range: "^0.1" },
        // Language indexer: when present, we use it to resolve call sites
        // for the action-call edges. Listed both names for flexibility
        // since the host hasn't pinned its indexer name in v0.1.
        { name: "ts-indexer", range: "^0.1" },
        { name: "typescript-indexer", range: "^0.1" },
      ],
    },

    declares: {
      nodeKinds: [
        NODE_KIND.ROUTE,
        NODE_KIND.PAGE,
        NODE_KIND.ACTION,
        NODE_KIND.CLIENT_CALL,
      ],
      edgeKinds: [
        EDGE_KIND.ROUTE_HANDLER,
        EDGE_KIND.PAGE_COMPONENT,
        EDGE_KIND.ACTION_HANDLER,
        EDGE_KIND.ACTION_CALL,
        EDGE_KIND.HTTP_CALL,
      ],
      diagnosticCodes: [
        DIAG_CODE.DYNAMIC_FETCH_URL,
        DIAG_CODE.UNKNOWN_HTTP_METHOD,
        DIAG_CODE.ROUTE_HANDLER_NOT_FUNCTION,
        DIAG_CODE.UNRESOLVED_HTTP_CALL,
      ],
    },

    appliesTo,

    detect,
    analyzeFile,
    resolve,
  };
};

function matchesAny(path: string, patterns: ReadonlyArray<string>): boolean {
  for (const p of patterns) {
    if (globToRegExp(p).test(path)) return true;
  }
  return false;
}

/**
 * Tiny glob -> RegExp. Supports `**`, `*`, and `?`. We deliberately don't
 * pull in picomatch as a runtime dep — adapters should be lean. The host's
 * own `fs.glob` is the canonical matcher; this is only a defensive in-process
 * filter for `appliesTo`.
 */
function globToRegExp(pattern: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i += 2;
      if (pattern[i] === "/") i++;
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += "\\" + ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  out += "$";
  return new RegExp(out);
}

// Named exports — useful for tests and downstream tooling, mirroring the
// public-API-as-`src/index.ts` rule (STRUCTURE.md §9.2).
export type { NextjsConfig as NextjsAdapterConfig };
export {
  NODE_KIND,
  EDGE_KIND,
  DIAG_CODE,
} from "./types.js";
export type {
  RouteNodeData,
  PageNodeData,
  ServerActionNodeData,
  ClientCallNodeData,
  HttpMethod,
  MatchRouteQuery,
} from "./types.js";

export { filePathToRoute, appRelativePath } from "./route-conv.js";
export { routePatternToRegex } from "./resolve.js";

// The adapter package's default export must be the factory (STRUCTURE.md §9.3).
export default adapterFactory;
