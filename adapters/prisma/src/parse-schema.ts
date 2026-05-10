/**
 * codegraph adapter: Prisma — schema.prisma -> IR.
 *
 * Prisma's schema is its own DSL, not TypeScript. We use `@mrleebo/prisma-ast`
 * (a pure-JS pegjs parser, deterministic, no native deps — see spec §6.4
 * "BYO parser") to produce a typed AST and then walk it to emit:
 *
 *   - prisma.datasource nodes (one per `datasource db { ... }`)
 *   - prisma.model nodes      (one per `model X { ... }`)
 *   - prisma.field nodes      (one per scalar/relation field)
 *   - prisma.enum nodes       (one per `enum X { ... }`)
 *   - prisma.has-field edges  (model -> field)
 *   - prisma.relation edges   (model -> model, with cardinality)
 *   - prisma.field-type edges (field -> model | enum)
 *
 * This file is called from analyze.ts when it sees a `*.prisma` file. The
 * `appliesTo` predicate in index.ts routes such files here even though they
 * have no host AST (`file.ast === null`).
 *
 * Parse failures are NOT fatal for the run: they emit an `error` diagnostic
 * and the schema is skipped. Other adapters keep working.
 */

import type {
  AnalyzeFileContext,
  IrId,
  IrNode,
  IrEdge,
  SourceRange,
} from "@codegraph/adapter-sdk";

import {
  PRISMA_NODE_KINDS,
  PRISMA_EDGE_KINDS,
  localId,
  type PrismaModelData,
  type PrismaFieldData,
  type PrismaDatasourceData,
  type PrismaEnumData,
  type PrismaHasFieldEdgeData,
  type PrismaRelationEdgeData,
  type PrismaFieldTypeEdgeData,
  type PrismaScalar,
} from "./types.js";

// ---------------------------------------------------------------------------
// prisma-ast typings (loose-typed — the package's own `.d.ts` is permissive)
// ---------------------------------------------------------------------------

/**
 * A subset of `@mrleebo/prisma-ast`'s exported types we actually consume.
 * Re-declaring locally rather than re-exporting from the package keeps the
 * adapter's public surface minimal and lets us narrow the types to the
 * fields we actually use.
 *
 * The package exports `getSchema(source: string): Schema` whose `Schema.list`
 * is a heterogeneous array of blocks discriminated by the `type` field.
 */
interface PrismaAstSchema {
  readonly type: "schema";
  readonly list: ReadonlyArray<PrismaAstBlock>;
}

type PrismaAstBlock =
  | PrismaAstModelBlock
  | PrismaAstEnumBlock
  | PrismaAstDatasourceBlock
  | PrismaAstGeneratorBlock
  | PrismaAstCommentBlock
  | PrismaAstUnknownBlock;

interface PrismaAstModelBlock {
  readonly type: "model" | "view";
  readonly name: string;
  readonly properties: ReadonlyArray<PrismaAstModelProperty>;
}

type PrismaAstModelProperty =
  | PrismaAstField
  | PrismaAstBlockAttribute
  | PrismaAstComment;

interface PrismaAstField {
  readonly type: "field";
  readonly name: string;
  /** Field type as written, minus list/optional decorations. */
  readonly fieldType: string;
  /** True for `Field?`. */
  readonly optional?: boolean;
  /** True for `Field[]`. */
  readonly array?: boolean;
  readonly attributes?: ReadonlyArray<PrismaAstAttribute>;
}

interface PrismaAstAttribute {
  readonly type: "attribute";
  /** Attribute name without the leading `@` (e.g. "id", "default", "relation"). */
  readonly name: string;
  /** Argument list as raw AST entries; we serialize them back to text below. */
  readonly args?: ReadonlyArray<{ readonly value: unknown }>;
}

interface PrismaAstBlockAttribute {
  readonly type: "attribute";
  readonly name: string;
  readonly args?: ReadonlyArray<{ readonly value: unknown }>;
  /** Block-level (`@@` prefix) vs field-level (`@`). prisma-ast distinguishes via `kind`. */
  readonly kind?: "object" | "field";
  readonly group?: string;
}

interface PrismaAstEnumBlock {
  readonly type: "enum";
  readonly name: string;
  readonly enumerators: ReadonlyArray<{ readonly type: "enumerator"; readonly name: string }>;
}

