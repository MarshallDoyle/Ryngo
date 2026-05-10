/**
 * Typed shape and runtime schema for `.codegraph.yml`.
 *
 * The Zod schema in this file is the runtime validator; the TypeScript
 * types are derived from it via `z.infer`. The schema is kept in lockstep
 * with `spec/config.schema.json` — that JSON Schema is the spec, this Zod
 * schema enforces the same rules at load time.
 */

import { z } from 'zod';

/** Current `.codegraph.yml` schema version. Bumped on breaking changes. */
export const CONFIG_SCHEMA_VERSION = 1;

const GLOB = z.string().min(1);

const BOUNDARY_NAME = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, {
    message:
      "boundary names must match /^[a-zA-Z][a-zA-Z0-9_-]*$/ (no leading '_' — reserved for the implicit _unassigned boundary)",
  });

const ADAPTER_ID = z.string().regex(/^[a-z][a-z0-9_-]*$/, {
  message: 'adapter ids must match /^[a-z][a-z0-9_-]*$/',
});

const GROUP_ID = z.string().regex(/^[a-z][a-z0-9_-]*$/, {
  message: 'group ids must match /^[a-z][a-z0-9_-]*$/',
});

const HEX_COLOR = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
  message: 'color must be a CSS hex (#rgb or #rrggbb)',
});

const ProjectSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
  })
  .strict();

const AdapterConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    include: z.array(GLOB).optional(),
    exclude: z.array(GLOB).optional(),
    tsconfig: z.string().optional(),
    followTypeOnly: z.boolean().optional(),
    buildTags: z.array(z.string()).optional(),
    indexPath: z.string().optional(),
  })
  .passthrough();

const GroupSchema = z
  .object({
    id: GROUP_ID,
    label: z.string().optional(),
    pattern: GLOB.optional(),
    boundary: BOUNDARY_NAME.optional(),
    tagged: z.string().min(1).optional(),
    collapsed: z.boolean().optional(),
    color: HEX_COLOR.optional(),
  })
  .strict()
  .refine(
    (g) => g.pattern !== undefined || g.boundary !== undefined || g.tagged !== undefined,
    { message: "group must specify at least one of 'pattern', 'boundary', or 'tagged'" },
  );

const EntryPointKindSchema = z.enum(['function', 'file', 'route', 'export']);

const EntryPointIncludeSchema = z
  .object({
    kind: EntryPointKindSchema.optional(),
    symbol: z.string().optional(),
    path: z.string().optional(),
    label: z.string().optional(),
  })
  .strict()
  .refine((e) => (e.symbol === undefined) !== (e.path === undefined), {
    message: "entryPoint include must specify exactly one of 'symbol' or 'path'",
  });

const EntryPointExcludeSchema = z.union([GLOB, EntryPointIncludeSchema]);

const EntryPointsSchema = z
  .object({
    include: z.array(EntryPointIncludeSchema).optional(),
    exclude: z.array(EntryPointExcludeSchema).optional(),
  })
  .strict();

const OutputIRSchema = z
  .object({
    path: z.string().optional(),
    pretty: z.boolean().optional(),
    splitChunks: z.boolean().optional(),
  })
  .strict();

const ViewerPublishKindSchema = z.enum(['static', 'github-pages', 'none']);

const OutputViewerSchema = z
  .object({
    publish: z
      .object({
        kind: ViewerPublishKindSchema.optional(),
        dir: z.string().optional(),
        baseUrl: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const OutputCacheSchema = z
  .object({
    path: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const OutputSchema = z
  .object({
    ir: OutputIRSchema.optional(),
    viewer: OutputViewerSchema.optional(),
    cache: OutputCacheSchema.optional(),
  })
  .strict();

const SeveritySchema = z.enum(['error', 'warning', 'info', 'off']);

const DiffSchema = z
  .object({
    fail: z.array(SeveritySchema).optional(),
    rules: z.record(z.string(), SeveritySchema).optional(),
    ignore: z.array(GLOB).optional(),
  })
  .strict();

/**
 * Schema applied to the *raw* parsed YAML/JSON before defaults are merged.
 * Required fields are only `schemaVersion`; everything else is optional.
 */
export const RawConfigSchema = z
  .object({
    schemaVersion: z.number().int(),
    project: ProjectSchema.optional(),
    root: z.string().optional(),
    boundaries: z.record(BOUNDARY_NAME, z.array(GLOB).min(1)).optional(),
    ignore: z.array(GLOB).optional(),
    adapters: z.record(ADAPTER_ID, AdapterConfigSchema).optional(),
    groups: z.array(GroupSchema).optional(),
    entryPoints: EntryPointsSchema.optional(),
    output: OutputSchema.optional(),
    diff: DiffSchema.optional(),
  })
  .strict();

/**
 * Schema applied to the fully-merged config (raw + defaults). Mirrors the
 * raw shape but every default-able field is required at this point so
 * downstream consumers don't need to handle `undefined` constantly.
 */
export const CodegraphConfigSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    project: ProjectSchema,
    root: z.string(),
    boundaries: z.record(BOUNDARY_NAME, z.array(GLOB).min(1)),
    ignore: z.array(GLOB),
    adapters: z.record(ADAPTER_ID, AdapterConfigSchema),
    groups: z.array(GroupSchema),
    entryPoints: z.object({
      include: z.array(EntryPointIncludeSchema),
      exclude: z.array(EntryPointExcludeSchema),
    }),
    output: z.object({
      ir: z.object({
        path: z.string(),
        pretty: z.boolean(),
        splitChunks: z.boolean(),
      }),
      viewer: z.object({
        publish: z.object({
          kind: ViewerPublishKindSchema,
          dir: z.string(),
          baseUrl: z.string(),
        }),
      }),
      cache: z.object({
        path: z.string(),
        enabled: z.boolean(),
      }),
    }),
    diff: z.object({
      fail: z.array(SeveritySchema),
      rules: z.record(z.string(), SeveritySchema),
      ignore: z.array(GLOB),
    }),
  })
  .strict();

export type RawCodegraphConfig = z.infer<typeof RawConfigSchema>;
export type CodegraphConfig = z.infer<typeof CodegraphConfigSchema>;

export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type EntryPointInclude = z.infer<typeof EntryPointIncludeSchema>;
export type EntryPointExclude = z.infer<typeof EntryPointExcludeSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type ViewerPublishKind = z.infer<typeof ViewerPublishKindSchema>;
export type EntryPointKind = z.infer<typeof EntryPointKindSchema>;
