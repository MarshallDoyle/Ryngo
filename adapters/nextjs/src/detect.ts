/**
 * Detect: is this repo a Next.js App Router project?
 *
 * Two-condition check (per the adapter README's "cheap secondary signal" rule):
 *   1. `next` in `package.json` `dependencies` or `devDependencies`.
 *   2. An `app/` (or `src/app/`) directory exists at any package root.
 *
 * We deliberately don't claim pages-router projects — the App Router is the
 * v0.4 deliverable and pages/* uses different routing semantics. A repo with
 * both `pages/` and `app/` is treated as App Router (Next.js itself supports
 * this hybrid; `app/` takes precedence for any overlapping routes).
 */

import type { DetectContext, DetectResult } from "@codegraph/adapter-sdk";

const APP_DIR_CANDIDATES = ["app", "src/app"] as const;

export async function detect(ctx: DetectContext): Promise<DetectResult> {
  const evidence: string[] = [];

  const pkgWithNext = findPackageJsonWithNext(ctx.manifests);
  if (!pkgWithNext) return { active: false };
  evidence.push(`found 'next' in ${pkgWithNext.path}`);

  const appDir = await findAppDir(ctx);
  if (!appDir) return { active: false };
  evidence.push(`found App Router directory '${appDir}/'`);

  return { active: true, evidence, confidence: 0.95 };
}

interface PackageJsonHit {
  readonly path: string;
  readonly version: string;
}

function findPackageJsonWithNext(
  manifests: DetectContext["manifests"],
): PackageJsonHit | null {
  for (const entry of manifests.packageJson) {
    const data = entry.data;
    const deps = mergeDeps(data["dependencies"], data["devDependencies"]);
    const version = deps["next"];
    if (typeof version === "string") {
      return { path: entry.path, version };
    }
  }
  return null;
}

function mergeDeps(...sources: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    if (src && typeof src === "object" && !Array.isArray(src)) {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        out[k] = v;
      }
    }
  }
  return out;
}

async function findAppDir(ctx: DetectContext): Promise<string | null> {
  for (const candidate of APP_DIR_CANDIDATES) {
    if (await ctx.fs.exists(candidate)) {
      const stat = await ctx.fs.stat(candidate).catch(() => null);
      if (stat?.isDirectory) return candidate;
    }
  }
  // Monorepo fallback: any package with an `app/` sibling to its package.json.
  for (const candidate of APP_DIR_CANDIDATES) {
    const matches = await ctx.fs.glob(`**/${candidate}/**/{page,route}.{ts,tsx,js,jsx}`);
    if (matches.length > 0) {
      const first = matches[0]!;
      const idx = first.indexOf("/" + candidate + "/");
      if (idx >= 0) return first.slice(0, idx + 1 + candidate.length);
      if (first.startsWith(candidate + "/")) return candidate;
    }
  }
  return null;
}
