/**
 * codegraph adapter: env
 * ---------------------------------------------------------------------------
 * Detects environment-variable reads in TypeScript and Python sources, plus
 * `.env*` files at the repo root and common subdirs, and emits IR
 * fragments per `spec/adapter-interface.md`:
 *
 *   - one `expression`-tier IR node per env-var read site (`leaf.flavor: 'env'`).
 *   - one `expression`-tier IR node per `.env*`-loader call site
 *     (`leaf.flavor: 'config-file'`, `format: 'env'`) — the `import 'dotenv/config'`
 *     and `dotenv.config()` shapes.
 *   - one `env-read` edge from the enclosing function (when there is one)
 *     to the leaf node.
 *
 * Each leaf carries adapter-namespaced tags per ir-types' guidance:
 *   `env:source=<process.env|import.meta.env|Bun.env|os.environ|os.environ.get|os.getenv|pydantic-settings>`
 *   `env:declared`                — present iff the env var name appears in any parsed `.env*` file
 *   `env:dotenv-loaded`           — only on loader leaves
 *
 * Identity / determinism notes (per spec/ir-schema.md §6):
 *   - Leaf node ids derive from a stable signature: parent function/module
 *     id + role discriminator + canonical payload + lexical-occurrence
 *     index. We compute the occurrence index by sorting the per-file
 *     findings in source order BEFORE flushing — sorting AST visits is
 *     parser-portable insurance against a future SDK that hands us
 *     children in non-source order.
 *   - Edge identity is (sourceId, targetId, category, attributes-hash) —
 *     handled by the host's IR builder; we just emit category 'env-read'
 *     with `name` for downstream consumers.
 */

import type {
  Adapter,
  AnalyzeFileContext,
  DetectContext,
  DetectResult,
  FinalizeContext,
  IrEdge,
  IrNode,
  ParsedFile,
} from "@codegraph/adapter-sdk";

import { runDetect } from "./detect.js";
import { analyzeTsFile } from "./analyze-ts.js";
import { analyzePyFile } from "./analyze-py.js";
import type {
  DotenvRegistry,
  EnvReadSource,
  PerFileEnvFinding,
} from "./types.js";

const ADAPTER_NAME = "env";
const ADAPTER_VERSION = "0.1.0";
const API_VERSION = 1;

/**
 * Module-level mutable state is forbidden by the spec (§6.2: "No global
 * mutable state"). The `DotenvRegistry` is built once in `detect`, and we
 * stash it on a closure variable that the factory captures — every
 * factory invocation produces a fresh adapter object with its own
 * registry. The host calls the factory once per run.
 */