interface PrismaAstDatasourceBlock {
  readonly type: "datasource";
  readonly name: string;
  readonly assignments: ReadonlyArray<{
    readonly type: "assignment";
    readonly key: string;
    readonly value: string | { readonly name: string; readonly args?: unknown[] };
  }>;
}

interface PrismaAstGeneratorBlock {
  readonly type: "generator";
  readonly name: string;
  readonly assignments: ReadonlyArray<unknown>;
}

interface PrismaAstCommentBlock {
  readonly type: "comment";
  readonly text: string;
}

interface PrismaAstUnknownBlock {
  readonly type: string;
}

interface PrismaAstComment {
  readonly type: "comment";
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a single `schema.prisma` file and emit IR via `ctx.emit`.
 *
 * Phase semantics: this is invoked from `analyzeFile`. Per spec §3.3 it must
 * be local — it must not consult other files. Cross-schema relations
 * (uncommon but legal under `previewFeatures = ["multiSchema"]`) are joined
 * in resolve.ts where the merged IR is available.
 */
export async function parseSchema(ctx: AnalyzeFileContext): Promise<void> {
  const file = ctx.file;
  if (!file.path.endsWith(".prisma")) return; // defensive — appliesTo gates this

  // Lazy-load the parser. Top-level imports would force every adapter worker
  // to load prisma-ast even when no schema is in scope.
  let getSchema: (src: string) => PrismaAstSchema;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = await import("@mrleebo/prisma-ast");
    getSchema = (mod as unknown as { getSchema: typeof getSchema }).getSchema;
  } catch (err) {
    ctx.diagnostic({
      severity: "error",
      code: "prisma/parser-load-failed",
      message:
        "Could not load @mrleebo/prisma-ast. Install it as a dependency of @codegraph/adapter-prisma.",
      file: file.path,
      data: { error: String(err) },
    });
    return;
  }

  let schema: PrismaAstSchema;
  try {
    schema = getSchema(file.content);
  } catch (err) {
    ctx.diagnostic({
      severity: "error",
      code: "prisma/schema-parse-failed",
      message: `Failed to parse ${file.path}: ${(err as Error).message}`,
      file: file.path,
    });
    return;
  }

  // First pass: collect declared model and enum names so field-type edges
  // can be emitted correctly even when a field references a model defined
  // later in the file. Two-pass keeps the walker order-independent.
  const modelNames = new Set<string>();
  const enumNames = new Set<string>();
  for (const block of schema.list) {
    if (block.type === "model" || block.type === "view") {
      modelNames.add((block as PrismaAstModelBlock).name);
    } else if (block.type === "enum") {
      enumNames.add((block as PrismaAstEnumBlock).name);
    }
  }

  // Default datasource name — Prisma allows omitting one entirely (rare).
  // Models with no explicit `@@schema(...)` belong to the first datasource.
  let defaultDatasource: string | undefined;

