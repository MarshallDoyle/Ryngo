/**
 * codegraph IR — canonical TypeScript types (schema v0.1.0)
 *
 * This module is the single source of truth for the IR shape. It mirrors the
 * normative JSON Schema at `spec/ir.schema.json` 1:1 and is the type-system
 * contract every other workspace package consumes — indexers, adapters, the
 * validator, the diff engine, the viewer, and the GitHub Action all import
 * from here (re-exported via `@codegraph/core` and the `@codegraph/core/ir`
 * subpath; see this package's package.json).
 *
 * Conventions
 * -----------
 *  - Open enums (`tier`, edge `category`, leaf/sink `flavor`, `lang`, ...)
 *    are typed as a known-string union joined with `(string & {})` or
 *    `` `x-${string}` ``. The closed values keep autocomplete; analyzer
 *    extensions still typecheck.
 *  - Discriminator-keyed unions (`Node`, `Edge`, `Leaf`, `Sink`,
 *    `StructuralType`) match the JSON Schema `oneOf` over the discriminator
 *    field. Use the exported type guards instead of manual tag checks.
 *  - `NodeId` is a branded opaque string. It is the lowercase hex form of
 *    a BLAKE3-128 digest over the node's canonical signature; two IDs
 *    being equal means *the same logical node*, even across commits.
 *
 * Forward-compatibility
 * ---------------------
 *  - New tiers / edge categories / leaf-or-sink flavors are introduced via
 *    `x-${string}` values. Old viewers fall through to the
 *    `UnknownTierNode` / `UnknownEdge` / `LeafUnknown` / `SinkUnknown`
 *    branches, never crash on unknown discriminators.
 *  - `Metadata` and `GeneratorInfo` carry an `index signature` so analyzers
 *    can stamp extra hints without a type bump.
 *  - Every "known X" array is exported as a `const` so v0.1 consumers can
 *    enumerate the closed set (filter UIs, fixture coverage checks).
 */

// =============================================================================
// Top level
// =============================================================================

/** Root IR document. */
export interface IRDocument {
  /** Semver of the IR schema. v0.1.0 at time of writing. */
  schemaVersion: SchemaVersion;
  ir: IR;
}

/** Semver string. Looser TS type than the JSON Schema regex. */
export type SchemaVersion =
  | `${number}.${number}.${number}`
  | `${number}.${number}.${number}-${string}`;

export interface IR {
  metadata: Metadata;
  nodes: Node[];
  edges: Edge[];
  /** Optional analyzer-emitted notes. Never affects topology. */
  diagnostics?: Diagnostic[];
}

export interface Metadata {
  /** Canonical repo identifier (URL or local path; empty string allowed). */
  repo: string;
  /** Commit SHA or equivalent VCS revision. */
  commit: string;
  /** ISO-8601 timestamp. */
  generatedAt: string;
  /** One entry per analyzer/adapter that contributed to this IR. */
  generators: GeneratorInfo[];
  /** Open for forward-compatible additions. */
  [key: string]: unknown;
}

export interface GeneratorInfo {
  name: string;
  version: string;
  [key: string]: unknown;
}

// =============================================================================
// Identity & shared primitives
// =============================================================================

/**
 * BLAKE3-128 hex digest of the node's canonical signature, lowercase.
 * Branded so accidental string mixing is caught at compile time.
 *
 * Construct via `asNodeId(...)` after the indexer has computed the digest;
 * never hand-roll branded values from arbitrary strings in production code.
 */
export type NodeId = string & { readonly __brand: "NodeId" };

/**
 * Brand a raw hex string as a NodeId. Trusts the caller to have produced a
 * valid BLAKE3-128 lowercase hex digest; use only at the indexer/loader
 * boundary where validation has already happened.
 */
export const asNodeId = (s: string): NodeId => s as NodeId;

/** Source language tag. Open string. */
export type Lang =
  | "ts" | "tsx" | "js" | "jsx"
  | "py" | "go" | "rs"
  | "java" | "kt" | "rb" | "php" | "cs" | "swift" | "scala"
  | "sql" | "none"
  | (string & {});

/** A reference to a type in some source language's surface type system. */
export interface TypeRef {
  lang: Lang;
  /** Human-readable type form, used as the edge label. */
  display: string;
  /** Optional structural decomposition. */
  structural?: StructuralType;
  nullable?: boolean;
  source?: "annotated" | "inferred" | "unknown";
}

