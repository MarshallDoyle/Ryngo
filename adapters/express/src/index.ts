/**
 * Public entrypoint for `@codegraph/adapter-express`.
 *
 * Exports a default `AdapterFactory` (per spec §3.1) that the host calls
 * to obtain the `Adapter` descriptor. The factory pattern keeps the
 * descriptor pure (no I/O at registration time) and lets the host hand
 * the adapter optional config from `codegraph.config.ts`.
 *
 * Cross-adapter contract recap (locked with adapter-nextjs, ack'd by
 * adapter-fastapi):
 *   - We are PRODUCER-ONLY of `http.route` nodes. We do not emit
 *     cross-stack `http.calls` edges; adapter-nextjs owns the matcher
 *     and reads our routes via `peers.get("express").nodes("http.route")`.
 *   - Route nodes carry `{ method, path, framework: "express",
 *     handlerSymbolId? }`. Express paths are already colon-style so no
 *     normalization at emit-time.
 *   - We declare no peer deps; we don't need to read anyone else's IR.
 *   - We declare `idScheme: "express"` (per task brief), `apiVersion: 1`,
 *     and an empty `permissions` block (no fs/net/exec/env access).
 *
 * Adapter version is pinned in this file so it lives next to the
 * descriptor, not the package.json — the spec wants the version to flow
 * into provenance and node IDs, and reading package.json from the
 * adapter at runtime would require fs permission this adapter doesn't
 * need.
 */

import type {
  Adapter,
  AdapterFactory,
  ParsedFile,
} from "@codegraph/adapter-sdk";

import { analyzeFile } from "./analyze.js";
import { detectExpress } from "./detect.js";
import { finalize } from "./finalize.js";
import { resolve } from "./resolve.js";
import {
  EDGE_KIND_ROUTE_HANDLER,
  NODE_KIND_FILE_MOUNTS,
  NODE_KIND_HANDLER,
  NODE_KIND_ROUTE,
  NODE_KIND_ROUTER,
  NODE_KIND_SUMMARY,
  DIAG_NON_LITERAL_PATH,
  DIAG_ORPHAN_ROUTER,
  DIAG_UNRESOLVED_HANDLER,
} from "./types.js";

/**
 * Optional adapter-side config from `codegraph.config.ts`.
 *
 * Keeping the surface minimal in v0.1: the only thing a user might
 * realistically want to override is the file size cap (huge bundles can
 * confuse the AST walker — bailing is safer than spending a 5s/file
 * budget on a minified bundle).
 */
export interface ExpressAdapterConfig {
  /**
   * Skip analysis for files larger than this many bytes. Default: 1MB.
   * The host already enforces a global cap; this is an adapter-local
   * additional bound for ergonomics on bundle files.
   */
  readonly maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 1_000_000;

/** Adapter version. Bumped on every release; see spec §7.1. */
const ADAPTER_VERSION = "0.1.0" as const;

/** SDK API version we were built against. Host refuses incompatible majors. */
const ADAPTER_API_VERSION = 1 as const;

const create: AdapterFactory<ExpressAdapterConfig> = (
  userConfig?: ExpressAdapterConfig,
): Adapter => {
  const maxFileBytes = userConfig?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  return {
    name: "express",
    version: ADAPTER_VERSION,
    apiVersion: ADAPTER_API_VERSION,
    description:
      "Recognizes Express.js route registrations and emits shared `http.route` IR nodes. " +
      "Composes Router mount prefixes; flags orphans.",
    homepage: "https://github.com/codegraph/codegraph/tree/main/adapters/express",
    idScheme: "express",

    // No external capabilities required. The adapter reads only the AST
    // and symbol index the host hands us via `ctx.file`.
    permissions: {
      network: [],
      exec: [],
      env: [],
    },

    // Producer-only: no required peers, no optional peers. The cross-stack
    // matcher (adapter-nextjs) reads our routes; we don't read theirs.
    deps: {
      required: [],
      optional: [],
      after: [],
    },

    // analyzeFile output is a pure function of file content + symbol
    // index, both of which the host hashes into the cache key. Safe to
    // cache.
    cacheable: true,

    // Cheap pure file predicate. The host calls `analyzeFile` only when
    // this returns true; we additionally re-check the language and a
    // substring heuristic inside `analyzeFile` to bail before allocating
    // the AST walk.
    appliesTo: (file: Pick<ParsedFile, "path" | "language" | "sizeBytes">): boolean => {
      if (file.sizeBytes > maxFileBytes) return false;
      const lang = file.language;
      return (
        lang === "typescript" ||
        lang === "tsx" ||
        lang === "javascript" ||
        lang === "jsx"
      );
    },

    // Declared output schema. Used by the host for validation, by the
    // viewer for its kind legend, and by downstream adapters that want
    // typed peer dependencies on our outputs.
    declares: {
      nodeKinds: [
        NODE_KIND_ROUTE,
        NODE_KIND_HANDLER,
        NODE_KIND_ROUTER,
        NODE_KIND_SUMMARY,
        NODE_KIND_FILE_MOUNTS,
      ],
      edgeKinds: [EDGE_KIND_ROUTE_HANDLER],
      diagnosticCodes: [
        DIAG_NON_LITERAL_PATH,
        DIAG_ORPHAN_ROUTER,
        DIAG_UNRESOLVED_HANDLER,
      ],
    },

    detect: detectExpress,
    analyzeFile,
    resolve,
    finalize,
  };
};

export default create;

// Re-export the public surface so consumers can do
// `import expressAdapter, { type ExpressAdapterConfig, ... } from '@codegraph/adapter-express'`.
export {
  EDGE_KIND_ROUTE_HANDLER,
  NODE_KIND_FILE_MOUNTS,
  NODE_KIND_HANDLER,
  NODE_KIND_ROUTE,
  NODE_KIND_ROUTER,
  NODE_KIND_SUMMARY,
} from "./types.js";

export type {
  FileMountsNodeData,
  HandlerNodeData,
  MountRecord,
  OwnerKind,
  RouteHandlerEdgeData,
  RouteNodeData,
  RouterNodeData,
  SummaryNodeData,
} from "./types.js";
