/**
 * adapter-env — detect phase.
 *
 * Two responsibilities:
 *
 *   1. Decide whether the adapter applies to this repo (returning a
 *      DetectResult per the adapter-interface spec).
 *   2. As a side effect of (1), build the dotenv registry used by analyzeFile
 *      and finalize. We do this in detect rather than analyzeFile because:
 *        - .env files are repo-wide (cross-file) — analyzeFile is per-file.
 *        - The registry is small (typically <100 entries) and reading it
 *          once up-front lets analyzeFile run with no global I/O, keeping
 *          its cache key clean (per spec §6.3).
 *        - detect's time budget (50ms target) is plenty for 5–20 .env files
 *          of <16KB each.
 *
 * The adapter is "active" if EITHER:
 *   - any `.env*` file exists at the repo root or in the common app/
 *     subdirs (apps/*, packages/*, services/*), OR
 *   - any manifest (package.json / pyproject.toml / requirements.txt)
 *     declares an env-related dep (`dotenv`, `dotenv-flow`, `dotenv-expand`,
 *     `pydantic-settings`, `python-dotenv`).
 *
 * We deliberately do NOT activate just because `process.env` MIGHT appear in
 * source — that would require scanning code in detect, which the spec
 * forbids (detect must be cheap and source-free). If a repo has neither
 * .env files nor a config dep but uses `process.env`, the user can force-
 * activate the adapter via codegraph.config.ts; the IR will still be
 * useful.
 */

import type { DetectContext, DetectResult } from "@codegraph/adapter-sdk";
import type { DotenvEntry, DotenvRegistry } from "./types.js";
import { parseDotenv } from "./dotenv-parser.js";

/**
 * Glob patterns for `.env*` files. Limited to repo root + common
 * monorepo-app subdirs to keep the glob bounded; users with non-standard
 * layouts can add patterns via the (future) `adapter.env.dotenvGlobs`
 * config option.
 */
const DOTENV_GLOBS: ReadonlyArray<string> = [
  ".env",
  ".env.*",
  "apps/*/.env",
  "apps/*/.env.*",
  "packages/*/.env",
  "packages/*/.env.*",
  "services/*/.env",
  "services/*/.env.*",
];

/**
 * Deps that imply env-config usage even if no `.env*` file is present (e.g.
 * the repo reads from system env on production but ships only `.env.example`,
 * which is `gitignore`d in some setups).
 */
const ENV_DEP_NAMES: ReadonlyArray<string> = [
  // npm
  "dotenv",
  "dotenv-flow",
  "dotenv-expand",
  "@dotenvx/dotenvx",
  "@t3-oss/env-nextjs",
  "@t3-oss/env-core",
  "envalid",
  // PyPI
  "python-dotenv",
  "pydantic-settings",
];

/**
 * Run detect: glob for .env* files (parsing each), inspect manifests, and
 * return the DetectResult. Side effect: returns a built `registry` so the
 * adapter can stash it for later phases. We surface it via the return value
 * rather than mutating the adapter object — adapter-level mutable state is
 * banned by spec §6.2.
 */
