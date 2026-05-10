/**
 * Shared types for tree-sitter Tier-B indexers (TypeScript/JavaScript, Python,
 * and any further `.scm`-driven languages we add later).
 *
 * These types intentionally sit *between* the raw tree-sitter output and the
 * canonical IR (`spec/ir.types.ts`). A language indexer produces an
 * `IRFragment` of *candidates* — the resolution metadata (`resolution`,
 * `candidate_group_id`) is preserved on every edge so the downstream
 * fragment-merger / resolver in `core/src/indexers/` can:
 *   1. de-duplicate against SCIP-resolved edges (SCIP wins),
 *   2. promote `name-match` edges to `import` if a later cross-file pass
 *      finds the right target,
 *   3. emit dashed edges in the viewer for anything that stays unresolved.
 *
 * Why our own `ParsedFile` shape (rather than reusing
 * `spec/adapter-interface.ts#ParsedFile`)?
 *   - The adapter-side `ParsedFile` carries an opaque `ast: AstHandle | null`
 *     populated *by the language indexer*. We are the language indexer, so we
 *     own the parse step ourselves and don't accept a pre-parsed AST.
 *   - Adapters get a host-minted `SymbolIndex`. Our job is to *produce* the
 *     symbols, not consume one.
 *   - Keeping these types decoupled means the tree-sitter pipeline can run in
 *     either Node (native bindings) or the browser (WASM) without dragging in
 *     adapter-SDK assumptions.
 *
 * py-indexer (Python) and ts-indexer (TypeScript/JavaScript) both implement
 * `LanguageIndexer<ParsedFile, IRFragment>` against this file. Coordinate any
 * shape changes with the other indexer before merging.
 */

// =============================================================================
// Input: a parsed file ready for tree-sitter querying
// =============================================================================

/**
 * Source language tag, kept narrow on purpose. Drives grammar selection and
 * `.scm` query routing.
 */
export type SupportedLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python";

/**
 * What a tree-sitter indexer is handed for a single file.
 *
 * `tree` is opaque: at the type level it's `unknown` because the in-memory
 * `Tree` type from `web-tree-sitter` is not exported as a stable shape we want
 * to leak to siblings (and is different again in native bindings). The
 * indexer downcasts internally where it's borrowed by query execution.
 */
export interface ParsedFile {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** Absolute path on disk. */
  readonly absPath: string;
  /** Raw UTF-8 source. Required: byte offsets in the tree are into this. */
  readonly source: string;
  /** sha256 of `source`, lowercase hex. Cache key for query results. */
  readonly contentHash: string;
  /** Language tag picked by the host walker (extension-driven). */
  readonly language: SupportedLanguage;
  /**
   * The parsed `Tree` from web-tree-sitter / native bindings. Opaque to
   * callers; produced by the runtime adapter (`runtime-native.ts` /
   * `runtime-wasm.ts`).
   */
  readonly tree: unknown;
  /** File size in bytes. Used by the big-file fallback (>4 MiB). */
  readonly sizeBytes: number;
}

// =============================================================================
// Output: an IRFragment of candidate nodes and edges
// =============================================================================

/**
 * Resolution confidence on every edge an indexer produces. The downstream
 * merger uses this to draw solid vs dashed lines and to decide whether SCIP
 * output should override (research/tree-sitter.md §1: SCIP wins on conflict).
 *
 * Mirrors §4.4 of `research/tree-sitter.md`, plus the `scip` provenance
 * value used by `scip-ingest` so SCIP-resolved edges stay distinguishable
 * from tree-sitter's same-file lexical hits — without that distinction the
 * merger can't apply the SCIP-wins rule, and the `tags: ['resolution:scip']`
 * projection ir-types specified would lose information.
 *
 *   - `scip`        SCIP indexer resolved this. Highest confidence.
 *   - `exact`       Tree-sitter same-file lexical scope match (§4.1).
 *   - `imported`    Cross-file via the import map (§4.2).
 *   - `name-match`  Project-wide name match, unique or ambiguous (§4.3).
 *   - `unresolved`  No candidate, or > N candidates (§4.4 dashed-to-stub).
 *
 * The `candidateGroupId` on `name-match` ties multiple candidate edges
 * together so the viewer can render them as a single dashed bundle.
 */
export type Resolution =
  | "scip"
  | "exact"
  | "imported"
  | "name-match"
  | "unresolved";

/**
 * IR-node candidate. Mirrors the IR `Node` tiers (`function`, `type`,
 * `expression`) but stripped down to what tree-sitter can statically observe.
 * Identity (BLAKE3 of canonical signature) is computed by the merger — we
 * just hand it the components in `signatureParts`.
 */
