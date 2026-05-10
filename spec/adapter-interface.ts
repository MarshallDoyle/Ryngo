/**
 * codegraph framework adapter — public interface (draft v0.1).
 *
 * An `Adapter` is the unit of pluggable, framework-specific knowledge in
 * codegraph. Adapters consume the host's parsed AST + symbol index and emit
 * additional IR nodes/edges that the language indexers alone cannot produce
 * (HTTP routes, ORM models, IaC resources, message-bus topics, etc.).
 *
 * See `./adapter-interface.md` for rationale, lifecycle, error handling,
 * sandbox, and performance contract. This file is the load-bearing schema:
 * the host validates adapter packages against these types.
 *
 * Conventions
 * -----------
 * - All IDs are strings of the form `scheme:adapter@version:path#local-id`.
 *   Adapters mint IDs via `ctx.id.mint(...)` and may only use their own
 *   declared `scheme`. The host enforces this.
 * - All emitted nodes/edges carry provenance (`{file, range, adapter, version}`).
 * - All async work returns `Promise`; the host runs adapters in worker
 *   threads and may parallelize across files.
 * - `readonly` is used aggressively; adapter inputs are never mutable.
 */

// ---------------------------------------------------------------------------
// 1. Primitive / shared types
// ---------------------------------------------------------------------------

/** Semver string, e.g. "1.4.2". */
export type Semver = string;

/** Semver range, e.g. "^1", "~1.2", ">=1.0 <2". */
export type SemverRange = string;

/**
 * Stable, content-addressed ID. Format: `scheme:adapter@version:path#local-id`
 * for adapter-minted IDs, or `cg:<host-namespace>:...` for host-minted IDs.
 *
 * IDs are the only currency for cross-fragment, cross-adapter references.
 * They must not change between runs given identical inputs.
 */
export type IrId = string & { readonly __brand: "IrId" };

/**
 * A byte/line range inside a file. Half-open: `[start, end)`.
 * Both byte offsets and 1-based line/col positions are provided so the
 * viewer can render either without re-scanning the source.
 */
export interface SourceRange {
  readonly startByte: number;
  readonly endByte: number;
  readonly startLine: number; // 1-based
  readonly startCol: number; // 1-based
  readonly endLine: number; // 1-based
  readonly endCol: number; // 1-based
}

/**
 * Where this IR fragment came from. Stamped on every node and edge by the
 * host based on what the adapter passed to `ctx.emit(...)`. Adapters cannot
 * forge provenance; the host overwrites `adapter` and `version` from the
 * adapter descriptor.
 */
export interface Provenance {
  readonly file: string; // repo-relative path
  readonly range: SourceRange;
  readonly adapter: string; // adapter name, set by host
  readonly version: Semver; // adapter version, set by host
}

// ---------------------------------------------------------------------------
// 2. IR node and edge shapes
// ---------------------------------------------------------------------------

/**
 * Open-ended kind discriminator. Adapters define their own kinds inside
 * their namespace (e.g. `http.route`, `prisma.model`, `terraform.resource`).
 * Host-defined kinds are prefixed `cg.` (e.g. `cg.module`, `cg.file`).
 *
 * Convention: dotted lowercase, no spaces.
 */
export type NodeKind = string;
export type EdgeKind = string;

/**
 * Generic IR node. `data` is adapter-specific and MUST be JSON-serializable
 * (no functions, no class instances, no `undefined` inside arrays). The host
 * validates `data` against the adapter's declared schema (if any) and
 * persists the node to the IR file.
 */
export interface IrNode<TData extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: IrId;
  readonly kind: NodeKind;
  /** Short human-facing label (used in the viewer). */
  readonly label: string;
  /** JSON-serializable adapter-specific payload. */
  readonly data: TData;
  /** Optional grouping for the viewer (e.g. logical "API" cluster). */
  readonly group?: IrId;
  readonly provenance: Provenance;
}

/**
 * Either a fully-resolved IR id, or a deferred reference that will be
 * resolved in the `resolve` phase. Deferred references let `analyzeFile`
 * stay purely local while still describing edges that span files.
 */
export type EdgeEndpoint = IrId | DeferredRef;

