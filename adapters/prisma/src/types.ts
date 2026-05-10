/**
 * codegraph adapter: Prisma — internal IR shapes.
 *
 * The host's IR is open-ended: `NodeKind`/`EdgeKind` are strings and the `data`
 * payload is adapter-defined (see spec/adapter-interface.ts §2). The shapes
 * here pin down what *this* adapter writes into `data` so analyze/resolve can
 * agree on field names without round-tripping through `Record<string, unknown>`.
 *
 * Node kinds (all under the `prisma.` namespace):
 *   - prisma.datasource — one per `datasource` block in schema.prisma
 *   - prisma.model      — one per `model X { ... }` block
 *   - prisma.field      — one per scalar/relation field in a model
 *   - prisma.enum       — one per `enum X { ... }` block
 *   - prisma.query      — one per recognized `prisma.<model>.<op>(...)` or
 *                         `$queryRaw` / `$executeRaw` call site
 *
 * Edge kinds:
 *   - prisma.has-field  — model -> field (structural)
 *   - prisma.relation   — model -> model (FK / list relation)
 *   - prisma.field-type — field -> model | enum (when the field's type is one)
 *
 * Plus the cross-cutting db edges (host-defined categories) the resolve pass
 * lifts into the global IR so dead-code-impl can trace HTTP -> DB-write paths:
 *   - category "db-read"  — caller function symbol -> prisma.model
 *   - category "db-write" — caller function symbol -> prisma.model
 *                           (with `raw: true` data flag for $queryRaw etc.)
 */

import type {
  IrId,
  IrNode,
  IrEdge,
  Provenance,
  DeferredRef,
} from "@codegraph/adapter-sdk";

// ---------------------------------------------------------------------------
// Node kinds
// ---------------------------------------------------------------------------

export const PRISMA_NODE_KINDS = {
  datasource: "prisma.datasource",
  model: "prisma.model",
  field: "prisma.field",
  enum: "prisma.enum",
  query: "prisma.query",
} as const;

export const PRISMA_EDGE_KINDS = {
  hasField: "prisma.has-field",
  relation: "prisma.relation",
  fieldType: "prisma.field-type",
} as const;

/**
 * Host-namespaced edge categories the resolve phase emits. These are NOT
 * adapter-private — the IR builder ingests them as first-class typed edges
 * (see packages/core/src/ir/types.ts EdgeCategory).
 */
export const HOST_EDGE_CATEGORIES = {
  dbRead: "db-read",
  dbWrite: "db-write",
} as const;

// ---------------------------------------------------------------------------
// Datasource
// ---------------------------------------------------------------------------

/**
 * A `datasource` block. Most schemas have exactly one; multi-tenant projects
 * sometimes have several. The `provider` drives the `store` field of the
 * eventual db-read/db-write edge so downstream tools know whether they're
 * looking at postgres / mysql / sqlite / mongodb / etc.
 */
export interface PrismaDatasourceData extends Record<string, unknown> {
  /** The block's name (`datasource db { ... }` -> "db"). */
  name: string;
  /** "postgresql" | "mysql" | "sqlite" | "sqlserver" | "mongodb" | "cockroachdb" | unknown */
  provider: string;
  /**
   * The literal text of the `url` directive when statically derivable
   * (e.g. `env("DATABASE_URL")`). We do NOT resolve env vars — that's the
   * env-vars adapter's job.
   */
  urlExpr?: string;
}

// ---------------------------------------------------------------------------
// Model + Field
// ---------------------------------------------------------------------------

/**
 * Open enum mirroring Prisma's scalar types plus the "this is a relation"
 * sentinel and the "user-defined enum/model" sentinel. Kept as a string so
 * future Prisma scalar types (e.g. `Decimal`, `BigInt`) round-trip without a
 * schema change here.
 */
export type PrismaScalar =
  | "String"
  | "Boolean"
  | "Int"
  | "BigInt"
  | "Float"
  | "Decimal"
  | "DateTime"
  | "Json"
  | "Bytes"
  | "Unsupported"
  | string;