export async function runDetect(
  ctx: DetectContext,
): Promise<{ result: DetectResult; registry: DotenvRegistry }> {
  const evidence: string[] = [];
  const dotenvFiles: string[] = [];
  const allEntries: DotenvEntry[] = [];

  // ---- 1. Find and parse .env files. ---------------------------------------
  // We deduplicate against `seen` because the globs above can match the same
  // file twice (e.g. if a user nests apps/web inside the repo root by accident).
  const seen = new Set<string>();
  for (const pattern of DOTENV_GLOBS) {
    let matches: ReadonlyArray<string>;
    try {
      matches = await ctx.fs.glob(pattern);
    } catch {
      // Glob failure on a restricted host is non-fatal — just skip.
      continue;
    }
    for (const path of matches) {
      if (seen.has(path)) continue;
      seen.add(path);

      let content: string;
      try {
        content = await ctx.fs.read(path);
      } catch {
        // Could be a denied path, a broken symlink, or an oversize file —
        // the host's ScopedFs will have surfaced its own error already.
        continue;
      }

      // Skip absurdly small/large files defensively. The host already
      // enforces a max-size limit; this is just a soft cap to avoid
      // shoving a binary file into the parser.
      if (content.length > 256 * 1024) {
        ctx.diagnostic({
          severity: "warn",
          code: "env/dotenv-too-large",
          message: `Skipping ${path}: dotenv file exceeds 256KB.`,
          file: path,
        });
        continue;
      }

      const parsed = parseDotenv(path, content);
      dotenvFiles.push(path);
      allEntries.push(...parsed);
    }
  }

  if (dotenvFiles.length > 0) {
    evidence.push(
      `found ${dotenvFiles.length} dotenv file${dotenvFiles.length === 1 ? "" : "s"} (${allEntries.length} declared keys)`,
    );
  }

  // ---- 2. Manifest inspection. --------------------------------------------
  const manifestEvidence = collectManifestEvidence(ctx);
  evidence.push(...manifestEvidence);

  // ---- 3. Build the registry. ---------------------------------------------
  const byName = new Map<string, DotenvEntry[]>();
  for (const entry of allEntries) {
    const arr = byName.get(entry.name) ?? [];
    arr.push(entry);
    byName.set(entry.name, arr);
  }
  const registry: DotenvRegistry = {
    byName,
    entries: allEntries,
    files: dotenvFiles,
  };

  // ---- 4. Compose DetectResult. -------------------------------------------
  if (evidence.length === 0) {
    return { result: { active: false }, registry };
  }
  return {
    result: {
      active: true,
      evidence,
      // Confidence is 1.0 only when we have BOTH .env files and a manifest
      // dep — that's an unambiguous signal. Otherwise scale down so the
      // viewer's adapter panel can sort opportunistically.
      confidence: dotenvFiles.length > 0 && manifestEvidence.length > 0 ? 1 : 0.7,
    },
    registry,
  };
}

/**
 * Inspect the host's pre-parsed manifests (`packageJson`, `pyproject`,
 * other) for env-config-related dependencies. Returns one string per
 * matching manifest+dep combination, suitable for the `evidence` array.
 *
 * Read-only — does not modify ctx state.
 */
function collectManifestEvidence(ctx: DetectContext): string[] {
  const out: string[] = [];

  for (const pkg of ctx.manifests.packageJson) {
    const deps = collectPackageJsonDeps(pkg.data);
    for (const dep of ENV_DEP_NAMES) {
      if (deps.has(dep)) {
        out.push(`'${dep}' in ${pkg.path}`);
      }
    }
  }

  for (const pyproject of ctx.manifests.pyproject) {
    // pyproject.toml has many dialects (poetry, PEP 621, hatch, pdm). We do
    // a permissive sweep: anywhere a package name appears as a key or value,
    // we count it. False positives here are cheap (we only set evidence,
    // not behavior).
    const flat = JSON.stringify(pyproject.data);
    for (const dep of ENV_DEP_NAMES) {
      // Match `"<dep>"` to avoid catching `dep` as a substring of another
      // package's name.
      if (flat.includes(`"${dep}"`)) {
        out.push(`'${dep}' in ${pyproject.path}`);
      }
    }
  }

  // requirements.txt-style files come through as `manifests.other` (the
  // host doesn't structurally parse them; we get raw text). Adapter-config
  // can extend this glob in a future revision.
  for (const other of ctx.manifests.other) {
    if (!other.path.endsWith("requirements.txt") && !other.path.endsWith("Pipfile")) continue;
    for (const dep of ENV_DEP_NAMES) {
      const re = new RegExp(`(^|\\n)\\s*${escapeRegex(dep)}\\b`, "i");
      if (re.test(other.raw)) {
        out.push(`'${dep}' in ${other.path}`);
      }
    }
  }

  return out;
}

/**
 * Pull every direct dependency name out of a parsed package.json. Includes
 * `dependencies`, `devDependencies`, `peerDependencies`, and
 * `optionalDependencies`; ignores `bundledDependencies` (rarely used) and
 * `overrides` (a resolver concern, not a real dep).
 */
function collectPackageJsonDeps(data: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const entry = data[key];
    if (entry && typeof entry === "object") {
      for (const dep of Object.keys(entry as Record<string, unknown>)) {
        out.add(dep);
      }
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