/**
 * A description of "an edge endpoint I cannot resolve yet". The host hands
 * these to the emitting adapter's `resolve` phase, where they get matched
 * against peer-adapter outputs. Unmatched refs become `unresolved-edge`
 * placeholders + a warning diagnostic.
 *
 * `kind` is adapter-defined; `query` is an arbitrary serializable object.
 * Example: `{ kind: "match-route", query: { method: "GET", path: "/users" } }`.
 */
export interface DeferredRef {
  readonly __deferred: true;
  readonly kind: string;
  readonly query: Record<string, unknown>;
}

export interface IrEdge<TData extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: IrId;
  readonly kind: EdgeKind;
  readonly from: EdgeEndpoint;
  readonly to: EdgeEndpoint;
  readonly label?: string;
  readonly data?: TData;
  readonly provenance: Provenance;
}

// ---------------------------------------------------------------------------
// 3. Diagnostics
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "info" | "warn" | "error" | "unresolved-edge";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  /** Adapter-defined stable code, e.g. "fastapi/route-path-not-literal". */
  readonly code: string;
  readonly message: string;
  /** Optional source location; omit for whole-repo diagnostics. */
  readonly file?: string;
  readonly range?: SourceRange;
  /** Optional structured data (e.g. the unresolved query). */
  readonly data?: Record<string, unknown>;
  /** Optional remediation hint shown in the viewer. */
  readonly hint?: string;
}

// ---------------------------------------------------------------------------
// 4. Host-provided inputs (file, AST, symbols, fs, exec, env, ids, peers)
// ---------------------------------------------------------------------------

/**
 * The host's view of a single file. Provided to `analyzeFile`. Always
 * read-only. `ast` and `symbols` are populated only when a language
 * indexer claimed the file; non-host-language adapters (HCL, Prisma, etc.)
 * receive `ast: null` and parse `content` themselves.
 */
export interface ParsedFile {
  readonly path: string; // repo-relative
  readonly absPath: string; // absolute path
  readonly content: string;
  readonly contentHash: string; // sha256, hex
  readonly language: string | null; // "typescript" | "python" | "go" | ...
  readonly ast: AstHandle | null;
  readonly symbols: SymbolIndex | null;
  readonly sizeBytes: number;
}

/**
 * Opaque AST handle. Adapters interact with it through helpers from
 * `@codegraph/adapter-sdk` (e.g. `walk(ast, visitors)`, `query(ast, "...")`).
 * The concrete shape is tree-sitter for some languages and SCIP-derived for
 * others; we deliberately don't expose it as a typed union here so that
 * adapters write to the SDK rather than the wire format.
 */
export interface AstHandle {
  readonly _astHandle: never;
}

/**
 * Per-file symbol/reference view. Backed by the host's global symbol index
 * but scoped to the current file so adapter caching can key on it.
 */
export interface SymbolIndex {
  /** All symbols defined in this file. */
  readonly definitions: ReadonlyArray<SymbolDef>;
  /** All references in this file (to symbols defined here or elsewhere). */
  readonly references: ReadonlyArray<SymbolRef>;
  /** Look up the symbol at a given byte offset, if any. */
  readonly atOffset: (byte: number) => SymbolDef | SymbolRef | null;
}

export interface SymbolDef {
  readonly id: IrId; // host-minted; namespace `cg:<lang-indexer>:symbol::...`
  readonly name: string;
  readonly fqName: string; // fully qualified, e.g. "module.Class.method"
  readonly kind: SymbolKind;
  readonly range: SourceRange;
  readonly docComment?: string;
}

export interface SymbolRef {
  readonly target: IrId; // points to a SymbolDef
  readonly range: SourceRange;
  readonly kind: "read" | "write" | "call" | "import" | "type";
}

export type SymbolKind =
  | "module"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "function"
  | "method"
  | "field"
  | "variable"
  | "parameter"
  | "constant"
  | "decorator";

/**
 * Read-only, scoped filesystem. The host has already filtered for
 * `.gitignore`, `codegraph.config.ignore`, and max-size limits. Calls outside
 * this set throw `EACCES`.
 */
export interface ScopedFs {
  /** Read a file's bytes. */
  read(path: string): Promise<string>;
  /** Stat a path. */
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; sizeBytes: number }>;
  /**
   * Glob within the in-scope set. Patterns are picomatch-compatible.
   * Results are sorted (deterministic).
   */
  glob(pattern: string): Promise<ReadonlyArray<string>>;
  /** Whether a path is in the in-scope set. Cheap. */
  exists(path: string): Promise<boolean>;
}

