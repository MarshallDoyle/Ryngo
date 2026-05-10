/**
 * Runtime validator for codegraph IR JSON documents.
 *
 * Validates an unknown input against the canonical IR shape (see spec/ir.types.ts
 * and spec/ir.schema.json). On success returns the input typed as IRDocument.
 * On failure returns a list of {path, message} errors with JSON-pointer paths.
 *
 * Schema version policy:
 *   - schemaVersion must equal SCHEMA_VERSION exactly. Migrations live in
 *     packages/core/src/ir/migrations.ts (ir-loader's territory) — by the
 *     time validateIR runs, the document is expected to be at the current
 *     schemaVersion.
 *
 * Cross-cutting (post-schema) checks performed here:
 *   - All edge endpoints (sourceId, targetId) reference an existing node id.
 *   - All node parentIds (when present) reference an existing node id.
 *   - Node ids are unique.
 *   - Diagnostic.nodeId (when present) references an existing node id.
 */

import { z } from "zod";

import type {
  IRDocument,
  Edge,
  Leaf,
  Node,
  NodeId,
  Sink,
  StructuralType,
  TypeRef,
} from "./types";
import {
  KNOWN_EDGE_CATEGORIES,
  KNOWN_TIERS,
  SCHEMA_VERSION,
} from "./types";

// =============================================================================
// Public API
// =============================================================================

/** A single validation failure with a JSON-pointer path and a human message. */
export interface ValidationError {
  /** RFC 6901 JSON pointer, e.g. "/ir/nodes/3/tier". Empty string == root. */
  path: string;
  /** Human-readable explanation. Safe to surface to end users. */
  message: string;
}

export type ValidationResult =
  | { ok: true; ir: IRDocument }
  | { ok: false; errors: ValidationError[] };

/**
 * Validate an unknown value as a codegraph IR document.
 *
 * Re-exported from @codegraph/core. The "IR" name in the return type matches
 * the public API the task spec asked for; structurally it is the IRDocument
 * (root with schemaVersion + ir).
 */
export function validateIR(input: unknown): ValidationResult {
  const parsed = IRDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToErrors(parsed.error.issues) };
  }

  const doc = parsed.data;

  // Schema-shape passed; now run cross-cutting checks the schema can't express.
  const xerrors = checkCrossCutting(doc);
  if (xerrors.length > 0) return { ok: false, errors: xerrors };

  // The Zod schema produces a structurally-correct IRDocument, but the literal
  // types (e.g. `tier: "service"`) are inferred as strings here. The runtime
  // shape matches the public TS types exactly, so the cast is safe.
  return { ok: true, ir: doc as unknown as IRDocument };
}

// =============================================================================
// Open-enum helper
//
// EdgeCategory / Tier / LeafFlavor / SinkFlavor are "open" — known values plus
// any `x-${string}`. Anything else is rejected.
// =============================================================================

function openEnum<T extends string>(known: readonly T[], label: string) {
  const set = new Set<string>(known);
  return z.string().refine(
    (v) => set.has(v) || v.startsWith("x-"),
    (v) => ({ message: `unknown ${label} "${v}"; expected one of [${known.join(", ")}] or an "x-*" extension` }),
  );
}

const TierSchema = openEnum(KNOWN_TIERS, "tier");
const EdgeCategorySchema = openEnum(KNOWN_EDGE_CATEGORIES, "edge category");
// Leaf/sink flavors are matched per-variant via z.literal in the union schemas
// below, with `x-*` accepted via the LeafUnknown/SinkUnknown variants.

const NodeIdSchema = z.string().min(1);

// =============================================================================
// Shared primitives
// =============================================================================

const LangSchema = z.string().min(1);

const StructuralTypeSchema: z.ZodType<StructuralType> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("primitive"), name: z.string() }),
    z.object({ kind: z.literal("ref"), name: z.string() }),
    z.object({ kind: z.literal("generic"), name: z.string(), args: z.array(StructuralTypeSchema) }),
    z.object({ kind: z.literal("union"), args: z.array(StructuralTypeSchema) }),
    z.object({ kind: z.literal("intersection"), args: z.array(StructuralTypeSchema) }),
    z.object({ kind: z.literal("tuple"), args: z.array(StructuralTypeSchema) }),
    z.object({
      kind: z.literal("record"),
      fields: z.array(
        z.object({ name: z.string(), type: StructuralTypeSchema, optional: z.boolean().optional() }),
      ),
    }),
    z.object({
      kind: z.literal("function"),
      args: z.array(StructuralTypeSchema),
      ret: StructuralTypeSchema.optional(),
    }),
    z.object({ kind: z.literal("literal"), value: z.unknown() }),
    z.object({ kind: z.literal("any") }),
    z.object({ kind: z.literal("unknown") }),
  ]),
);

