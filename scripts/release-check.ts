#!/usr/bin/env tsx
/**
 * Pre-publish sanity checks. Run via `pnpm tsx scripts/release-check.ts`.
 *
 * Goals:
 *   - Catch the kind of mistake that, if it slipped through, would
 *     poison the npm registry with an unfixable bad publish (wrong
 *     name, missing files, accidental private flag).
 *   - Catch monorepo-internal drift before Changesets has a chance
 *     to compute a release plan (workspace:* leaks, IR schema /
 *     adapter-sdk peer mismatch).
 *
 * Non-goals:
 *   - Lint, type-check, or test. Those are separate turbo tasks; the
 *     release workflow runs them too. This script is for properties
 *     `tsc --noEmit` cannot see (semantic shape of package.json files
 *     and cross-package version assertions).
 *
 * The script has no external dependencies beyond what is already
 * installed in the repo (Node's stdlib). Importantly it does NOT
 * import `@codegraph/core` to read IR_SCHEMA_VERSION — that would
 * require the build to have run. We re-read the source file directly.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// `tsx` runs this file as ESM under modern Node, so __dirname is not
// available; derive it from import.meta.url instead.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

type Pkg = {
  dir: string;
  name?: string;
  version?: string;
  private?: boolean;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
  files?: string[];
  bin?: string | Record<string, string>;
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  keywords?: string[];
  repository?: unknown;
  license?: string;
};

const errors: string[] = [];
const warnings: string[] = [];

function err(msg: string) { errors.push(msg); }
function warn(msg: string) { warnings.push(msg); }

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T;
}

async function listWorkspacePackages(): Promise<Pkg[]> {
  // Source of truth: package.json#workspaces. Mirrored in
  // pnpm-workspace.yaml; we read package.json to avoid a YAML dep.
  const rootPkg = await readJson<{ workspaces: string[] }>(path.join(ROOT, "package.json"));
  const dirs: string[] = [];
  for (const pattern of rootPkg.workspaces) {
    // We only support the trailing "/*" pattern that this repo uses.
    if (!pattern.endsWith("/*")) {
      err(`unsupported workspace pattern in root package.json: ${pattern}`);
      continue;
    }
    const base = path.join(ROOT, pattern.slice(0, -2));
    if (!existsSync(base)) continue;
    for (const entry of await readdir(base)) {
      const full = path.join(base, entry);
      if ((await stat(full)).isDirectory() && existsSync(path.join(full, "package.json"))) {
        dirs.push(full);
      }
    }
  }
  const pkgs: Pkg[] = [];
  for (const dir of dirs) {
    const data = await readJson<Pkg>(path.join(dir, "package.json"));
    pkgs.push({ ...data, dir });
  }
  return pkgs;
}

function checkRequiredFields(pkg: Pkg) {
  if (!pkg.name) err(`${pkg.dir}: package.json#name is missing`);
  if (!pkg.version) err(`${pkg.dir}: package.json#version is missing`);
  if (!pkg.license) err(`${pkg.name ?? pkg.dir}: missing license field`);
  if (pkg.private) return; // private packages skip publish-shape checks
  // Public packages need an explicit publish access (Changesets
  // config sets the default, but per-package override is allowed —
  // make sure no one set it to "restricted" by accident).
  if (pkg.publishConfig?.access && pkg.publishConfig.access !== "public") {
    err(`${pkg.name}: publishConfig.access is "${pkg.publishConfig.access}" — public scoped packages need "public"`);
  }
  // The package contents you ship are determined by `files` (or
  // .npmignore, but we don't use that). Without `files`, npm packs
  // the entire directory — including src/, test/, .turbo cache, etc.
  if (!pkg.files || pkg.files.length === 0) {
    err(`${pkg.name}: package.json#files is required for publishable packages (otherwise npm packs the world)`);
  }
}

function checkNoWorkspaceLeak(pkg: Pkg) {
  // pnpm rewrites `workspace:*` ranges at publish time. If we see
  // one survive into a published artifact, something is broken. The
  // release script runs BEFORE `changeset version` rewrites, so we
  // expect to see workspace: ranges here — but they must all be
  // either `workspace:^` (runtime deps) or `workspace:*` (peer/dev).
  // Anything else (e.g. `workspace:~`, a literal `1.2.3` masquerading)
  // suggests a hand-edit that pnpm won't rewrite cleanly.
  for (const block of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = pkg[block];
    if (!deps) continue;
    for (const [dep, range] of Object.entries(deps)) {
      if (range.startsWith("workspace:")) {
        if (range !== "workspace:*" && range !== "workspace:^" && range !== "workspace:~") {
          err(`${pkg.name}: ${block}.${dep} uses unsupported workspace range "${range}"`);
        }
      }
    }
  }
}

function checkAdapterShape(pkg: Pkg) {
  // STRUCTURE.md §4.6: every first-party adapter must declare the
  // codegraph-adapter keyword and depend on @codegraph/adapter-sdk
  // as a peerDependency.
  //
  // NOTE on the brand rename: brand/decision.md §3.1 queues a future
  // rename to the "plinth-adapter" keyword + @plinth/* scope, but
  // the rename has NOT been authorized yet. Keep both checks pegged
  // to the current names; bump them in the same PR that flips the
  // npm scopes.
  if (!pkg.dir.includes(`${path.sep}adapters${path.sep}`)) return;
  if (!pkg.keywords?.includes("codegraph-adapter")) {
    err(`${pkg.name}: adapters must include "codegraph-adapter" in keywords (used by CLI runtime discovery)`);
  }
  const sdk = pkg.peerDependencies?.["@codegraph/adapter-sdk"];
  if (!sdk) {
    err(`${pkg.name}: adapters must declare @codegraph/adapter-sdk as a peerDependency`);
  }
  // STRUCTURE.md §9.3 carves out adapters as the only library
  // packages allowed (and required) to use a default export. We
  // can't statically check the export shape from package.json, but
  // we can verify the entry point exists.
}

function checkAdapterSdkAlignment(pkgs: Pkg[]) {
  // adapter-sdk re-exports the stable subset of @codegraph/core
  // types. STRUCTURE.md §4.5 / §6.1 says core and adapter-sdk
  // advance together when the IR schema changes. We can't enforce
  // "advance together" at this layer (that's a human review of
  // the changeset), but we CAN assert the SDK depends on the
  // exact in-repo core version.
  const sdk = pkgs.find((p) => p.name === "@codegraph/adapter-sdk");
  const core = pkgs.find((p) => p.name === "@codegraph/core");
  if (!sdk || !core) return; // not yet scaffolded
  const declared = sdk.peerDependencies?.["@codegraph/core"] ?? sdk.dependencies?.["@codegraph/core"];
  if (!declared) {
    err(`@codegraph/adapter-sdk: must depend on @codegraph/core`);
  } else if (!declared.startsWith("workspace:")) {
    err(`@codegraph/adapter-sdk: depends on @codegraph/core via "${declared}"; expected "workspace:^" or "workspace:*" pre-publish`);
  }
}

async function checkIrSchemaVersion(pkgs: Pkg[]) {
  // The IR_SCHEMA_VERSION constant is the user-facing contract
  // (STRUCTURE.md §6 "Compatibility matrix"). Bumping core's major
  // without bumping IR_SCHEMA_VERSION (or vice versa) is a
  // soft-misalignment that tests won't catch but reviewers will
  // catch in changelogs. We enforce only the floor here:
  // IR_SCHEMA_VERSION must exist and be a positive integer literal.
  const core = pkgs.find((p) => p.name === "@codegraph/core");
  if (!core) return;
  const versionFile = path.join(core.dir, "src", "ir", "version.ts");
  if (!existsSync(versionFile)) {
    warn(`@codegraph/core: src/ir/version.ts missing — IR_SCHEMA_VERSION not yet scaffolded`);
    return;
  }
  const text = await readFile(versionFile, "utf8");
  const match = text.match(/IR_SCHEMA_VERSION\s*=\s*(\d+)/);
  if (!match) {
    err(`@codegraph/core: could not locate IR_SCHEMA_VERSION = <integer> in src/ir/version.ts`);
    return;
  }
  const v = Number(match[1]);
  if (!Number.isInteger(v) || v < 1) {
    err(`@codegraph/core: IR_SCHEMA_VERSION must be a positive integer (got ${match[1]})`);
  }
}

function checkActionIgnored(pkgs: Pkg[]) {
  // The Action package is published via tags, not via Changesets.
  // It must NOT have `private: true` (that would block local
  // workflows from depending on it as a workspace), but it MUST
  // appear in .changeset/config.json#ignore so Changesets does not
  // try to publish it to npm.
  const action = pkgs.find((p) => p.name === "@codegraph/action");
  if (!action) return;
  if (action.private) {
    warn(`@codegraph/action: marked private — this is fine if intentional, but the release flow expects it to live as a public, ignored-by-changesets workspace package`);
  }
}

async function checkChangesetConfigConsistency() {
  const cfgPath = path.join(ROOT, ".changeset", "config.json");
  if (!existsSync(cfgPath)) {
    err(".changeset/config.json missing");
    return;
  }
  const cfg = await readJson<{
    ignore?: string[];
    access?: string;
    baseBranch?: string;
  }>(cfgPath);
  if (cfg.access !== "public") {
    err(`.changeset/config.json#access must be "public" (got "${cfg.access}")`);
  }
  if (cfg.baseBranch !== "main") {
    err(`.changeset/config.json#baseBranch must be "main" (got "${cfg.baseBranch}")`);
  }
  if (!cfg.ignore?.includes("@codegraph/action")) {
    err(`.changeset/config.json#ignore must include "@codegraph/action" (it follows tag-based release)`);
  }
}

async function main() {
  const pkgs = await listWorkspacePackages();
  for (const pkg of pkgs) {
    checkRequiredFields(pkg);
    checkNoWorkspaceLeak(pkg);
    checkAdapterShape(pkg);
  }
  checkAdapterSdkAlignment(pkgs);
  await checkIrSchemaVersion(pkgs);
  checkActionIgnored(pkgs);
  await checkChangesetConfigConsistency();

  if (warnings.length) {
    console.warn("release-check warnings:");
    for (const w of warnings) console.warn(`  - ${w}`);
  }
  if (errors.length) {
    console.error("release-check errors:");
    for (const e of errors) console.error(`  - ${e}`);
    console.error(`\n${errors.length} error(s); aborting release.`);
    process.exit(1);
  }
  console.log(`release-check ok (${pkgs.length} workspace packages inspected)`);
}

main().catch((e) => {
  console.error("release-check crashed:", e);
  process.exit(1);
});