export type StructuralType =
  | { kind: "primitive"; name: string }
  | { kind: "ref"; name: string }
  | { kind: "generic"; name: string; args: StructuralType[] }
  | { kind: "union"; args: StructuralType[] }
  | { kind: "intersection"; args: StructuralType[] }
  | { kind: "tuple"; args: StructuralType[] }
  | { kind: "record"; fields: StructuralField[] }
  | { kind: "function"; args: StructuralType[]; ret?: StructuralType }
  | { kind: "literal"; value: unknown }
  | { kind: "any" }
  | { kind: "unknown" };

export interface StructuralField {
  name: string;
  type: StructuralType;
  optional?: boolean;
}

export interface SourceLoc {
  /** Repo-relative POSIX path. */
  path: string;
  startLine?: number;
  startCol?: number;
  endLine?: number;
  endCol?: number;
}

// =============================================================================
// Nodes
// =============================================================================

/**
 * Node tier discriminator. Open via `x-*` for forward compatibility.
 *
 * Exported under two names: `NodeTier` (consumer-facing — most teammates
 * import this name) and `Tier` (the JSON-Schema-aligned short name kept
 * for parity with `spec/ir.types.ts`). Both refer to the same union.
 */
export type NodeTier =
  | "service"
  | "module"
  | "type"
  | "function"
  | "expression"
  | `x-${string}`;

/** Alias: same union as `NodeTier`. Kept for parity with the JSON Schema. */
export type Tier = NodeTier;

/** Common node fields. Concrete tiers narrow these. */
interface NodeBase {
  id: NodeId;
  /** The canonical signature string the id is derived from. Opaque to viewers. */
  signature: string;
  /** Required for everything except `service` (which is the root). */
  parentId?: NodeId;
  name?: string;
  lang?: Lang;
  doc?: string;
  /** Optional source location hint. NEVER part of node identity. */
  loc?: SourceLoc;
  /** Free-form tags ('deprecated', 'test-only', ...). Open vocabulary. */
  tags?: string[];
}

export interface ServiceNode extends NodeBase {
  tier: "service";
  name: string;
  /** Repo-relative POSIX path to the service root. */
  path: string;
  manifest?: string;
}

export interface ModuleNode extends NodeBase {
  tier: "module";
  parentId: NodeId;
  name: string;
  /** Repo-relative POSIX path to the source file. */
  path: string;
}

/** Open enum for type-node kind. */
export type TypeKind =
  | "class" | "interface" | "struct" | "enum"
  | "type-alias" | "trait" | "protocol" | "union"
  | (string & {});

export interface TypeFieldDecl {
  name: string;
  type: TypeRef;
  optional?: boolean;
  readonly?: boolean;
}

export interface TypeNode extends NodeBase {
  tier: "type";
  parentId: NodeId;
  name: string;
  kind: TypeKind;
  exported?: boolean;
  fields?: TypeFieldDecl[];
}

/** Open enum for function-node kind. */
export type FunctionKind =
  | "function" | "method" | "lambda"
  | "ctor" | "dtor" | "getter" | "setter"
  | "async" | "generator" | "component"
  | (string & {});

export interface FunctionParam {
  name: string;
  type?: TypeRef;
  optional?: boolean;
  rest?: boolean;
}

export interface FunctionNode extends NodeBase {
  tier: "function";
  parentId: NodeId;
  name: string;
  kind: FunctionKind;
  exported?: boolean;
  /** True iff transitively no sink reachable from this function. */
  pure: boolean;
  params: FunctionParam[];
  returnType?: TypeRef;
  /** Set on methods; type of `this`/`self`. */
  receiverType?: TypeRef;
  asyncness?: "sync" | "async" | "generator" | "async-generator";
}

export interface ExpressionNode extends NodeBase {
  tier: "expression";
  parentId: NodeId;
  /** Hint for the analyzer-to-viewer pipeline. Open vocabulary. */
  role?: string;
  pure: boolean;
  /** Either, both, or neither of `leaf`/`sink` may be set. */
  leaf?: Leaf;
  sink?: Sink;
  /** The static type of this expression's value, when known. */
  valueType?: TypeRef;
}

/** Forward-compatibility escape hatch for new tiers. */
export interface UnknownTierNode {
  tier: `x-${string}`;
  id: NodeId;
  signature: string;
  parentId?: NodeId;
  name?: string;
  /** Unknown extra data lives here. */
  [key: string]: unknown;
}

/** Discriminated union over `tier`. */
export type Node =
  | ServiceNode
  | ModuleNode
  | TypeNode
  | FunctionNode
  | ExpressionNode
  | UnknownTierNode;

