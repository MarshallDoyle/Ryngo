/**
 * codegraph adapter: Prisma — detection.
 *
 * Per spec/adapter-interface.ts §3.2, `detect` must be cheap (<50ms target,
 * 1s ceiling) and read manifest files only — never source. The Prisma adapter
 * activates when BOTH conditions hold:
 *
 *   1. `@prisma/client` (runtime client) OR `prisma` (CLI) appears in any
 *      package.json's dependencies / devDependencies. The CLI alone isn't
 *      proof of use, but together with a schema file it's enough.
 *   2. A `prisma/schema.prisma` (or any `**\/schema.prisma`) file exists in
 *      the in-scope filesystem.
 *
 * Both signals are required because:
 *   - Some monorepos vendor a `schema.prisma` for a type-only side package
 *     without actually depending on `@prisma/client` — analyze would emit
 *     model nodes with no caller edges, which is noise.
 *   - Some packages ship `@prisma/client` as a transitive dep but never
 *     write a schema; nothing to do.
 *
 * Returns a `DetectResult` whose `evidence` array is shown in the viewer's
 * Adapters panel so users can see *why* the adapter activated.
 */

import type { DetectContext, DetectResult } from "@codegraph/adapter-sdk";

const SCHEMA_GLOB = "**/schema.prisma";

const PRISMA_DEP_NAMES = ["@prisma/client", "prisma"] as const;

interface PackageJsonShape {
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly peerDependencies?: Record<string, unknown>;
  readonly optionalDependencies?: Record<string, unknown>;
}

export async function detect(ctx: DetectContext): Promise<DetectResult> {
  const evidence: string[] = [];

  // 1. Dependency check. We scan EVERY package.json the host pre-parsed —
  //    in a monorepo Prisma may live in one workspace package only. A single
  //    hit is enough to flip this signal on; we still record all of them as
  //    evidence so users can see where it came from.
  const depHits: string[] = [];
  for (const pkg of ctx.manifests.packageJson) {
    const data = pkg.data as PackageJsonShape;
    const merged: Record<string, unknown> = {
      ...(data.dependencies ?? {}),
      ...(data.devDependencies ?? {}),
      ...(data.peerDependencies ?? {}),
      ...(data.optionalDependencies ?? {}),
    };
    const hit = PRISMA_DEP_NAMES.find((n) => n in merged);
    if (hit) depHits.push(`${hit} in ${pkg.path}`);
  }

  if (depHits.length === 0) {
    return { active: false };
  }

  // 2. Schema-file check. The host's `glob` is sorted and deterministic.
  //    We don't read the files here — that's analyze.ts's job — we just
  //    confirm at least one exists.
  let schemaPaths: ReadonlyArray<string> = [];
  try {
    schemaPaths = await ctx.fs.glob(SCHEMA_GLOB);
  } catch (err) {
    // The fs glob is permission-scoped; if it throws on every call we treat
    // that as the host telling us "nothing in scope" rather than an error.
    ctx.log.debug("prisma: schema glob threw, treating as no-schema", {
      error: String(err),
    });
    schemaPaths = [];
  }

  if (schemaPaths.length === 0) {
    return { active: false };
  }

  // Both signals positive — emit human-readable evidence (capped so the
  // panel doesn't balloon on large monorepos). The cap is deterministic
  // because `glob` returns sorted results.
  for (const dep of depHits.slice(0, 4)) evidence.push(dep);
  if (depHits.length > 4) {
    evidence.push(`(+${depHits.length - 4} more package.json hits)`);
  }
  for (const sp of schemaPaths.slice(0, 4)) {
    evidence.push(`schema: ${sp}`);
  }
  if (schemaPaths.length > 4) {
    evidence.push(`(+${schemaPaths.length - 4} more schema files)`);
  }

  return {
    active: true,
    evidence,
    // Confidence is purely UI sort order. We're high-confidence: both gates
    // passed and they're orthogonal failure modes.
    confidence: 0.95,
  };
}

/**
 * Cached glob result for analyze/resolve. Detect is the only phase guaranteed
 * to run before analyzeFile, but `ctx.fs.glob` is cheap and deterministic so
 * resolve.ts re-runs it rather than relying on cross-phase mutable state
 * (forbidden by §6.2 "no global mutable state").
 */
export async function findSchemaFiles(
  fs: { glob(p: string): Promise<ReadonlyArray<string>> },
): Promise<ReadonlyArray<string>> {
  return fs.glob(SCHEMA_GLOB);
}