export interface PrismaModelData extends Record<string, unknown> {
  /** Model name as written in schema.prisma (`model User`). PascalCase by convention. */
  name: string;
  /** Datasource block name this model belongs to (multi-schema projects). */
  datasource?: string;
  /** Repo-relative path to the schema file that declares this model. */
  schemaFile: string;
  /**
   * Table/collection name. Defaults to the model name; overridden by
   * `@@map("...")`. We carry both so call-site resolution can still use the
   * model name (which is what `prisma.user.findMany()` keys on).
   */
  dbName: string;
  /** Field count, surfaced for the viewer's summary tooltip. */
  fieldCount: number;
  /** Raw `@@unique`/`@@index`/`@@id` block-level attributes, for completeness. */
  blockAttributes?: ReadonlyArray<{ name: string; argsText: string }>;
}

export interface PrismaFieldData extends Record<string, unknown> {
  /** Field name as written. */
  name: string;
  /** Containing model name (denormalized for cheap lookup). */
  modelName: string;
  /** The type's textual base name (`String`, `User`, `Json`, ...). */
  typeBase: PrismaScalar;
  /** True for `Field?`. */
  optional: boolean;
  /** True for `Field[]`. */
  list: boolean;
  /** True if the field's `typeBase` references a model declared in this schema. */
  isRelation: boolean;
  /** True if the field's `typeBase` references an enum declared in this schema. */
  isEnumRef: boolean;
  /** Raw text of `@id`, `@default(...)`, `@relation(...)`, etc. attributes. */
  attributes?: ReadonlyArray<{ name: string; argsText: string }>;
  /**
   * For relation fields: the relation name (from `@relation(name: "...")`)
   * if explicit, else undefined. Used by `parse-schema` to pair both sides
   * of a 1:N or M:N relation.
   */
  relationName?: string;
  /** For relation fields: the FK column names from `@relation(fields: [...])`. */
  relationFields?: ReadonlyArray<string>;
  /** For relation fields: the referenced columns from `@relation(references: [...])`. */
  relationReferences?: ReadonlyArray<string>;
}