export interface IRNodeCandidate {
  /** Tier in the canonical IR taxonomy. `module` is emitted once per file. */
  readonly tier: "module" | "type" | "function" | "expression";
  /** Identifier name as it appears in source. */
  readonly name: string;
  /**
   * Components the merger will join (with `|`) and BLAKE3 to mint the node
   * id. Order matters — must match the tier table in `spec/ir-schema.md` §6.
   */
  readonly signatureParts: ReadonlyArray<string>;
  /**
   * Local key used by edges in *this same fragment* to refer to this node
   * before merger-time IDs exist. Stable within one `index()` call.
   */
  readonly localId: string;
  /** Tier-specific metadata, stamped onto the final IR node verbatim. */
  readonly meta: NodeMeta;
  /** Source location (range in the file). NEVER part of identity. */
  readonly loc: NodeLoc;
}

export type NodeMeta =
  | ModuleMeta
  | TypeMeta
  | FunctionMeta
  | ExpressionMeta;

export interface ModuleMeta {
  readonly tier: "module";
}

export interface TypeMeta {
  readonly tier: "type";
  /** Open kind: class, interface, type-alias, enum, struct, ... */
  readonly kind: string;
  readonly exported: boolean;
  /**
   * Class-body / interface-body annotated members. Mirrors `TypeNode.fields`
   * in `spec/ir.types.ts` — ir-types decided fields stay nested on the parent
   * type rather than becoming separate `field`-kind tier:type nodes (DM
   * relayed via team-lead). Annotation is surface-form text; adapters
   * slice/parse it themselves.
   */
  readonly fields?: ReadonlyArray<TypeFieldDecl>;
}

/**
 * Class-property / interface-property declaration captured during indexing.
 * Mirrors `TypeFieldDecl` in `spec/ir.types.ts`; `typeDisplay` is the surface
 * form (e.g. `"string"`, `"User | null"`, `"Optional[Settings]"`) — the
 * merger lifts it into a structured `TypeRef` when projecting to canonical
 * IR.
 */
export interface TypeFieldDecl {
  readonly name: string;
  readonly typeDisplay: string;
  readonly optional?: boolean;
  readonly readonly?: boolean;
  readonly loc: NodeLoc;
}

export interface FunctionMeta {
  readonly tier: "function";
  /** function | method | lambda | ctor | getter | setter | component */
  readonly kind: string;
  readonly exported: boolean;
  readonly asyncness: "sync" | "async" | "generator" | "async-generator";
  /** Param names + surface-form type displays (annotation, else `unknown`). */
  readonly params: ReadonlyArray<{ name: string; typeDisplay: string }>;
  /** Surface-form return type display. */
  readonly returnTypeDisplay: string;
  /** Receiver type display when this is a method on a class. */
  readonly receiverTypeDisplay?: string;
  /** Local id of the enclosing type, when this function is a method. */
  readonly enclosingTypeLocalId?: string;
}

export interface ExpressionMeta {
  readonly tier: "expression";
  /** call | literal | member | identifier | ... */
  readonly role: string;
  /** Optional canonicalized payload for literals. */
  readonly payload?: string;
}

export interface NodeLoc {
  readonly startByte: number;
  readonly endByte: number;
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly endCol: number;
}

/**
 * IR-edge candidate. Source/target reference *local ids* of nodes within the
 * same fragment OR a deferred cross-file reference (see `targetRef`). The
 * merger replaces local ids with BLAKE3 ids and resolves `targetRef` against
 * the project-wide symbol table.
 */
export interface IREdgeCandidate {
  /** Edge category in the canonical IR taxonomy. */
  readonly category: "call" | "import" | "type-flow";
  /** Local id of the originating node in this fragment. */
  readonly sourceLocalId: string;
  /**
   * Resolved target — set when the indexer resolved the reference at parse
   * time (e.g. `exact` lexical scope match within the same file).
   */
  readonly targetLocalId?: string;
  /**
   * Deferred target — set when resolution requires cross-file info. The
   * merger looks this up against the project-wide symbol index and, on
   * miss, demotes the edge to an `unresolved` stub.
   */
  readonly targetRef?: DeferredTargetRef;
  /** Resolution confidence; required on every edge per the task spec. */
  readonly resolution: Resolution;
  /**
   * Groups multiple `name-match` candidates that arose from the same
   * unresolved name. The merger emits one dashed edge per candidate but the
   * viewer treats the group as one logical "ambiguous reference".
   */
  readonly candidateGroupId?: string;
  /** Source location of the reference site (call site, import statement). */
  readonly loc: NodeLoc;
  /** Edge-category-specific metadata. */
  readonly meta: EdgeMeta;
}

/**
 * A reference to a target the file-local pass couldn't bind. The merger
 * resolves these in a second pass.
 */