  for (const block of schema.list) {
    switch (block.type) {
      case "datasource": {
        const ds = block as PrismaAstDatasourceBlock;
        emitDatasource(ctx, ds, file.path);
        if (!defaultDatasource) defaultDatasource = ds.name;
        break;
      }
      case "enum": {
        emitEnum(ctx, block as PrismaAstEnumBlock, file.path);
        break;
      }
      case "model":
      case "view": {
        emitModel(
          ctx,
          block as PrismaAstModelBlock,
          file.path,
          defaultDatasource,
          modelNames,
          enumNames,
        );
        break;
      }
      // generator / comment / unknown: ignored — no IR contribution.
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Datasource
// ---------------------------------------------------------------------------

function emitDatasource(
  ctx: AnalyzeFileContext,
  block: PrismaAstDatasourceBlock,
  filePath: string,
): void {
  const provider = readAssignmentString(block.assignments, "provider") ?? "unknown";
  const urlExpr = readAssignmentRaw(block.assignments, "url");

  const id = ctx.id.mint({
    path: filePath,
    localId: localId.datasource(block.name),
  });
  const data: PrismaDatasourceData = {
    name: block.name,
    provider,
    ...(urlExpr !== undefined ? { urlExpr } : {}),
  };
  const node: IrNode<PrismaDatasourceData> = {
    id,
    kind: PRISMA_NODE_KINDS.datasource,
    label: `datasource ${block.name} (${provider})`,
    data,
    provenance: {
      file: filePath,
      range: WHOLE_FILE_RANGE,
      // Host overwrites adapter + version; placeholder values here are fine.
      adapter: "prisma",
      version: "0.0.0",
    },
  };
  ctx.emit(node);
}

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

function emitEnum(
  ctx: AnalyzeFileContext,
  block: PrismaAstEnumBlock,
  filePath: string,
): void {
  const id = ctx.id.mint({
    path: filePath,
    localId: localId.enum(block.name),
  });
  const data: PrismaEnumData = {
    name: block.name,
    schemaFile: filePath,
    values: block.enumerators
      .filter((e) => e.type === "enumerator")
      .map((e) => e.name),
  };
  const node: IrNode<PrismaEnumData> = {
    id,
    kind: PRISMA_NODE_KINDS.enum,
    label: `enum ${block.name}`,
    data,
    provenance: {
      file: filePath,
      range: WHOLE_FILE_RANGE,
      adapter: "prisma",
      version: "0.0.0",
    },
  };
  ctx.emit(node);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

function emitModel(
  ctx: AnalyzeFileContext,
  block: PrismaAstModelBlock,
  filePath: string,
  defaultDatasource: string | undefined,
  modelNames: ReadonlySet<string>,
  enumNames: ReadonlySet<string>,
): void {
  const fields = block.properties.filter(isField);
  const blockAttrs = block.properties.filter(isBlockAttribute);

  // `@@map("table_name")` overrides the SQL table name; default = model name.
  const dbName = readBlockAttributeFirstStringArg(blockAttrs, "map") ?? block.name;

  const modelData: PrismaModelData = {
    name: block.name,
    ...(defaultDatasource !== undefined ? { datasource: defaultDatasource } : {}),
    schemaFile: filePath,
    dbName,
    fieldCount: fields.length,
    blockAttributes: blockAttrs.map((a) => ({
      name: a.name,
      argsText: serializeArgs(a.args),
    })),
  };

  const modelId = ctx.id.mint({
    path: filePath,
    localId: localId.model(block.name),
  });
  const modelNode: IrNode<PrismaModelData> = {
    id: modelId,
    kind: PRISMA_NODE_KINDS.model,
    label: `model ${block.name}`,
    data: modelData,
    provenance: {
      file: filePath,
      range: WHOLE_FILE_RANGE,
      adapter: "prisma",
      version: "0.0.0",
    },
  };
  ctx.emit(modelNode);

  // Fields + structural edges + relation/field-type edges.
  for (const f of fields) {
    emitField(ctx, f, block.name, modelId, filePath, modelNames, enumNames);
  }
}

function emitField(
  ctx: AnalyzeFileContext,
  field: PrismaAstField,
  modelName: string,
  modelId: IrId,
  filePath: string,
  modelNames: ReadonlySet<string>,
  enumNames: ReadonlySet<string>,
): void {
  const isRelation = modelNames.has(field.fieldType);
  const isEnumRef = enumNames.has(field.fieldType);
  const attributes = (field.attributes ?? []).map((a) => ({
    name: a.name,
    argsText: serializeArgs(a.args),
  }));

  const relationAttr = (field.attributes ?? []).find((a) => a.name === "relation");
  const relationParsed = relationAttr ? parseRelationAttr(relationAttr) : undefined;

  const fieldData: PrismaFieldData = {
    name: field.name,
    modelName,
    typeBase: field.fieldType as PrismaScalar,
    optional: field.optional === true,
    list: field.array === true,
    isRelation,
    isEnumRef,
    attributes,
    ...(relationParsed?.name !== undefined ? { relationName: relationParsed.name } : {}),
    ...(relationParsed?.fields !== undefined
      ? { relationFields: relationParsed.fields }
      : {}),
    ...(relationParsed?.references !== undefined
      ? { relationReferences: relationParsed.references }
      : {}),
  };

  const fieldId = ctx.id.mint({
    path: filePath,
    localId: localId.field(modelName, field.name),
  });
  const fieldNode: IrNode<PrismaFieldData> = {
    id: fieldId,
    kind: PRISMA_NODE_KINDS.field,
    label: renderFieldLabel(field),
    data: fieldData,
    group: modelId,
    provenance: {
      file: filePath,
      range: WHOLE_FILE_RANGE,
      adapter: "prisma",
      version: "0.0.0",
    },
  };
  ctx.emit(fieldNode);

  // model -> field structural edge.
  const hasFieldEdge: IrEdge<PrismaHasFieldEdgeData> = {
    id: ctx.id.mint({
      path: filePath,
      localId: localId.hasFieldEdge(modelName, field.name),
    }),
    kind: PRISMA_EDGE_KINDS.hasField,
    from: modelId,
    to: fieldId,
    data: { fieldName: field.name },
    provenance: {
      file: filePath,
      range: WHOLE_FILE_RANGE,
      adapter: "prisma",
      version: "0.0.0",
    },
  };
  ctx.emit(hasFieldEdge);

  // field -> (model | enum) typed edge, when the type is a declared name.
  if (isRelation || isEnumRef) {
    const targetLocalId = isRelation
      ? localId.model(field.fieldType)
      : localId.enum(field.fieldType);
    const targetId = ctx.id.mint({ path: filePath, localId: targetLocalId });
    const fieldTypeEdge: IrEdge<PrismaFieldTypeEdgeData> = {
      id: ctx.id.mint({
        path: filePath,
        localId: localId.fieldTypeEdge(modelName, field.name, field.fieldType),
      }),
      kind: PRISMA_EDGE_KINDS.fieldType,
      from: fieldId,
      to: targetId,
      data: { refKind: isRelation ? "model" : "enum" },
      provenance: {
        file: filePath,
        range: WHOLE_FILE_RANGE,
        adapter: "prisma",
        version: "0.0.0",
      },
    };
    ctx.emit(fieldTypeEdge);
  }

  // Relation edges (model -> model). Only emit from the side of the relation
  // that owns the foreign key — i.e. the side whose `@relation(fields: [...])`
  // is non-empty. The "list side" (`posts Post[]`) is the inverse and would
  // create a duplicate edge if we emitted from both sides.
  if (
    isRelation &&
    relationParsed &&
    relationParsed.fields &&
    relationParsed.fields.length > 0
  ) {
    const targetModelId = ctx.id.mint({
      path: filePath,
      localId: localId.model(field.fieldType),
    });
    const card: PrismaRelationEdgeData["cardinality"] = field.array
      ? "n-m"
      : field.optional
        ? "1-1"
        : "1-n";
    const relEdge: IrEdge<PrismaRelationEdgeData> = {
      id: ctx.id.mint({
        path: filePath,
        localId: localId.relationEdge(modelName, field.fieldType, field.name),
      }),
      kind: PRISMA_EDGE_KINDS.relation,
      from: modelId,
      to: targetModelId,
      label:
        relationParsed.name !== undefined
          ? `relation ${relationParsed.name}`
          : `relation via ${field.name}`,
      data: {
        viaField: field.name,
        cardinality: card,
        ...(relationParsed.name !== undefined ? { relationName: relationParsed.name } : {}),
      },
      provenance: {
        file: filePath,
        range: WHOLE_FILE_RANGE,
        adapter: "prisma",
        version: "0.0.0",
      },
    };
    ctx.emit(relEdge);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isField(p: PrismaAstModelProperty): p is PrismaAstField {
  return (p as { type?: string }).type === "field";
}

function isBlockAttribute(p: PrismaAstModelProperty): p is PrismaAstBlockAttribute {
  // prisma-ast tags both field and block attributes with `type: "attribute"`;
  // block-level ones additionally have `group` populated and no `args` for
  // simple ones. The simplest reliable discriminator is "is not a field".
  return !isField(p) && (p as { type?: string }).type === "attribute";
}

function readAssignmentString(
  assignments: PrismaAstDatasourceBlock["assignments"],
  key: string,
): string | undefined {
  for (const a of assignments) {
    if (a.key !== key) continue;
    if (typeof a.value === "string") {
      // prisma-ast wraps quoted strings with the surrounding quotes.
      return a.value.replace(/^['"]|['"]$/g, "");
    }
  }
  return undefined;
}

function readAssignmentRaw(
  assignments: PrismaAstDatasourceBlock["assignments"],
  key: string,
): string | undefined {
  for (const a of assignments) {
    if (a.key !== key) continue;
    if (typeof a.value === "string") return a.value;
    if (a.value && typeof a.value === "object" && "name" in a.value) {
      const args = serializeArgs(
        (a.value.args ?? []).map((v) => ({ value: v as unknown })),
      );
      return `${(a.value as { name: string }).name}(${args})`;
    }
  }
  return undefined;
}

function readBlockAttributeFirstStringArg(
  attrs: ReadonlyArray<PrismaAstBlockAttribute>,
  name: string,
): string | undefined {
  const a = attrs.find((x) => x.name === name);
  if (!a || !a.args || a.args.length === 0) return undefined;
  const v = a.args[0]?.value;
  if (typeof v === "string") return v.replace(/^['"]|['"]$/g, "");
  return undefined;
}

interface RelationParsed {
  name?: string;
  fields?: ReadonlyArray<string>;
  references?: ReadonlyArray<string>;
}

function parseRelationAttr(attr: PrismaAstAttribute): RelationParsed {
  // `@relation(name: "X", fields: [a, b], references: [id, sub])` — prisma-ast
  // surfaces these as positional + kwargs; we serialize-then-pattern-match so
  // we don't need to hand-roll a full arg-shape decoder.
  const text = serializeArgs(attr.args);
  const out: RelationParsed = {};
  const nameMatch = /(?:name\s*:\s*|^)["']([^"']+)["']/.exec(text);
  if (nameMatch) out.name = nameMatch[1];
  const fieldsMatch = /fields\s*:\s*\[([^\]]*)\]/.exec(text);
  if (fieldsMatch) out.fields = splitIdentList(fieldsMatch[1] ?? "");
  const refsMatch = /references\s*:\s*\[([^\]]*)\]/.exec(text);
  if (refsMatch) out.references = splitIdentList(refsMatch[1] ?? "");
  return out;
}

function splitIdentList(s: string): ReadonlyArray<string> {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function serializeArgs(args: PrismaAstAttribute["args"]): string {
  if (!args || args.length === 0) return "";
  return args
    .map((a) => {
      const v = a.value;
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      if (v === null || v === undefined) return "";
      if (Array.isArray(v)) return `[${v.map(stringifyAny).join(", ")}]`;
      if (typeof v === "object") {
        const obj = v as { name?: string; args?: unknown[]; key?: string; value?: unknown };
        if (obj.name && Array.isArray(obj.args)) {
          return `${obj.name}(${obj.args.map(stringifyAny).join(", ")})`;
        }
        if (obj.key && obj.value !== undefined) {
          return `${obj.key}: ${stringifyAny(obj.value)}`;
        }
      }
      return stringifyAny(v);
    })
    .join(", ");
}

function stringifyAny(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(stringifyAny).join(", ")}]`;
  if (typeof v === "object") {
    const obj = v as { value?: unknown; name?: string; args?: unknown[]; key?: string };
    if ("value" in obj) return stringifyAny(obj.value);
    if (obj.name) {
      const inner = Array.isArray(obj.args) ? obj.args.map(stringifyAny).join(", ") : "";
      return `${obj.name}(${inner})`;
    }
    if (obj.key && obj.value !== undefined) {
      return `${obj.key}: ${stringifyAny(obj.value)}`;
    }
  }
  return "";
}

function renderFieldLabel(f: PrismaAstField): string {
  const optMark = f.optional ? "?" : "";
  const listMark = f.array ? "[]" : "";
  return `${f.name}: ${f.fieldType}${listMark}${optMark}`;
}

/**
 * prisma-ast does not surface byte/line positions today, so every block-level
 * range collapses to "the whole file". This is the agreed escape hatch from
 * spec §6.4 ("BYO parser ... the host accepts whole-file ranges from
 * non-host-language adapters"). When prisma-ast eventually emits positions,
 * swap this for the real range without changing the IR shape.
 */
const WHOLE_FILE_RANGE: SourceRange = {
  startByte: 0,
  endByte: 0,
  startLine: 1,
  startCol: 1,
  endLine: 1,
  endCol: 1,
};