/** Read-only env-var view, scoped to keys declared in `permissions.env`. */
export interface ScopedEnv {
  get(key: string): string | undefined;
  has(key: string): boolean;
}

/**
 * Run an external CLI. Only available if the adapter declares the tool in
 * `permissions.exec` and the user has allow-listed it in config. Output is
 * captured; stdin is not exposed.
 */
export interface ScopedExec {
  run(
    tool: string,
    args: ReadonlyArray<string>,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * Read-only repo configuration as parsed from `codegraph.config.{ts,json}`.
 * Adapters get only their own `adapters[].config` slice + a small set of
 * repo-level fields the host deems shareable.
 */
export interface RepoConfig {
  readonly repoRoot: string; // absolute path
  readonly adapter: Record<string, unknown>; // this adapter's config
  readonly repo: {
    readonly defaultBranch?: string;
    readonly languages: ReadonlyArray<string>;
  };
}

/**
 * Mints stable IDs in the adapter's namespace. The host enforces:
 * - `scheme` is always `cg`
 * - `adapter` matches the descriptor's `name`
 * - `version` matches the descriptor's `version`
 *
 * `localId` should be deterministic from `path` + adapter-specific keys
 * (route method/path, model name, resource type, etc.) — NOT a counter.
 */
export interface IdMinter {
  mint(args: { path: string; localId: string }): IrId;
  /** Build a deferred reference for cross-file matching in `resolve`. */
  ref(kind: string, query: Record<string, unknown>): DeferredRef;
}

/**
 * Read-only view onto a peer adapter's emitted IR. Returned by
 * `ctx.peers.get(name)` and only available if the peer was declared in
 * `deps.required` or `deps.optional`. Throws if the peer was not declared.
 *
 * Filtering by kind is the common case and the host indexes it; arbitrary
 * predicate filtering walks a snapshot.
 */
export interface PeerView {
  readonly name: string;
  readonly version: Semver;
  /** All nodes of a given kind emitted by this peer. */
  nodes<TData extends Record<string, unknown> = Record<string, unknown>>(
    kind: NodeKind,
  ): ReadonlyArray<IrNode<TData>>;
  /** All edges of a given kind emitted by this peer. */
  edges<TData extends Record<string, unknown> = Record<string, unknown>>(
    kind: EdgeKind,
  ): ReadonlyArray<IrEdge<TData>>;
  /** Look up a peer node by ID. */
  getNode(id: IrId): IrNode | null;
}

export interface PeersAccess {
  /** Get a peer's view; throws if `name` is not in declared deps. */
  get(name: string): PeerView;
  /** True if a (declared) peer adapter is active in this run. */
  has(name: string): boolean;
}

// ---------------------------------------------------------------------------
// 5. Phase contexts
// ---------------------------------------------------------------------------

/**
 * Common subset of every phase context. Adapters log via `ctx.diagnostic`
 * and emit IR via `ctx.emit`.
 */
export interface BaseContext {
  readonly config: RepoConfig;
  readonly fs: ScopedFs;
  readonly env: ScopedEnv;
  readonly exec: ScopedExec;
  readonly id: IdMinter;
  /** Emit an IR node or edge into this adapter's fragment. */
  emit(item: IrNode | IrEdge): void;
  /** Report a diagnostic. */
  diagnostic(d: Diagnostic): void;
  /**
   * Cooperative cancellation. The host triggers `signal.aborted` on
   * timeout, OOM, or user cancel. Long-running work should poll this.
   */
  readonly signal: AbortSignal;
  /** Structured logger (host decides level/destination). */
  readonly log: Logger;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Context for `detect`. Minimal — the goal is a fast yes/no. */
export interface DetectContext extends BaseContext {
  /**
   * Probe `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, etc.
   * Pre-parsed by the host so multiple adapters share the work.
   */
  readonly manifests: Manifests;
}

export interface Manifests {
  readonly packageJson: ReadonlyArray<{ path: string; data: Record<string, unknown> }>;
  readonly pyproject: ReadonlyArray<{ path: string; data: Record<string, unknown> }>;
  readonly goMod: ReadonlyArray<{ path: string; module: string; deps: ReadonlyArray<string> }>;
  readonly cargoToml: ReadonlyArray<{ path: string; data: Record<string, unknown> }>;
  readonly other: ReadonlyArray<{ path: string; raw: string }>; // adapter-supplied glob results, if any
}

/** Context for `analyzeFile`. Per-file, parallelized. */
export interface AnalyzeFileContext extends BaseContext {
  /** The file under analysis. */
  readonly file: ParsedFile;
}

/** Context for `resolve`. Single global call per adapter. */
export interface ResolveContext extends BaseContext {
  /** Read-only access to declared peer adapters' outputs. */
  readonly peers: PeersAccess;
  /**
   * Read-only access to nodes/edges this adapter itself emitted in
   * `analyzeFile`, indexed by kind. Convenience over scanning `peers`.
   */
  readonly own: Pick<PeerView, "nodes" | "edges" | "getNode">;
  /**
   * The deferred refs this adapter emitted via `ctx.id.ref(...)`. Each
   * carries the originating edge so `resolve` can replace it once matched.
   */
  readonly deferredRefs: ReadonlyArray<{
    readonly edgeId: IrId;
    readonly endpoint: "from" | "to";
    readonly ref: DeferredRef;
  }>;
  /**
   * Replace a previously deferred endpoint with a concrete IR id.
   * If never called for a given deferred ref, `finalize` (or the host's
   * default) converts it into an `unresolved-edge` placeholder.
   */
  resolveEdge(args: { edgeId: IrId; endpoint: "from" | "to"; target: IrId }): void;
}

/** Context for `finalize`. Last chance to emit summary nodes. */
export interface FinalizeContext extends BaseContext {
  readonly peers: PeersAccess;
  readonly own: Pick<PeerView, "nodes" | "edges" | "getNode">;
  /** Refs still unresolved after `resolve`; will become placeholders. */
  readonly stillUnresolved: ReadonlyArray<{
    readonly edgeId: IrId;
    readonly endpoint: "from" | "to";
    readonly ref: DeferredRef;
  }>;
}

// ---------------------------------------------------------------------------
// 6. Detect result
// ---------------------------------------------------------------------------

export type DetectResult =
  | { readonly active: false }
  | {
      readonly active: true;
      /**
       * Human-readable evidence shown in the viewer's "Adapters" panel.
       * Examples: "found 'fastapi' in pyproject.toml", "matched 14 *.tf files".
       */
      readonly evidence: ReadonlyArray<string>;
      /**
       * Optional self-reported confidence (0..1). Used only for sort order
       * in the UI; does not affect execution.
       */
      readonly confidence?: number;
    };

// ---------------------------------------------------------------------------
// 7. Permissions & dependencies
// ---------------------------------------------------------------------------

/**
 * Capabilities the adapter is requesting. Default-deny: anything not
 * declared here is unavailable. The user must allow-list these in
 * `codegraph.config.ts`.
 */
export interface AdapterPermissions {
  /** Network hosts this adapter may contact. Empty/unset means none. */
  readonly network?: ReadonlyArray<string>;
  /** External CLIs this adapter may invoke via `ctx.exec`. */
  readonly exec?: ReadonlyArray<string>;
  /** Env-var keys exposed via `ctx.env`. */
  readonly env?: ReadonlyArray<string>;
}

/**
 * Inter-adapter dependencies. The host computes a topological order per
 * phase and aborts on cycles.
 */
export interface AdapterDeps {
  /** Adapters that MUST be active and matching the range; otherwise the run aborts. */
  readonly required?: ReadonlyArray<{ name: string; range: SemverRange }>;
  /** Adapters consumed if present, ignored otherwise. */
  readonly optional?: ReadonlyArray<{ name: string; range: SemverRange }>;
  /**
   * Pure ordering hints: "run after these". No data dep, no version pin.
   * Used to break ties when two adapters are otherwise unordered.
   */
  readonly after?: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// 8. The Adapter interface itself
// ---------------------------------------------------------------------------

/**
 * The descriptor an adapter package's default export must conform to.
 * All phase methods are optional; an adapter only implements what it needs.
 * If `detect` is omitted the adapter is treated as always-active (rare;
 * usually a smell unless the adapter is a host-bundled language indexer).
 */
export interface Adapter {
  /** Globally-unique adapter name, e.g. "fastapi", "prisma", "terraform". */
  readonly name: string;

  /** Adapter's own semver. Bumped on every release. */
  readonly version: Semver;

  /**
   * Major version of `@codegraph/adapter-sdk` this adapter was built
   * against. The host refuses to load incompatible adapters.
   */
  readonly apiVersion: number;

  /** One-line human description for the viewer. */
  readonly description: string;

  /** Optional URL to docs / homepage. */
  readonly homepage?: string;

  /**
   * IR ID scheme this adapter owns. Must be unique. The host rejects an
   * adapter whose scheme collides with another active adapter or a host
   * namespace. Convention: same as `name`.
   */
  readonly idScheme: string;

  /** Capability declarations; see `AdapterPermissions`. */
  readonly permissions?: AdapterPermissions;

  /** Inter-adapter dependencies; see `AdapterDeps`. */
  readonly deps?: AdapterDeps;

  /**
   * Whether `analyzeFile` outputs are cacheable across runs. Default true.
   * Set false only if `analyzeFile` reads global state that isn't part of
   * the cache key (rare; prefer doing such work in `resolve`).
   */
  readonly cacheable?: boolean;

  /**
   * File predicate for `analyzeFile`. The host calls `analyzeFile` only on
   * matching files. Cheap pure function; avoid I/O.
   */
  readonly appliesTo?: (file: Pick<ParsedFile, "path" | "language" | "sizeBytes">) => boolean;

  /**
   * Optional kinds this adapter declares it will emit. Used by the host
   * for schema validation, viewer legend rendering, and to let downstream
   * adapters declare typed peer dependencies.
   */
  readonly declares?: {
    readonly nodeKinds?: ReadonlyArray<NodeKind>;
    readonly edgeKinds?: ReadonlyArray<EdgeKind>;
    readonly diagnosticCodes?: ReadonlyArray<string>;
  };

  // -------------------------------------------------------------------------
  // Phase methods (all optional)
  // -------------------------------------------------------------------------

  /**
   * Determine whether this adapter applies to the current repo. Cheap;
   * target <50ms. No IR is emitted. If omitted, the adapter is always
   * active.
   */
  detect?(ctx: DetectContext): Promise<DetectResult> | DetectResult;

  /**
   * Per-file analysis. Local — must NOT depend on results from other files.
   * Cross-file work goes in `resolve`. May be called in parallel for
   * different files; do not use module-level mutable state.
   */
  analyzeFile?(ctx: AnalyzeFileContext): Promise<void> | void;

  /**
   * Global resolution pass. Runs once after every adapter has finished
   * `analyzeFile` for every file. This is where deferred refs are matched
   * to concrete IDs (e.g. matching frontend `fetch` URLs to backend routes).
   */
  resolve?(ctx: ResolveContext): Promise<void> | void;

  /**
   * Last call. Emit summary nodes; convert any still-unresolved refs into
   * `unresolved-edge` diagnostics if you want adapter-specific messaging
   * (otherwise the host emits a generic one).
   */
  finalize?(ctx: FinalizeContext): Promise<void> | void;
}

/**
 * The shape of an adapter package's default export. A factory keeps the
 * descriptor pure (no I/O at registration time) and lets the host hand the
 * adapter optional config from `codegraph.config.ts`.
 */
export type AdapterFactory<TUserConfig = unknown> = (userConfig?: TUserConfig) => Adapter;

// ---------------------------------------------------------------------------
// 9. Output (per-adapter run summary, surfaced to the host & viewer)
// ---------------------------------------------------------------------------

/**
 * Aggregated, post-run summary the host computes for each adapter. Adapters
 * do not construct this directly; it is exposed here for downstream tools
 * (CLI, viewer, GitHub Action) that consume the IR sidecar file.
 */
export interface AdapterOutput {
  readonly name: string;
  readonly version: Semver;
  readonly active: boolean;
  readonly detectEvidence: ReadonlyArray<string>;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly timings: {
    readonly detectMs: number;
    readonly analyzeFileMs: number; // sum across all files
    readonly resolveMs: number;
    readonly finalizeMs: number;
  };
  /** True if the adapter failed in any phase; its IR for that phase was dropped. */
  readonly failed: boolean;
}

// ---------------------------------------------------------------------------
// 10. AdapterContext type alias
// ---------------------------------------------------------------------------

/**
 * Convenience union for code that needs to accept any phase context (e.g.
 * a helper that emits a node from arbitrary phase code). Prefer the
 * specific phase context type when you know the phase.
 */
export type AdapterContext =
  | DetectContext
  | AnalyzeFileContext
  | ResolveContext
  | FinalizeContext;
