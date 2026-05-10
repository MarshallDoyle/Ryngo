/**
 * codegraph adapter-env — internal types
 *
 * Shared between detect / analyze-ts / analyze-py / dotenv-parser. Nothing in
 * this file is part of the adapter's wire output (that lives on IR nodes/edges
 * via @codegraph/adapter-sdk); these are purely module-internal.
 */

import type { IrId, SourceRange } from "@codegraph/adapter-sdk";

/**
 * Where an env-var reference came from in source. Drives the
 * `env:source=<x>` tag we put on the leaf expression node, per ir-types'
 * blessing of the `tags: string[]` convention (NodeBase.tags, spec
 * /ir.types.ts:144). We deliberately keep this off the typed `LeafEnv`
 * shape at v0.1 — adding fields to a known leaf flavor would force the
 * `LeafUnknown` escape branch and break discriminator narrowing.
 */
export type EnvReadSource =
  | "process.env" // Node: process.env.X / process.env['X']
  | "import.meta.env" // Vite/SvelteKit/Nuxt
  | "Bun.env" // Bun runtime
  | "os.environ" // Python: os.environ['X']
  | "os.environ.get" // Python: os.environ.get('X', ...)
  | "os.getenv" // Python: os.getenv('X', ...)
  | "pydantic-settings"; // Python: BaseSettings field

/**
 * A `dotenv`-family loader call. We don't link these to env vars — they are
 * the side-effect node ("this module pulls the .env into process.env"). The
 * leaf is emitted with status "loaded" so the viewer can distinguish it from
 * referenced reads.
 */
export type EnvLoaderSource =
  | "dotenv" // import 'dotenv/config' or dotenv.config()
  | "dotenv-flow"
  | "dotenv-expand"
  | "vite-define"; // (out of scope for v0.1; reserved)

/**
 * One parsed entry from a `.env*` file. The registry of these is built once
 * up-front and consumed during analyzeFile + finalize so we can mark each
 * env-read leaf with `declared: true|false`.
 */
export interface DotenvEntry {
  /** Key name as it appears in the file. */
  readonly name: string;
  /**
   * Default value from the file (post-expansion when feasible). Undefined
   * when the file uses `KEY=` with no value or the line is malformed.
   */
  readonly value: string | undefined;
  /** Repo-relative path to the `.env*` file this entry came from. */
  readonly file: string;
  /**
   * Logical environment derived from the filename: `.env.production` →
   * "production", `.env` → "default", `.env.example` → "example".
   */
  readonly environment: string;
  /** Line number (1-based) of the entry's key. */
  readonly line: number;
}

/**
 * Repo-wide registry of declared env vars, built in `detect` and frozen
 * before analyzeFile runs. Lookups are by uppercase key (env vars are
 * case-sensitive on POSIX but we match referenced reads against declarations
 * exactly — uppercase is convention only and we preserve case from the file).
 */
export interface DotenvRegistry {
  /** name → list of declarations (a key may appear in many files). */
  readonly byName: ReadonlyMap<string, ReadonlyArray<DotenvEntry>>;
  /** Flat list, used by finalize for summary diagnostics. */
  readonly entries: ReadonlyArray<DotenvEntry>;
  /** Files we successfully parsed (for the detect-evidence list). */
  readonly files: ReadonlyArray<string>;
}

/**
 * Per-file scratch state accumulated during `analyzeFile` and consumed by
 * `index.ts`. The shape carries everything an emit pass needs EXCEPT the
 * enclosing function's NodeId — that lookup is byte-containment over the
 * merged IR's function-tier nodes, which is only available in `resolve`
 * (per ts-indexer: `SymbolIndex` is pre-merge; the canonical function IDs
 * live on `IRFragment.nodes` after IDs are minted).
 *
 * So `analyzeFile` produces leaves + records the byte range; `resolve`
 * walks those leaves' provenance ranges to find the smallest containing
 * function-tier node and emits the `env-read` edge.
 */
export interface PerFileEnvFinding {
  /** The env-var name (preserves case as written in source). */
  readonly name: string;
  /** Where the reference originated. */
  readonly source: EnvReadSource;
  /** AST byte/line range for provenance. */
  readonly range: SourceRange;
  /** Inferred default (`process.env.X || 'default'`), when a literal. */
  readonly defaultValue: string | undefined;
}

/**
 * Stable parts of a leaf-id local key, joined by '|'. Kept as an interface so
 * adding fields later (e.g. a discriminator for nested-scope reads) is a
 * non-breaking change to the `localId`-encoding helper.
 */
export interface LeafIdKey {
  readonly file: string;
  readonly name: string;
  readonly source: EnvReadSource | EnvLoaderSource;
  /** N-th occurrence of this (file, name, source) triple in source order. */
  readonly occurrence: number;
}