const TypeRefSchema: z.ZodType<TypeRef> = z.object({
  lang: LangSchema,
  display: z.string(),
  structural: StructuralTypeSchema.optional(),
  nullable: z.boolean().optional(),
  source: z.enum(["annotated", "inferred", "unknown"]).optional(),
});

const SourceLocSchema = z.object({
  path: z.string(),
  startLine: z.number().int().nonnegative().optional(),
  startCol: z.number().int().nonnegative().optional(),
  endLine: z.number().int().nonnegative().optional(),
  endCol: z.number().int().nonnegative().optional(),
});

// =============================================================================
// Nodes
// =============================================================================

const NodeBaseFields = {
  id: NodeIdSchema,
  signature: z.string(),
  parentId: NodeIdSchema.optional(),
  name: z.string().optional(),
  lang: LangSchema.optional(),
  doc: z.string().optional(),
  loc: SourceLocSchema.optional(),
  tags: z.array(z.string()).optional(),
};

const ServiceNodeSchema = z
  .object({
    ...NodeBaseFields,
    tier: z.literal("service"),
    name: z.string(),
    path: z.string(),
    manifest: z.string().optional(),
  })
  .passthrough();

const ModuleNodeSchema = z
  .object({
    ...NodeBaseFields,
    tier: z.literal("module"),
    parentId: NodeIdSchema,
    name: z.string(),
    path: z.string(),
  })
  .passthrough();