export default function envAdapterFactory(): Adapter {
  // The registry starts empty; `detect` populates it. We keep it in the
  // closure rather than on the adapter object so `analyzeFile` can read it
  // without its result depending on adapter-instance identity (which would
  // be a cache key concern).
  let registry: DotenvRegistry = {
    byName: new Map(),
    entries: [],
    files: [],
  };

  const adapter: Adapter = {
    name: ADAPTER_NAME,
    version: ADAPTER_VERSION,
    apiVersion: API_VERSION,
    description:
      "Detects environment-variable reads (process.env, import.meta.env, Bun.env, os.environ/getenv, pydantic-settings) and parses .env* files into a declared-keys registry.",
    homepage: "https://github.com/codegraph/codegraph/tree/main/adapters/env",

    idScheme: "env",

    permissions: {
      // No network. No exec. We DO need filesystem access for `.env*`
      // files — but ScopedFs is the host's blessed channel for that and
      // doesn't require a permission declaration. No env passthrough:
      // reading `process.env` from inside the adapter would defeat
      // determinism. (We READ env-var REFERENCES from source; we don't
      // resolve their runtime values.)
    },

    // The adapter has no inter-adapter dependencies. ts-indexer / py-indexer
    // are language indexers, not adapter peers — their output reaches us
    // through `ParsedFile.symbols`, not via `ctx.peers`. If a future
    // ts-binding-aware adapter wants to extend us with binding-flow tracking
    // it would declare US as a peer, not the other way around.
    deps: {},

    // Cacheable: yes. Per spec §6.3 caching contract — analyzeFile reads
    // only `file.content`, `file.path`, `file.symbols`, plus the registry
    // (stable across the run, factored into the adapter version key).
    cacheable: true,

    // File predicate. We accept:
    //   - any TS/JS file (typescript / tsx / javascript / jsx language tags
    //     plus the file extensions, defensively);
    //   - any Python file (py-indexer emits `'py'`; the spec sample uses
    //     `'python'` — we accept both per coordination with py-indexer);
    //   - `.env*` files. Those have no language tag, so we match by path.
    appliesTo(file) {
      const path = file.path;
      const lang = file.language;
      // Bail early on absurdly large files. The host enforces a hard cap
      // already; this is a soft one to avoid pathological env files.
      if (file.sizeBytes > 1024 * 1024) return false;

      if (lang === "typescript" || lang === "tsx" || lang === "javascript" || lang === "jsx") {
        return true;
      }
      if (lang === "py" || lang === "python") {
        return true;
      }
      // `.env*` files (no language tag): keyed off basename to avoid
      // matching e.g. `prod.env.docs/changelog.md`.
      if (isDotenvFilePath(path)) {
        return true;
      }
      // Polyglot defensive fallback: TS/JS files sometimes arrive without
      // a language tag (e.g. `.cts`, `.mts`, `.cjs`, `.mjs`).
      if (
        path.endsWith(".ts") ||
        path.endsWith(".tsx") ||
        path.endsWith(".js") ||
        path.endsWith(".jsx") ||
        path.endsWith(".mts") ||
        path.endsWith(".cts") ||
        path.endsWith(".mjs") ||
        path.endsWith(".cjs")
      ) {
        return true;
      }
      if (path.endsWith(".py")) return true;
      return false;
    },

    declares: {
      // Both kinds map to the IR `expression` tier; the namespaced names
      // let downstream peer adapters request only env-read leaves.
      nodeKinds: ["env.read", "env.dotenv-loader"],
      // We don't introduce a new edge kind: `env-read` is in the v0.1
      // closed enum already (spec/ir.types.ts:413).
      edgeKinds: ["env-read"],
      diagnosticCodes: [
        "env/dotenv-too-large",
        "env/dynamic-key",
        "env/rest-destructure",
        "env/undeclared-reference",
        "env/no-analyzer",
        "env/summary",
      ],
    },

    // -----------------------------------------------------------------------
    // Phase: detect
    // -----------------------------------------------------------------------
    async detect(ctx: DetectContext): Promise<DetectResult> {
      const { result, registry: built } = await runDetect(ctx);
      registry = built;
      return result;
    },

    // -----------------------------------------------------------------------
    // Phase: analyzeFile
    // -----------------------------------------------------------------------
    async analyzeFile(ctx: AnalyzeFileContext): Promise<void> {
      const file = ctx.file;
      // .env files: nothing to emit per-file (the registry was built in
      // detect). We could emit a `module`-tier node per .env file in
      // finalize for the viewer's "Adapters" panel, but that is the
      // host's responsibility (a config-file module is a generic concept,
      // not framework-specific) — defer to a future config-file adapter.
      if (isDotenvFilePath(file.path)) {
        return;
      }

      const findings: PerFileEnvFinding[] = [];
      const loaderFindings: PerFileEnvFinding[] = [];

      const lang = normalizeLanguage(file);
      if (lang === "ts") {
        analyzeTsFile(ctx, findings, loaderFindings);
      } else if (lang === "py") {
        analyzePyFile(ctx, findings);
      } else {
        // appliesTo let it through but we have no analyzer; that's a bug
        // in this adapter — surface as an info diagnostic and move on.
        ctx.diagnostic({
          severity: "info",
          code: "env/no-analyzer",
          message: `No env analyzer for language=${lang ?? "<unknown>"} (path=${file.path}).`,
          file: file.path,
        });
        return;
      }

      // Order findings by source position so the lexical-occurrence
      // discriminator in node ids is stable regardless of AST visit order
      // (a determinism guard recommended by spec/ir-schema.md §6).
      findings.sort((a, b) => a.range.startByte - b.range.startByte);
      loaderFindings.sort((a, b) => a.range.startByte - b.range.startByte);

      // Per-(parent, source, name) occurrence counters. The leaf id
      // includes occurrence to disambiguate two reads of the same var
      // inside the same function.
      const occurrenceCounter = new Map<string, number>();
      const nextOccurrence = (key: string): number => {
        const n = occurrenceCounter.get(key) ?? 0;
        occurrenceCounter.set(key, n + 1);
        return n;
      };

      for (const f of findings) {
        emitEnvLeaf(ctx, file, f, registry, nextOccurrence);
      }
      for (const f of loaderFindings) {
        emitDotenvLoaderLeaf(ctx, file, f, nextOccurrence);
      }
    },

    // -----------------------------------------------------------------------
    // Phase: resolve  — we have no cross-file deferred refs.
    // -----------------------------------------------------------------------
    // resolve omitted intentionally.

    // -----------------------------------------------------------------------
    // Phase: finalize  — emit summary diagnostics.
    // -----------------------------------------------------------------------
    finalize(ctx: FinalizeContext): void {
      // For each declared key (from .env files), check whether the run
      // saw at least one read. Conversely, for each referenced key, check
      // whether it was declared. Both gaps are useful signals.
      //
      // We only have access to OUR own emitted leaves via ctx.own (per
      // the resolved-context shape in the spec). Walk those once.
      const referencedNames = new Set<string>();
      for (const node of ctx.own.nodes("env.read")) {
        // node.data.leaf.name is the canonical env var name.
        const data = node.data as Record<string, unknown> | undefined;
        const leaf = data?.["leaf"] as { flavor?: string; name?: string } | undefined;
        if (!leaf || leaf.flavor !== "env" || typeof leaf.name !== "string") continue;
        referencedNames.add(leaf.name);
      }

      // Referenced-but-not-declared:
      for (const name of referencedNames) {
        if (registry.byName.has(name)) continue;
        // Skip variables that look like Vite-style PUBLIC_* / NEXT_PUBLIC_*
        // — those are conventionally defined in CI, not in .env files.
        if (looksLikeBuildtimeBuiltin(name)) continue;
        ctx.diagnostic({
          severity: "warn",
          code: "env/undeclared-reference",
          message: `Env var "${name}" is referenced in source but not declared in any .env* file.`,
          hint: `Add ${name}=<default> to .env.example so contributors know it's required.`,
          data: { name },
        });
      }

      // Summary info diagnostic (one per run).
      ctx.diagnostic({
        severity: "info",
        code: "env/summary",
        message: `Parsed ${registry.entries.length} declared keys across ${registry.files.length} dotenv file(s); referenced ${referencedNames.size} distinct env var(s) in source.`,
        data: {
          declaredKeyCount: registry.entries.length,
          dotenvFileCount: registry.files.length,
          referencedNameCount: referencedNames.size,
        },
      });
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

/**
 * Translate a single PerFileEnvFinding into:
 *   - one expression-tier IR node (the leaf), parented to the enclosing
 *     function or, when there is none, omitted (top-level reads are still
 *     emitted as orphans whose parent is the module — but the spec wants
 *     parentId to be a function for expression tier, so for top-level
 *     reads we use the file's module node as `parentId`).
 *   - one `env-read` edge from the enclosing function (if any) to the
 *     leaf. No edge at module top level — the leaf-as-orphan tells the
 *     viewer "this var is read at import time".
 */
function emitEnvLeaf(
  ctx: AnalyzeFileContext,
  file: ParsedFile,
  f: PerFileEnvFinding,
  registry: DotenvRegistry,
  nextOccurrence: (key: string) => number,
): void {
  const parentKey = f.enclosingFunctionId ?? `module:${file.path}`;
  const occKey = `${parentKey}|${f.source}|${f.name}`;
  const occurrence = nextOccurrence(occKey);

  // Local-id: stable from (file, name, source, occurrence). NOT from the
  // byte range — line numbers must not influence ID per ir-schema.md §6.
  const localId = `read::${f.source}::${f.name}::${occurrence}`;
  const leafId = ctx.id.mint({ path: file.path, localId });

  const declared = registry.byName.has(f.name);

  const tags: string[] = [`env:source=${f.source}`];
  if (declared) tags.push("env:declared");

  const leafNode: IrNode = {
    id: leafId,
    // Adapter-namespaced node kind ("dotted lowercase, no spaces" per
    // adapter-interface.ts:79). The host's IR builder maps this onto the
    // IR-schema `tier: 'expression'` via the kind→tier registry; we set
    // tier explicitly in `data` for downstream consumers that index by
    // it without needing the registry.
    kind: "env.read",
    label: `env:${f.name}`,
    data: {
      tier: "expression",
      role: "env-read",
      pure: true,
      leaf:
        f.defaultValue !== undefined
          ? { flavor: "env", name: f.name, defaultValue: f.defaultValue }
          : { flavor: "env", name: f.name },
      tags,
    },
    provenance: {
      file: file.path,
      range: f.range,
      // adapter + version are stamped by the host (spec §2.4); we leave
      // the placeholders empty and the host fills them. This matches
      // adapter-interface.ts:67-68.
      adapter: ADAPTER_NAME,
      version: ADAPTER_VERSION,
    },
  };
  ctx.emit(leafNode);

  // env-read edge from caller fn → leaf, but only if we know the caller.
  if (f.enclosingFunctionId) {
    const edgeId = ctx.id.mint({
      path: file.path,
      localId: `edge::env-read::${f.source}::${f.name}::${occurrence}`,
    });
    const edge: IrEdge = {
      id: edgeId,
      // Edge `kind` matches the IR-schema edge category exactly because
      // `env-read` is in the v0.1 closed enum (see ir-types' message). The
      // host's IR builder uses `kind` → `category` 1:1 here.
      kind: "env-read",
      from: f.enclosingFunctionId,
      to: leafId,
      label: `reads ${f.name}`,
      data: {
        category: "env-read",
        name: f.name,
      },
      provenance: {
        file: file.path,
        range: f.range,
        adapter: ADAPTER_NAME,
        version: ADAPTER_VERSION,
      },
    };
    ctx.emit(edge);
  }
}

/**
 * Emit a leaf for `import 'dotenv/config'` / `dotenv.config()` and
 * friends. Distinct from env-var leaves in two ways:
 *
 *   1. The leaf's `flavor` is `'config-file'` (not `'env'`) — per
 *      ir-types' guidance, `LeafConfigFile { format: 'env' }` is the
 *      semantically correct shape for "this expression loads a .env file".
 *   2. The leaf is tagged `env:dotenv-loaded` so downstream consumers
 *      (security-insights, dead-code) can find loaders without scanning
 *      every config-file leaf.
 *
 * No edge is emitted from the loader call to anything — the loader is
 * the side-effecting expression itself; if the IR consumer wants a
 * function→loader edge it can build that from the caller's call edge to
 * `dotenv.config` (which the language indexer emits, not us).
 */
function emitDotenvLoaderLeaf(
  ctx: AnalyzeFileContext,
  file: ParsedFile,
  f: PerFileEnvFinding,
  nextOccurrence: (key: string) => number,
): void {
  const parentKey = f.enclosingFunctionId ?? `module:${file.path}`;
  const occKey = `${parentKey}|dotenv|${f.name}`;
  const occurrence = nextOccurrence(occKey);

  const localId = `loader::dotenv::${occurrence}`;
  const leafId = ctx.id.mint({ path: file.path, localId });

  const tags = ["env:source=dotenv", "env:dotenv-loaded"];
  const leafNode: IrNode = {
    id: leafId,
    kind: "env.dotenv-loader",
    label: f.name === "<dotenv/config>" ? "dotenv side-effect import" : "dotenv.config()",
    data: {
      tier: "expression",
      role: "config-load",
      pure: false, // it has a side effect (mutates process.env)
      leaf: { flavor: "config-file", path: ".env", format: "env" },
      tags,
    },
    provenance: {
      file: file.path,
      range: f.range,
      adapter: ADAPTER_NAME,
      version: ADAPTER_VERSION,
    },
  };
  ctx.emit(leafNode);
}

// ---------------------------------------------------------------------------
// Path / language helpers
// ---------------------------------------------------------------------------

/**
 * Recognize `.env`, `.env.local`, `.env.production`, `.env.example`, etc.
 * Tolerates both `/` and `\` separators (Windows analyzers must
 * normalize, but we don't trust them to).
 */
function isDotenvFilePath(path: string): boolean {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = idx >= 0 ? path.slice(idx + 1) : path;
  return base === ".env" || base.startsWith(".env.");
}

/**
 * Collapse the various language tags we accept (typescript / tsx / js /
 * py / python) into the two values our analyzers care about. Returns
 * null when nothing fits — appliesTo should already have filtered.
 */
function normalizeLanguage(file: ParsedFile): "ts" | "py" | null {
  const lang = file.language;
  if (
    lang === "typescript" ||
    lang === "tsx" ||
    lang === "javascript" ||
    lang === "jsx"
  ) {
    return "ts";
  }
  if (lang === "py" || lang === "python") {
    return "py";
  }
  // Fallback by extension.
  const path = file.path;
  if (
    path.endsWith(".ts") ||
    path.endsWith(".tsx") ||
    path.endsWith(".js") ||
    path.endsWith(".jsx") ||
    path.endsWith(".mts") ||
    path.endsWith(".cts") ||
    path.endsWith(".mjs") ||
    path.endsWith(".cjs")
  ) {
    return "ts";
  }
  if (path.endsWith(".py")) return "py";
  return null;
}

/**
 * Variables conventionally injected at build time rather than declared in
 * .env files. We don't want to spam diagnostics for these — Vite,
 * Next.js, Create-React-App, and SvelteKit all expose process-env-shaped
 * facades whose values come from CI or vite.config.ts.
 */
function looksLikeBuildtimeBuiltin(name: string): boolean {
  return (
    name === "NODE_ENV" ||
    name === "PUBLIC_URL" ||
    name === "BASE_URL" ||
    name.startsWith("VITE_") ||
    name.startsWith("NEXT_PUBLIC_") ||
    name.startsWith("REACT_APP_") ||
    name.startsWith("PUBLIC_") || // SvelteKit
    name.startsWith("STORYBOOK_")
  );
}

// Re-export the factory under a named export too, mirroring the express
// adapter's pattern (named `expressAdapter`). Matches the codebase
// convention where adapter-* packages export both a default factory and
// a named adapter for tests that don't go through the SDK.
export const envAdapter: Adapter = envAdapterFactory();
