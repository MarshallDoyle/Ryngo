/**
 * @codegraph/adapter-fastapi — public entry point.
 *
 * Default export is the AdapterFactory the host calls from
 * `codegraph.config.{ts,json}`:
 *
 *     import fastapi from "@codegraph/adapter-fastapi";
 *     export default { adapters: [fastapi()] };
 *
 * The factory pattern keeps registration pure (no I/O at import time, per
 * adapter-interface.md §3.1) and lets us thread user config into the
 * descriptor without leaking module-level mutable state.
 *
 * Adapter shape conforms to spec/adapter-interface.ts:
 *   - 4 phase methods: detect, analyzeFile, resolve, finalize
 *   - factory default export
 *   - idScheme: "fastapi"
 *   - apiVersion: 1 (matches @codegraph/adapter-sdk major)
 *
 * Cross-service edge contract (shared with adapter-express, adapter-nextjs):
 *   - fastapi is a *pure producer* of `http.route` nodes. Path placeholders
 *     are normalized to colon-style at emit-time (`{id}` → `:id`,
 *     last-segment `{rest:path}` → `*rest`) so peer matchers need only one
 *     regex translation. `data.framework: "fastapi"` discriminates between
 *     server frameworks when both are active in one repo.
 *   - The client-side adapter (nextjs / http-client) owns `http.calls`
 *     edges: it walks our `http.route` nodes via
 *     `peers.get("fastapi").nodes("http.route")`, matches `(method, path)`
 *     exact-then-regex, and resolves its own deferred refs. fastapi does
 *     NOT emit `http.calls` edges — that would double-emit when nextjs
 *     also runs.
 */
import type {
  Adapter,
  AdapterFactory,
  AnalyzeFileContext,
  DetectContext,
  FinalizeContext,
  ParsedFile,
  ResolveContext,
} from "@codegraph/adapter-sdk";
import { detect } from "./detect.js";
import { analyzeFile } from "./analyze.js";
import { resolve } from "./resolve.js";
import { finalize } from "./finalize.js";
import { type AdapterState, makeAdapterState, K } from "./types.js";

/**
 * Optional user-tunable knobs read from `codegraph.config.{ts,json}`.
 *
 * The shape is currently empty: fastapi is a pure producer of
 * `http.route` nodes and has no behavior to configure. Reserved for
 * future additions (e.g. opt-in inclusion of dynamic-path routes via a
 * `dynamic: true` flag rather than dropping them with a `warn`
 * diagnostic).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FastApiAdapterConfig {}

const ADAPTER_VERSION = "0.1.0";

const fastapiAdapter: AdapterFactory<FastApiAdapterConfig> = (_userConfig) => {
  // One state object per `Adapter` instance, populated across phases. The
  // factory closes over it; each `codegraph index` run gets a fresh
  // instance via the host calling the factory once at registration.
  const state: AdapterState = makeAdapterState();

  const adapter: Adapter = {
    name: "fastapi",
    version: ADAPTER_VERSION,
    apiVersion: 1,
    description:
      "Lifts FastAPI decorator routes, APIRouter prefix composition, and Pydantic body/response models into the codegraph IR.",
    homepage: "https://github.com/codegraph/codegraph/tree/main/adapters/fastapi",
    idScheme: "fastapi",

    permissions: {
      // No network, no exec, no env. Detection scans manifests via ctx.fs.
    },

    deps: {
      // No required or optional peers. fastapi is a pure leaf producer of
      // `http.route` nodes; the client-side adapter (nextjs) reads our
      // output via its own peer-dep on us, not vice versa.
      //
      // `after: ["express"]` keeps a stable ordering when both server
      // adapters are active — purely a tie-breaker; neither adapter reads
      // the other's nodes.
      after: ["express"],
    },

    cacheable: true,

    declares: {
      nodeKinds: [K.route, K.module],
      edgeKinds: [K.handler],
      diagnosticCodes: [
        "fastapi/route-path-not-literal",
        "fastapi/handler-symbol-not-resolved",
        "fastapi/include-router-fixed-point-cap",
        "fastapi/unresolved-cross-service-edge",
      ],
    },

    appliesTo(file: Pick<ParsedFile, "path" | "language" | "sizeBytes">) {
      // Cheap predicate. Bail on non-Python files at the SDK boundary
      // rather than entering analyzeFile and bailing inside.
      if (file.language === "python") return true;
      return file.path.endsWith(".py");
    },

    async detect(ctx: DetectContext) {
      return detect(ctx);
    },

    async analyzeFile(ctx: AnalyzeFileContext) {
      await analyzeFile(ctx, state);
    },

    async resolve(ctx: ResolveContext) {
      await resolve(ctx, state);
    },

    async finalize(ctx: FinalizeContext) {
      await finalize(ctx, state);
    },
  };

  return adapter;
};

export default fastapiAdapter;

// Re-export local types for downstream tooling (test fixtures, custom
// reporters) that wants strong typing on the data payloads we emit.
export {
  K as FASTAPI_KINDS,
  normalizeRoutePath,
  type RouteData,
  type RouteParam,
  type ParamLocation,
  type HttpMethod,
  type OwnerKind,
  type TypeShape,
  type ModuleSummaryData,
} from "./types.js";