// =============================================================================
// Leaves (sources of value)
// =============================================================================

export type LeafFlavor =
  | "literal"
  | "env"
  | "config-file"
  | "cli-arg"
  | "http-input"
  | "db-read"
  | "external-api"
  | `x-${string}`;

export interface LeafLiteral {
  flavor: "literal";
  /** Canonicalized literal payload. */
  value: string | number | boolean | null | unknown[] | Record<string, unknown>;
  valueLang?: Lang;
}

export interface LeafEnv {
  flavor: "env";
  /** Environment variable name. */
  name: string;
  defaultValue?: unknown;
}

export type ConfigFormat = "json" | "yaml" | "toml" | "env" | "ini" | "xml" | "other";

export interface LeafConfigFile {
  flavor: "config-file";
  /** Repo-relative or absolute path; analyzers should normalize. */
  path: string;
  format?: ConfigFormat;
  /** Specific key path read, when known (e.g. "database.host"). */
  key?: string;
}

export interface LeafCliArg {
  flavor: "cli-arg";
  /** Flag name when known (e.g. "--port"). */
  name?: string;
  /** Positional index when known. */
  index?: number;
}

export type HttpInputFrom = "body" | "query" | "path" | "header" | "cookie" | "form" | "multipart";

export interface LeafHttpInput {
  flavor: "http-input";
  from: HttpInputFrom;
  /** Field/parameter name when known. */
  field?: string;
}

/** DB-read leaf: shared shape with the db-read sink-side annotation. */
export interface LeafDbRead {
  flavor: "db-read";
  /** Open: postgres, mysql, sqlite, mongo, redis, dynamodb, kv, ... */
  store: string;
  entity?: string;
  /** Open: select, find, findUnique, findMany, scan, ... */
  op?: string;
  fields?: string[];
}

export interface LeafExternalApi {
  flavor: "external-api";
  /** URL or URL pattern when statically derivable. */
  url?: string;
  /** Logical service name when known (e.g. "stripe"). */
  service?: string;
  kind?: "http" | "grpc" | "graphql" | "websocket" | "other";
}

/** Forward-compatibility escape hatch for new leaf flavors. */
export interface LeafUnknown {
  flavor: `x-${string}`;
  [key: string]: unknown;
}

export type Leaf =
  | LeafLiteral
  | LeafEnv
  | LeafConfigFile
  | LeafCliArg
  | LeafHttpInput
  | LeafDbRead
  | LeafExternalApi
  | LeafUnknown;

// =============================================================================
// Sinks (destinations of value)
// =============================================================================

export type SinkFlavor =
  | "db-write"
  | "network"
  | "fs"
  | "exec"
  | "log"
  | `x-${string}`;

export interface SinkDbWrite {
  flavor: "db-write";
  store: string;
  entity?: string;
  /** Open: insert, update, upsert, delete, create, ... */
  op?: string;
  fields?: string[];
}

export interface SinkNetwork {
  flavor: "network";
  /** HTTP verb when applicable. */
  method?: string;
  url?: string;
  kind?: "http" | "grpc" | "graphql" | "websocket" | "tcp" | "udp" | "other";
}

export interface SinkFs {
  flavor: "fs";
  op: "write" | "read" | "append" | "delete" | "rename" | "chmod" | "mkdir" | "stat" | "other";
  path?: string;
}

export interface SinkExec {
  flavor: "exec";
  command?: string;
  /** True if invoked via a shell (security-relevant). */
  shell?: boolean;
}

export interface SinkLog {
  flavor: "log";
  level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "other";
  logger?: string;
}

/** Forward-compatibility escape hatch for new sink flavors. */
export interface SinkUnknown {
  flavor: `x-${string}`;
  [key: string]: unknown;
}

export type Sink =
  | SinkDbWrite
  | SinkNetwork
  | SinkFs
  | SinkExec
  | SinkLog
  | SinkUnknown;

// =============================================================================
// Edges
// =============================================================================

/** Edge category. Open via `x-*`. */
export type EdgeCategory =
  | "call"
  | "import"
  | "type-flow"
  | "http-route"
  | "db-read"
  | "db-write"
  | "env-read"
  | "fs-read"
  | "fs-write"
  | "network"
  | "exec"
  | `x-${string}`;

interface EdgeBase {
  sourceId: NodeId;
  targetId: NodeId;
  category: EdgeCategory;
  /** What kind of value flows along this edge, in source-language type form. */
  valueType?: TypeRef;
  /** True if the edge is only taken on some control-flow paths. */
  conditional?: boolean;
  tags?: string[];
}