export interface DeferredTargetRef {
  /**
   * Strategy hint:
   *  - `import-map`: leftmost segment is `importLocal` from this file's
   *    import map; resolve the module then look up the symbol.
   *  - `name-match`: bare name; look up across the project name index.
   *  - `module`: the target is a module (file), not a symbol within one.
   */
  readonly strategy: "import-map" | "name-match" | "module";
  /** Bare name (`Foo`) or dotted/selector path (`pkg.Func`). */
  readonly name: string;
  /** For `import-map`: the local binding name in this file. */
  readonly importLocal?: string;
  /**
   * For `import-map` / `module`: the module specifier exactly as written in
   * the import statement (e.g. `react`, `./bar`, `foo.bar`). Resolved
   * downstream against tsconfig paths / package.json exports / Python
   * `sys.path`.
   */
  readonly moduleSpecifier?: string;
}

export type EdgeMeta = CallEdgeMeta | ImportEdgeMeta | TypeFlowEdgeMeta;

export interface CallEdgeMeta {
  readonly category: "call";
  readonly callKind?: "direct" | "virtual" | "constructor" | "super";
  readonly awaited?: boolean;
}

export interface ImportEdgeMeta {
  readonly category: "import";
  readonly specifier: string;
  /** Empty array for namespace/star imports. */
  readonly symbols: ReadonlyArray<string>;
  readonly kind?: "static" | "dynamic" | "type-only" | "side-effect";
}

export interface TypeFlowEdgeMeta {
  readonly category: "type-flow";
  /**
   * `subscript` covers `obj['KEY']`-style index reads (TS `process.env['X']`,
   * Python `os.environ['DATABASE_URL']`). The literal key is on
   * `subscriptKey`. Coordinated with py-indexer + adapter-env.
   */
  readonly role?:
    | "argument"
    | "return"
    | "assign"
    | "field-read"
    | "field-write"
    | "subscript";
  readonly argIndex?: number;
  /** For role:'subscript', the literal key from the index expression. */
  readonly subscriptKey?: string;
}

/**
 * The unit of work an indexer produces per file. The fragment-merger
 * concatenates fragments across files into a single IR document.
 *
 * Per `research/tree-sitter.md` §3, every fragment carries the `(grammar,
 * grammarVersion, queryHash)` tuple so the on-disk cache (`§5.1`) can
 * invalidate this slice when grammar or queries change without touching
 * fragments from unrelated languages.
 */
export interface IRFragment {
  /** Repo-relative POSIX path of the file this fragment came from. */
  readonly path: string;
  /** Indexer name (e.g. "tree-sitter-typescript"). Stamped on metadata.generators. */
  readonly indexer: string;
  /** Indexer version, sourced from package.json. */
  readonly indexerVersion: string;
  /** Grammar identifier (e.g. "tree-sitter-typescript"). */
  readonly grammar: string;
  /** Pinned grammar version that produced this fragment. */
  readonly grammarVersion: string;
  /** Hash of the `.scm` query file content (cache invalidation key). */
  readonly queryHash: string;
  /** Indexed file's content hash; combined with queryHash for cache lookup. */
  readonly contentHash: string;

  readonly nodes: ReadonlyArray<IRNodeCandidate>;
  readonly edges: ReadonlyArray<IREdgeCandidate>;

  /**
   * Per-file import map. Drives `import-map` resolution in `targetRef`.
   * Keys are local binding names; values describe what they refer to.
   */
  readonly imports: ReadonlyArray<ImportRecord>;

  /** Diagnostics local to this file — empty in the happy path. */
  readonly diagnostics: ReadonlyArray<{
    readonly severity: "info" | "warn" | "error";
    readonly code: string;
    readonly message: string;
    readonly loc?: NodeLoc;
  }>;
}

export interface ImportRecord {
  /** Module path or specifier as written ('react', './foo', 'foo.bar'). */
  readonly specifier: string;
  /** What the file binds the import as in its lexical scope. */
  readonly local: string;
  /**
   *  - `default`: `import x from 'foo'`
   *  - `named`:   `import { x } from 'foo'` or `import { x as y } from 'foo'`
   *  - `namespace`: `import * as x from 'foo'` or `import foo` (Python)
   *  - `side-effect`: `import 'foo'`
   *  - `wildcard`: `from foo import *` — flagged but not resolved (§4.6)
   */
  readonly kind: "default" | "named" | "namespace" | "side-effect" | "wildcard";
  /** For named imports, the name in the source module (before `as`). */
  readonly imported?: string;
  /** True for TypeScript `import type {...}` */
  readonly typeOnly?: boolean;
  readonly loc: NodeLoc;
}

// =============================================================================
// Indexer interface — implemented by typescript.ts, python.ts, …
// =============================================================================

export interface LanguageIndexer {
  readonly name: string;
  readonly version: string;
  readonly grammar: string;
  readonly grammarVersion: string;
  /** Languages this indexer claims. The walker dispatches on extension. */
  readonly languages: ReadonlyArray<SupportedLanguage>;

  /** Parse + query + resolve cascade. Pure function of `file`. */
  index(file: ParsedFile): IRFragment;
}