export interface PrismaEnumData extends Record<string, unknown> {
  name: string;
  schemaFile: string;
  values: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Query (a single recognized prisma client call site)
// ---------------------------------------------------------------------------

/**
 * The semantic class of a prisma method. Drives both the host-edge category
 * (db-read vs db-write) and per-op surface metadata.
 *
 * Mapping (case-sensitive on method name):
 *   findFirst | findFirstOrThrow | findMany | findUnique | findUniqueOrThrow
 *     | count | aggregate | groupBy             -> "read"
 *   create | createMany | createManyAndReturn
 *     | update | updateMany | upsert
 *     | delete | deleteMany                     -> "write"
 *   $queryRaw | $queryRawUnsafe                 -> "read"  (raw=true)
 *   $executeRaw | $executeRawUnsafe             -> "write" (raw=true)
 *
 * `$transaction` is a wrapper — analyze.ts recurses into its array argument
 * rather than emitting a query node for the call itself.
 */
export type PrismaOpClass = "read" | "write" | "unknown";

export interface PrismaQueryData extends Record<string, unknown> {
  /** Lowercased model accessor as written: `prisma.user.findMany()` -> "user". */
  modelAccessor: string;
  /** Method name as written: "findMany", "create", "$queryRaw". */
  op: string;
  opClass: PrismaOpClass;
  /** True for `$queryRaw`/`$executeRaw`/`*Unsafe` variants. */
  raw: boolean;
  /**
   * The IR id of the enclosing function (caller). Set by analyze.ts via
   * `ctx.file.symbols`. Undefined when the call is at module top level —
   * resolve.ts then attaches the edge to the file/module node instead.
   */
  callerSymbolId?: IrId;
  /**
   * The literal `from`/`to` of the eventual db edge (file + range), copied
   * here so the viewer can render the call-site location without dereferencing
   * the edge's provenance.
   */
  callSiteFile: string;
}

// ---------------------------------------------------------------------------
// Edges (adapter-private)
// ---------------------------------------------------------------------------

export interface PrismaHasFieldEdgeData extends Record<string, unknown> {
  fieldName: string;
}

export interface PrismaRelationEdgeData extends Record<string, unknown> {
  /** Field name on the `from` side that declares the relation. */
  viaField: string;
  /** Cardinality the schema implies: 1-1, 1-n, n-m. */
  cardinality: "1-1" | "1-n" | "n-m" | "unknown";
  relationName?: string;
}

export interface PrismaFieldTypeEdgeData extends Record<string, unknown> {
  /** "model" | "enum" — what the target node represents. */
  refKind: "model" | "enum";
}

// ---------------------------------------------------------------------------
// Cross-adapter edge data (host categories)
// ---------------------------------------------------------------------------

/**
 * Payload attached to the cross-adapter db-read / db-write edges emitted in
 * resolve.ts. The host's edge schema (`packages/core/src/ir/types.ts`) reads
 * `store`, `entity`, `op`, and tolerates extra fields — we put the raw flag
 * under `tags` to keep the typed edge clean.
 */
export interface DbEdgeData extends Record<string, unknown> {
  store: string; // "postgresql" | "mysql" | ...
  entity: string; // model name
  op: string; // "findMany" | "create" | "$queryRaw" | ...
  raw?: boolean;
  /** The query node id this edge was lifted from (provenance). */
  queryNodeId?: IrId;
}

// ---------------------------------------------------------------------------
// Concrete IrNode / IrEdge type aliases
// ---------------------------------------------------------------------------

export type PrismaDatasourceNode = IrNode<PrismaDatasourceData>;
export type PrismaModelNode = IrNode<PrismaModelData>;
export type PrismaFieldNode = IrNode<PrismaFieldData>;
export type PrismaEnumNode = IrNode<PrismaEnumData>;
export type PrismaQueryNode = IrNode<PrismaQueryData>;

export type PrismaHasFieldEdge = IrEdge<PrismaHasFieldEdgeData>;
export type PrismaRelationEdge = IrEdge<PrismaRelationEdgeData>;
export type PrismaFieldTypeEdge = IrEdge<PrismaFieldTypeEdgeData>;

// ---------------------------------------------------------------------------
// Deferred-ref shapes (analyze -> resolve handoff)
// ---------------------------------------------------------------------------

/**
 * When analyze.ts sees `prisma.user.findMany()` it doesn't yet know whether
 * `user` resolves to a real model — schema parsing happens in a separate
 * file pass and may not have completed in this worker yet. It emits a
 * deferred ref of this kind; resolve.ts looks up the model node by name.
 */
export interface MatchModelRef extends DeferredRef {
  readonly kind: "prisma.match-model";
  readonly query: {
    readonly modelAccessor: string;
  };
}

/**
 * For `$queryRaw`/`$executeRaw`, analyze.ts captures the (raw) SQL string
 * if statically derivable. resolve.ts pulls table names out and tries to
 * match each to a model; misses become an unresolved-edge diagnostic.
 */
export interface MatchRawTablesRef extends DeferredRef {
  readonly kind: "prisma.match-raw-tables";
  readonly query: {
    readonly sqlText: string;
    readonly write: boolean;
  };
}

// ---------------------------------------------------------------------------
// Local-id helpers
// ---------------------------------------------------------------------------

/**
 * Stable local-id builders. The host minter prepends `cg:prisma@<version>:`,
 * so these only need to be unique within the adapter's namespace and stable
 * across runs. No counters, no timestamps, no iteration order.
 */
export const localId = {
  datasource: (name: string) => `datasource::${name}`,
  model: (name: string) => `model::${name}`,
  field: (model: string, field: string) => `model::${model}/field::${field}`,
  enum: (name: string) => `enum::${name}`,
  query: (file: string, startByte: number, op: string, accessor: string) =>
    `query::${file}@${startByte}::${accessor}.${op}`,
  hasFieldEdge: (model: string, field: string) =>
    `edge::has-field::${model}/${field}`,
  relationEdge: (fromModel: string, toModel: string, viaField: string) =>
    `edge::relation::${fromModel}->${toModel}::${viaField}`,
  fieldTypeEdge: (fromModel: string, field: string, target: string) =>
    `edge::field-type::${fromModel}/${field}->${target}`,
  dbEdge: (
    callerLocalId: string,
    model: string,
    op: string,
    callSiteByte: number,
  ) => `edge::db::${callerLocalId}->${model}::${op}@${callSiteByte}`,
} as const;

// Re-export Provenance so analyze/resolve don't need to import from the SDK
// directly for type annotations.
export type { Provenance };