export interface CallEdge extends EdgeBase {
  category: "call";
  callKind?: "direct" | "virtual" | "dynamic" | "constructor" | "super" | "tail";
  awaited?: boolean;
}

export interface ImportEdge extends EdgeBase {
  category: "import";
  /** The literal import specifier as written ('react', './foo'). */
  specifier?: string;
  /** Imported symbol names; empty for namespace/star imports. */
  symbols?: string[];
  kind?: "static" | "dynamic" | "type-only" | "side-effect";
}

export interface TypeFlowEdge extends EdgeBase {
  category: "type-flow";
  role?: "argument" | "return" | "assign" | "field-read" | "field-write" | "yield" | "throw" | "read";
  /** When `role === "argument"`. */
  argIndex?: number;
}

export interface HttpRouteEdge extends EdgeBase {
  category: "http-route";
  method?: string;
  /** Open: express, fastify, koa, nextjs, fastapi, flask, rails, gin, ... */
  framework?: string;
}

export interface DbReadEdge extends EdgeBase {
  category: "db-read";
  store?: string;
  entity?: string;
}

export interface DbWriteEdge extends EdgeBase {
  category: "db-write";
  store?: string;
  entity?: string;
  op?: string;
}

export interface EnvReadEdge extends EdgeBase {
  category: "env-read";
  name?: string;
}

export interface FsReadEdge extends EdgeBase {
  category: "fs-read";
  path?: string;
}

export interface FsWriteEdge extends EdgeBase {
  category: "fs-write";
  path?: string;
  op?: "write" | "append" | "delete" | "rename" | "chmod" | "mkdir" | "other";
}

export interface NetworkEdge extends EdgeBase {
  category: "network";
  method?: string;
  url?: string;
  kind?: "http" | "grpc" | "graphql" | "websocket" | "tcp" | "udp" | "other";
}

export interface ExecEdge extends EdgeBase {
  category: "exec";
  command?: string;
  shell?: boolean;
}

/** Forward-compatibility escape hatch for new edge categories. */
export interface UnknownEdge {
  sourceId: NodeId;
  targetId: NodeId;
  category: `x-${string}`;
  [key: string]: unknown;
}

/** Discriminated union over `category`. */
export type Edge =
  | CallEdge
  | ImportEdge
  | TypeFlowEdge
  | HttpRouteEdge
  | DbReadEdge
  | DbWriteEdge
  | EnvReadEdge
  | FsReadEdge
  | FsWriteEdge
  | NetworkEdge
  | ExecEdge
  | UnknownEdge;

// =============================================================================
// Diagnostics
// =============================================================================

export interface Diagnostic {
  severity: "info" | "warn" | "error";
  analyzer: string;
  message: string;
  /** Decorate this node with the diagnostic. */
  nodeId?: NodeId;
  /** Stable code, analyzer-namespaced (e.g. "tsc/cannot-resolve-import"). */
  code?: string;
}

// =============================================================================
// Type guards (cheap, no runtime deps)
// =============================================================================

export const isServiceNode    = (n: Node): n is ServiceNode    => n.tier === "service";
export const isModuleNode     = (n: Node): n is ModuleNode     => n.tier === "module";
export const isTypeNode       = (n: Node): n is TypeNode       => n.tier === "type";
export const isFunctionNode   = (n: Node): n is FunctionNode   => n.tier === "function";
export const isExpressionNode = (n: Node): n is ExpressionNode => n.tier === "expression";
export const isUnknownTierNode = (n: Node): n is UnknownTierNode =>
  typeof n.tier === "string" && n.tier.startsWith("x-");

export const isCallEdge      = (e: Edge): e is CallEdge      => e.category === "call";
export const isImportEdge    = (e: Edge): e is ImportEdge    => e.category === "import";
export const isTypeFlowEdge  = (e: Edge): e is TypeFlowEdge  => e.category === "type-flow";
export const isHttpRouteEdge = (e: Edge): e is HttpRouteEdge => e.category === "http-route";
export const isDbReadEdge    = (e: Edge): e is DbReadEdge    => e.category === "db-read";
export const isDbWriteEdge   = (e: Edge): e is DbWriteEdge   => e.category === "db-write";
export const isEnvReadEdge   = (e: Edge): e is EnvReadEdge   => e.category === "env-read";
export const isFsReadEdge    = (e: Edge): e is FsReadEdge    => e.category === "fs-read";
export const isFsWriteEdge   = (e: Edge): e is FsWriteEdge   => e.category === "fs-write";
export const isNetworkEdge   = (e: Edge): e is NetworkEdge   => e.category === "network";
export const isExecEdge      = (e: Edge): e is ExecEdge      => e.category === "exec";
export const isUnknownEdge   = (e: Edge): e is UnknownEdge   =>
  typeof e.category === "string" && e.category.startsWith("x-");

