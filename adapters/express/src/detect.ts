/**
 * `detect` phase for the Express adapter.
 *
 * Manifest-only check. Per the spec performance contract this must finish
 * in <50ms for a 100k-file repo (hard ceiling 1s), so we deliberately do
 * NOT scan source here. The host will only call `analyzeFile` for files
 * matching `appliesTo` if `detect` returned `active: true`.
 *
 * Detection is positive when ANY `package.json` in scope lists `express`
 * in `dependencies` or `devDependencies`. Monorepos are handled correctly
 * because `ctx.manifests.packageJson` carries every manifest the host
 * found in scope (one entry per workspace, plus root).
 *
 * Edge cases we handle:
 *   - `express` listed but only as a transitive (we don't see those — the
 *     host filters `peerDependencies` away by spec). That's fine: a
 *     transitive express user typically does not register routes here.
 *   - Forks like `express@npm:hyper-express` — we skip these. A user with a
 *     hard fork can configure the adapter manually via repo config.
 *   - Express in `optionalDependencies` — we count it; absence at install
 *     time still means absence at analysis time, which the user can fix
 *     by running install before analysis.
 */

import type { DetectContext, DetectResult } from "@codegraph/adapter-sdk";

/** Dependency keys we consider when looking for `express`. */
const DEP_KEYS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** Package names that count as "Express". Conservative on purpose. */
const EXPRESS_PACKAGE_NAMES: ReadonlySet<string> = new Set<string>(["express"]);

export async function detectExpress(ctx: DetectContext): Promise<DetectResult> {
  const evidence: string[] = [];

  for (const manifest of ctx.manifests.packageJson) {
    const found = findExpressVersion(manifest.data);
    if (!found) continue;
    evidence.push(`${manifest.path} declares ${found.name}@${found.version}`);
  }

  if (evidence.length === 0) {
    return { active: false };
  }

  // Confidence is purely a UI sort key per the spec; a single solid
  // package.json signal is high enough. We never claim 1.0 because our
  // detect can't rule out "user added express but never imports it".
  return {
    active: true,
    evidence,
    confidence: 0.9,
  };
}

/**
 * Look for an Express dependency entry. Returns the FIRST match found, in
 * deterministic key order, or `null`. We deliberately don't merge across
 * the three dep buckets — first hit wins because the same package name
 * cannot legitimately appear in two of them.
 */
function findExpressVersion(
  pkg: Record<string, unknown>,
): { name: string; version: string } | null {
  for (const key of DEP_KEYS) {
    const bucket = pkg[key];
    if (!isStringMap(bucket)) continue;

    for (const name of EXPRESS_PACKAGE_NAMES) {
      const version = bucket[name];
      if (typeof version !== "string") continue;
      // Skip aliased forks (`"express": "npm:hyper-express@^6"`). The
      // adapter is sound only against real express semantics.
      if (version.startsWith("npm:") && !version.startsWith("npm:express@")) {
        continue;
      }
      return { name, version };
    }
  }
  return null;
}

function isStringMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