const TypeNodeSchema = z
  .object({
    ...NodeBaseFields,
    tier: z.literal("type"),
    parentId: NodeIdSchema,
    name: z.string(),
    kind: z.string(),
    exported: z.boolean().optional(),
    fields: z
      .array(
        z.object({
          name: z.string(),
          type: TypeRefSchema,
          optional: z.boolean().optional(),
          readonly: z.boolean().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

const FunctionNodeSchema = z
  .object({
    ...NodeBaseFields,
    tier: z.literal("function"),
    parentId: NodeIdSchema,
    name: z.string(),
    kind: z.string(),
    exported: z.boolean().optional(),
    pure: z.boolean(),
    params: z.array(
      z.object({
        name: z.string(),
        type: TypeRefSchema.optional(),
        optional: z.boolean().optional(),
        rest: z.boolean().optional(),
      }),
    ),
    returnType: TypeRefSchema.optional(),
    receiverType: TypeRefSchema.optional(),
    asyncness: z.enum(["sync", "async", "generator", "async-generator"]).optional(),
  })
  .passthrough();

// ---- Leaves ----------------------------------------------------------------

const LeafLiteralSchema = z.object({
  flavor: z.literal("literal"),
  value: z.unknown(),
  valueLang: LangSchema.optional(),
});
const LeafEnvSchema = z.object({
  flavor: z.literal("env"),
  name: z.string(),
  defaultValue: z.unknown().optional(),
});
const LeafConfigFileSchema = z.object({
  flavor: z.literal("config-file"),
  path: z.string(),
  format: z.enum(["json", "yaml", "toml", "env", "ini", "xml", "other"]).optional(),
  key: z.string().optional(),
});
const LeafCliArgSchema = z.object({
  flavor: z.literal("cli-arg"),
  name: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
});
const LeafHttpInputSchema = z.object({
  flavor: z.literal("http-input"),
  from: z.enum(["body", "query", "path", "header", "cookie", "form", "multipart"]),
  field: z.string().optional(),
});
const LeafDbReadSchema = z.object({
  flavor: z.literal("db-read"),
  store: z.string(),
  entity: z.string().optional(),
  op: z.string().optional(),
  fields: z.array(z.string()).optional(),
});
const LeafExternalApiSchema = z.object({
  flavor: z.literal("external-api"),
  url: z.string().optional(),
  service: z.string().optional(),
  kind: z.enum(["http", "grpc", "graphql", "websocket", "other"]).optional(),
});
const LeafUnknownSchema = z
  .object({ flavor: z.string().startsWith("x-") })
  .passthrough();

const LeafSchema: z.ZodType<Leaf> = z.union([
  LeafLiteralSchema,
  LeafEnvSchema,
  LeafConfigFileSchema,
  LeafCliArgSchema,
  LeafHttpInputSchema,
  LeafDbReadSchema,
  LeafExternalApiSchema,
  LeafUnknownSchema,
]) as z.ZodType<Leaf>;

// ---- Sinks -----------------------------------------------------------------

const SinkDbWriteSchema = z.object({
  flavor: z.literal("db-write"),
  store: z.string(),
  entity: z.string().optional(),
  op: z.string().optional(),
  fields: z.array(z.string()).optional(),
});
const SinkNetworkSchema = z.object({
  flavor: z.literal("network"),
  method: z.string().optional(),
  url: z.string().optional(),
  kind: z.enum(["http", "grpc", "graphql", "websocket", "tcp", "udp", "other"]).optional(),
});
const SinkFsSchema = z.object({
  flavor: z.literal("fs"),
  op: z.enum(["write", "read", "append", "delete", "rename", "chmod", "mkdir", "stat", "other"]),
  path: z.string().optional(),
});
const SinkExecSchema = z.object({
  flavor: z.literal("exec"),
  command: z.string().optional(),
  shell: z.boolean().optional(),
});
const SinkLogSchema = z.object({
  flavor: z.literal("log"),
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "other"]).optional(),
  logger: z.string().optional(),
});
const SinkUnknownSchema = z
  .object({ flavor: z.string().startsWith("x-") })
  .passthrough();

const SinkSchema: z.ZodType<Sink> = z.union([
  SinkDbWriteSchema,
  SinkNetworkSchema,
  SinkFsSchema,
  SinkExecSchema,
  SinkLogSchema,
  SinkUnknownSchema,
]) as z.ZodType<Sink>;

const ExpressionNodeSchema = z
  .object({
    ...NodeBaseFields,
    tier: z.literal("expression"),
    parentId: NodeIdSchema,
    role: z.string().optional(),
    pure: z.boolean(),
    leaf: LeafSchema.optional(),
    sink: SinkSchema.optional(),
    valueType: TypeRefSchema.optional(),
  })
  .passthrough();

const UnknownTierNodeSchema = z
  .object({
    id: NodeIdSchema,
    signature: z.string(),
    parentId: NodeIdSchema.optional(),
    name: z.string().optional(),
    tier: z.string().startsWith("x-"),
  })
  .passthrough();

/**
 * Tier-dispatched node validator. A bare z.union would produce a single
 * "Invalid input" issue at the array index when the discriminator is wrong;
 * dispatching first lets us surface a precise "/nodes/N/tier" message and
 * keeps per-tier errors readable.
 */
const NodeSchema = z.unknown().superRefine((val, ctx) => {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "node must be an object" });
    return;
  }
  const obj = val as Record<string, unknown>;
  const tier = obj["tier"];
  if (typeof tier !== "string") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tier"],
      message: 'node missing required string field "tier"',
    });
    return;
  }
  const tierCheck = TierSchema.safeParse(tier);
  if (!tierCheck.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tier"],
      message: tierCheck.error.issues[0]?.message ?? `unknown tier "${tier}"`,
    });
    return;
  }
  const schema = pickNodeSchema(tier);
  const r = schema.safeParse(val);
  if (!r.success) {
    for (const issue of r.error.issues) {
      ctx.addIssue({ ...issue, path: issue.path });
    }
  }
}) as z.ZodType<Node>;

function pickNodeSchema(tier: string): z.ZodTypeAny {
  switch (tier) {
    case "service":    return ServiceNodeSchema;
    case "module":     return ModuleNodeSchema;
    case "type":       return TypeNodeSchema;
    case "function":   return FunctionNodeSchema;
    case "expression": return ExpressionNodeSchema;
    default:           return UnknownTierNodeSchema; // x-*
  }
}

// =============================================================================
// Edges
// =============================================================================

const EdgeBaseFields = {
  sourceId: NodeIdSchema,
  targetId: NodeIdSchema,
  valueType: TypeRefSchema.optional(),
  conditional: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
};