export const isLeafLiteral     = (l: Leaf): l is LeafLiteral     => l.flavor === "literal";
export const isLeafEnv         = (l: Leaf): l is LeafEnv         => l.flavor === "env";
export const isLeafConfigFile  = (l: Leaf): l is LeafConfigFile  => l.flavor === "config-file";
export const isLeafCliArg      = (l: Leaf): l is LeafCliArg      => l.flavor === "cli-arg";
export const isLeafHttpInput   = (l: Leaf): l is LeafHttpInput   => l.flavor === "http-input";
export const isLeafDbRead      = (l: Leaf): l is LeafDbRead      => l.flavor === "db-read";
export const isLeafExternalApi = (l: Leaf): l is LeafExternalApi => l.flavor === "external-api";
export const isLeafUnknown     = (l: Leaf): l is LeafUnknown     =>
  typeof l.flavor === "string" && l.flavor.startsWith("x-");

export const isSinkDbWrite = (s: Sink): s is SinkDbWrite => s.flavor === "db-write";
export const isSinkNetwork = (s: Sink): s is SinkNetwork => s.flavor === "network";
export const isSinkFs      = (s: Sink): s is SinkFs      => s.flavor === "fs";
export const isSinkExec    = (s: Sink): s is SinkExec    => s.flavor === "exec";
export const isSinkLog     = (s: Sink): s is SinkLog     => s.flavor === "log";
export const isSinkUnknown = (s: Sink): s is SinkUnknown =>
  typeof s.flavor === "string" && s.flavor.startsWith("x-");

/** True if the category is one of the v0.1 known set (i.e. not an `x-*` extension). */
export function isKnownEdgeCategory(c: EdgeCategory): c is Exclude<EdgeCategory, `x-${string}`> {
  return (
    c === "call" || c === "import" || c === "type-flow" ||
    c === "http-route" ||
    c === "db-read" || c === "db-write" ||
    c === "env-read" || c === "fs-read" || c === "fs-write" ||
    c === "network" || c === "exec"
  );
}

/** True if the tier is one of the v0.1 known set. */
export function isKnownTier(t: NodeTier): t is Exclude<NodeTier, `x-${string}`> {
  return t === "service" || t === "module" || t === "type" || t === "function" || t === "expression";
}

/** True if the leaf flavor is one of the v0.1 known set. */
export function isKnownLeafFlavor(f: LeafFlavor): f is Exclude<LeafFlavor, `x-${string}`> {
  return (
    f === "literal" || f === "env" || f === "config-file" ||
    f === "cli-arg" || f === "http-input" ||
    f === "db-read" || f === "external-api"
  );
}

/** True if the sink flavor is one of the v0.1 known set. */
export function isKnownSinkFlavor(f: SinkFlavor): f is Exclude<SinkFlavor, `x-${string}`> {
  return f === "db-write" || f === "network" || f === "fs" || f === "exec" || f === "log";
}

// =============================================================================
// Constants
// =============================================================================

export const SCHEMA_VERSION: SchemaVersion = "0.1.0";

/** Stable list of v0.1 edge categories. Useful for filter UIs. */
export const KNOWN_EDGE_CATEGORIES = [
  "call", "import", "type-flow",
  "http-route",
  "db-read", "db-write",
  "env-read", "fs-read", "fs-write",
  "network", "exec",
] as const satisfies ReadonlyArray<Exclude<EdgeCategory, `x-${string}`>>;

/** Stable list of v0.1 tiers, from outermost containment to innermost. */
export const KNOWN_TIERS = [
  "service", "module", "type", "function", "expression",
] as const satisfies ReadonlyArray<Exclude<NodeTier, `x-${string}`>>;

/** Stable list of v0.1 leaf flavors. */
export const KNOWN_LEAF_FLAVORS = [
  "literal", "env", "config-file", "cli-arg", "http-input", "db-read", "external-api",
] as const satisfies ReadonlyArray<Exclude<LeafFlavor, `x-${string}`>>;

/** Stable list of v0.1 sink flavors. */
export const KNOWN_SINK_FLAVORS = [
  "db-write", "network", "fs", "exec", "log",
] as const satisfies ReadonlyArray<Exclude<SinkFlavor, `x-${string}`>>;