const CallEdgeSchema = z
  .object({
    ...EdgeBaseFields,
    category: z.literal("call"),
    callKind: z.enum(["direct", "virtual", "dynamic", "constructor", "super", "tail"]).optional(),
    awaited: z.boolean().optional(),
  })
  .passthrough();

const ImportEdgeSchema = z
  .object({
    ...EdgeBaseFields,
    category: z.literal("import"),
    specifier: z.string().optional(),
    symbols: z.array(z.string()).optional(),
    kind: z.enum(["static", "dynamic", "type-only", "side-effect"]).optional(),
  })
  .passthrough();

const TypeFlowEdgeSchema = z
  .object({
    ...EdgeBaseFields,
    category: z.literal("type-flow"),
    role: z
      .enum(["argument", "return", "assign", "field-read", "field-write", "yield", "throw", "read"])
      .optional(),
    argIndex: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const HttpRouteEdgeSchema = z
  .object({
    ...EdgeBaseFields,
    category: z.literal("http-route"),
    method: z.string().optional(),
    framework: z.string().optional(),
  })
  .passthrough();

const DbReadEdgeSchema = z
  .object({
    ...EdgeBaseFields,
    category: z.literal("db-read"),
    store: z.string().optional(),
    entity: z.string().optional(),
  })
  .passthrough();

const DbWriteEdgeSchema = z
  .object({
    ...EdgeBaseFields,
    category: z.literal("db-write"),
    store: z.string().optional(),
    entity: z.string().optional(),
    op: z.string().optional(),
  })
  .passthrough();

const EnvReadEdgeSchema = z
  .object({ ...EdgeBaseFields, category: z.literal("env-read"), name: z.string().optional() })
  .passthrough();

const FsReadEdgeSchema = z
  .object({ ...EdgeBaseFields, category: z.literal("fs-read"), path: z.string().optional() })
  .passthrough();

const FsWriteEdgeSchema = z
  .object({
    ...EdgeBaseFields,
    category: z.literal("fs-write"),
    path: z.string().optional(),
    op: z
      .enum(["write", "append", "delete", "rename", "chmod", "mkdir", "other"])
      .optional(),
  })
  .passthrough();

const NetworkEdgeSchema = z
  .object({
    ...EdgeBaseFields,
    category: z.literal("network"),
    method: z.string().optional(),
    url: z.string().optional(),
    kind: z.enum(["http", "grpc", "graphql", "websocket", "tcp", "udp", "other"]).optional(),
  })
  .passthrough();

const ExecEdgeSchema = z
  .object({
    ...EdgeBaseFields,
    category: z.literal("exec"),
    command: z.string().optional(),
    shell: z.boolean().optional(),
  })
  .passthrough();

const UnknownEdgeSchema = z
  .object({
    sourceId: NodeIdSchema,
    targetId: NodeIdSchema,
    category: z.string().startsWith("x-"),
  })
  .passthrough();

/**
 * We pre-screen by `category` and dispatch to one schema. A bare z.union over
 * all variants would produce noisy errors (every variant complains). The
 * dispatcher gives us tier-targeted error messages and supports unknown
 * `x-*` categories without blowing up validation.
 */
const EdgeSchema = z.unknown().superRefine((val, ctx) => {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "edge must be an object" });
    return;
  }
  const obj = val as Record<string, unknown>;
  const cat = obj["category"];
  if (typeof cat !== "string") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["category"],
      message: 'edge missing required string field "category"',
    });
    return;
  }

  const catCheck = EdgeCategorySchema.safeParse(cat);
  if (!catCheck.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["category"],
      message: catCheck.error.issues[0]?.message ?? `unknown edge category "${cat}"`,
    });
    return;
  }

  const schema = pickEdgeSchema(cat);
  const r = schema.safeParse(val);
  if (!r.success) {
    for (const issue of r.error.issues) {
      ctx.addIssue({ ...issue, path: issue.path });
    }
  }
}) as z.ZodType<Edge>;

function pickEdgeSchema(category: string): z.ZodTypeAny {
  switch (category) {
    case "call":       return CallEdgeSchema;
    case "import":     return ImportEdgeSchema;
    case "type-flow":  return TypeFlowEdgeSchema;
    case "http-route": return HttpRouteEdgeSchema;
    case "db-read":    return DbReadEdgeSchema;
    case "db-write":   return DbWriteEdgeSchema;
    case "env-read":   return EnvReadEdgeSchema;
    case "fs-read":    return FsReadEdgeSchema;
    case "fs-write":   return FsWriteEdgeSchema;
    case "network":    return NetworkEdgeSchema;
    case "exec":       return ExecEdgeSchema;
    default:           return UnknownEdgeSchema; // x-*
  }
}

// =============================================================================
// Top-level
// =============================================================================

const GeneratorInfoSchema = z
  .object({
    name: z.string(),
    version: z.string(),
  })
  .passthrough();

const MetadataSchema = z
  .object({
    repo: z.string(),
    commit: z.string(),
    generatedAt: z.string(),
    generators: z.array(GeneratorInfoSchema),
  })
  .passthrough();

const DiagnosticSchema = z.object({
  severity: z.enum(["info", "warn", "error"]),
  analyzer: z.string(),
  message: z.string(),
  nodeId: NodeIdSchema.optional(),
  code: z.string().optional(),
});

const IRSchema = z.object({
  metadata: MetadataSchema,
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  diagnostics: z.array(DiagnosticSchema).optional(),
});

const SchemaVersionSchema = z
  .string()
  .refine(
    (v) => v === SCHEMA_VERSION,
    (v) => ({
      message: `schemaVersion mismatch: got "${v}", expected "${SCHEMA_VERSION}". Run the IR through migrations before validating.`,
    }),
  );

const IRDocumentSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  ir: IRSchema,
});

// =============================================================================
// Cross-cutting checks
// =============================================================================

function checkCrossCutting(doc: { ir: { nodes: Array<{ id: string; parentId?: string }>; edges: Array<{ sourceId: string; targetId: string }>; diagnostics?: Array<{ nodeId?: string }> } }): ValidationError[] {
  const errors: ValidationError[] = [];
  const nodeIds = new Set<string>();
  const seenDup = new Set<string>();

  doc.ir.nodes.forEach((n, i) => {
    if (nodeIds.has(n.id) && !seenDup.has(n.id)) {
      seenDup.add(n.id);
      errors.push({
        path: `/ir/nodes/${i}/id`,
        message: `duplicate node id "${n.id}"`,
      });
    }
    nodeIds.add(n.id);
  });

  doc.ir.nodes.forEach((n, i) => {
    if (n.parentId !== undefined && !nodeIds.has(n.parentId)) {
      errors.push({
        path: `/ir/nodes/${i}/parentId`,
        message: `parentId "${n.parentId}" does not reference any node in the document`,
      });
    }
  });

  doc.ir.edges.forEach((e, i) => {
    if (!nodeIds.has(e.sourceId)) {
      errors.push({
        path: `/ir/edges/${i}/sourceId`,
        message: `edge sourceId "${e.sourceId}" does not reference any node in the document`,
      });
    }
    if (!nodeIds.has(e.targetId)) {
      errors.push({
        path: `/ir/edges/${i}/targetId`,
        message: `edge targetId "${e.targetId}" does not reference any node in the document`,
      });
    }
  });

  doc.ir.diagnostics?.forEach((d, i) => {
    if (d.nodeId !== undefined && !nodeIds.has(d.nodeId)) {
      errors.push({
        path: `/ir/diagnostics/${i}/nodeId`,
        message: `diagnostic nodeId "${d.nodeId}" does not reference any node in the document`,
      });
    }
  });

  return errors;
}

// =============================================================================
// Zod issue → ValidationError
// =============================================================================

function zodIssuesToErrors(issues: z.ZodIssue[]): ValidationError[] {
  return issues.map((issue) => ({
    path: pathToJsonPointer(issue.path),
    message: issue.message,
  }));
}

/** RFC 6901: empty path -> "", segments joined by "/" with ~ and / escaped. */
function pathToJsonPointer(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return "";
  return (
    "/" +
    path
      .map((seg) => {
        const s = String(seg);
        return s.replace(/~/g, "~0").replace(/\//g, "~1");
      })
      .join("/")
  );
}

// Re-export for convenience so callers can import the schema if they want
// to compose it (e.g. ir-loader running migrations and validating in one go).
export { IRDocumentSchema };

// Helper for downstream code that has a validated string and wants the brand.
export function asNodeId(s: string): NodeId {
  return s as NodeId;
}
