/**
 * `.codegraph.yml` loader.
 *
 * Resolves a config file under a given repo root, parses it (YAML or JSON),
 * deep-merges over the defaults per `spec/config-schema.md` §4, and validates
 * the result with Zod. The returned `CodegraphConfig` is a fully-resolved
 * object — no `undefined` for default-able fields — so downstream consumers
 * (cli-index, cli-init, every adapter) can read `config.<x>` directly.
 *
 * Boundary glob patterns are *not* enumerated against the filesystem here.
 * `loadConfig` returns a `boundaryMatcher(path)` builder so callers can
 * decide where and when to walk the file tree; this keeps loading cheap and
 * lets the indexer push the work into its own worker pool.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { ZodError } from 'zod';

import { DEFAULT_CONFIG, DEFAULT_IGNORE } from './defaults.js';
import {
  CONFIG_SCHEMA_VERSION,
  CodegraphConfigSchema,
  RawConfigSchema,
  type AdapterConfig,
  type CodegraphConfig,
  type RawCodegraphConfig,
} from './types.js';

const CONFIG_FILENAMES = [
  '.codegraph.yml',
  '.codegraph.yaml',
  '.codegraph.json',
] as const;

/** Adapter ids the CLI knows about today. Unknown ids warn — see §3.6. */
const KNOWN_ADAPTER_IDS = new Set([
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'ruby',
  'scip',
]);

/** Sink interface for non-fatal load-time messages (e.g. unknown adapter). */
export interface ConfigWarningSink {
  warn(message: string): void;
}

const DEFAULT_WARNING_SINK: ConfigWarningSink = {
  warn(message) {
    // eslint-disable-next-line no-console
    console.warn(`[codegraph config] ${message}`);
  },
};

export interface LoadConfigOptions {
  /** Override the warning sink (default: console.warn). */
  warn?: ConfigWarningSink;
  /**
   * Override the env-var lookup. Primarily for tests. When omitted, the
   * loader reads `process.env.CODEGRAPH_CONFIG`.
   */
  env?: Record<string, string | undefined>;
}

export class CodegraphConfigError extends Error {
  readonly issues: readonly { path: string; message: string }[];

  constructor(message: string, issues: readonly { path: string; message: string }[] = []) {
    super(message);
    this.name = 'CodegraphConfigError';
    this.issues = issues;
  }
}

/**
 * Locate, parse, validate, and merge a `.codegraph.yml` against the defaults.
 *
 * Resolution order:
 *   1. `$CODEGRAPH_CONFIG` (absolute or resolved against `repoRoot`).
 *   2. `<repoRoot>/.codegraph.yml`
 *   3. `<repoRoot>/.codegraph.yaml`
 *   4. `<repoRoot>/.codegraph.json`
 *   5. Nothing — return `DEFAULT_CONFIG` (zero-config run).
 *
 * Throws `CodegraphConfigError` for: unreadable files, malformed YAML/JSON,
 * unknown `schemaVersion`, schema-validation failures.
 */
export async function loadConfig(
  repoRoot: string,
  options: LoadConfigOptions = {},
): Promise<CodegraphConfig> {
  const warn = options.warn ?? DEFAULT_WARNING_SINK;
  const env = options.env ?? process.env;

  const filePath = await resolveConfigPath(repoRoot, env);
  if (filePath === null) {
    return cloneConfig(DEFAULT_CONFIG);
  }

  const raw = await parseConfigFile(filePath);
  const parsed = validateRaw(raw, filePath);

  if (parsed.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new CodegraphConfigError(
      `unsupported schemaVersion ${parsed.schemaVersion} in ${filePath} — ` +
        `this build of codegraph supports schemaVersion ${CONFIG_SCHEMA_VERSION}. ` +
        `Run \`codegraph migrate\` to upgrade older files; for newer versions, upgrade the CLI.`,
    );
  }

  // Warn (do not error) for unknown adapter ids so configs survive
  // adapters being added or removed across CLI releases.
  if (parsed.adapters) {
    for (const id of Object.keys(parsed.adapters)) {
      if (!KNOWN_ADAPTER_IDS.has(id)) {
        warn(
          `unknown adapter id '${id}' in ${filePath}: passed through as-is. ` +
            `Known ids: ${[...KNOWN_ADAPTER_IDS].sort().join(', ')}.`,
        );
      }
    }
  }

  const merged = mergeWithDefaults(parsed);

  // Final structural validation: catches any drift between merge logic and
  // schema, not just bad user input.
  const final = CodegraphConfigSchema.safeParse(merged);
  if (!final.success) {
    throw toConfigError(final.error, filePath, 'merged config');
  }

  return final.data;
}

/**
 * Build a matcher for a single boundary's globs. Lazy: the caller decides
 * which paths to test, so we never enumerate the filesystem here.
 *
 * Returns `null` if `boundaryName` is not declared in the config (callers
 * should treat that as the implicit `_unassigned` boundary).
 */
export function boundaryMatcher(
  config: CodegraphConfig,
  boundaryName: string,
): ((relPath: string) => boolean) | null {
  const patterns = config.boundaries[boundaryName];
  if (patterns === undefined) return null;
  return makeGlobListMatcher(patterns);
}

/**
 * For an arbitrary file path (relative to `config.root`), return the
 * boundary it lands in, applying the resolution rules from §3.4:
 *
 *   1. Longest matching positive pattern wins.
 *   2. Ties resolve by declaration order in the YAML (top wins).
 *   3. A negated pattern (`!foo`) inside a boundary's list removes the file
 *      from that boundary; it never moves it elsewhere.
 *   4. Files matching no boundary land in `_unassigned`.
 */
export function classifyBoundary(config: CodegraphConfig, relPath: string): string {
  const normalized = normalizeRelPath(relPath);

  // Object key order is insertion order in modern JS engines and in YAML
  // parsers using the default schema, so this preserves the YAML's
  // declaration order — load-bearing for tie-breaking (rule 2).
  const declarationOrder = Object.keys(config.boundaries);

  let best: { name: string; length: number; index: number } | null = null;

  for (let i = 0; i < declarationOrder.length; i++) {
    const name = declarationOrder[i]!;
    const patterns = config.boundaries[name]!;

    let matched = false;
    let bestLenForBoundary = -1;

    for (const pattern of patterns) {
      const negated = pattern.startsWith('!');
      const body = negated ? pattern.slice(1) : pattern;
      if (body.length === 0) continue;
      if (matchGlob(body, normalized)) {
        if (negated) {
          matched = false;
          bestLenForBoundary = -1;
        } else {
          matched = true;
          if (body.length > bestLenForBoundary) bestLenForBoundary = body.length;
        }
      }
    }

    if (matched) {
      if (
        best === null ||
        bestLenForBoundary > best.length ||
        // tie on length → keep the earlier-declared boundary (rule 2)
        (bestLenForBoundary === best.length && i < best.index)
      ) {
        best = { name, length: bestLenForBoundary, index: i };
      }
    }
  }

  return best?.name ?? '_unassigned';
}

// ---------- internals ----------

async function resolveConfigPath(
  repoRoot: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const override = env.CODEGRAPH_CONFIG;
  if (override !== undefined && override.length > 0) {
    const abs = path.isAbsolute(override) ? override : path.resolve(repoRoot, override);
    try {
      await fs.access(abs);
    } catch {
      throw new CodegraphConfigError(
        `CODEGRAPH_CONFIG points at '${abs}', which does not exist or is not readable.`,
      );
    }
    return abs;
  }

  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(repoRoot, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

async function parseConfigFile(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new CodegraphConfigError(
      `failed to read config file ${filePath}: ${(err as Error).message}`,
    );
  }

  try {
    if (filePath.endsWith('.json')) {
      return JSON.parse(text) as unknown;
    }
    // js-yaml returns `undefined` for empty docs; coerce to {} so an
    // empty file is equivalent to a missing one (after schemaVersion
    // validation kicks in below).
    return yaml.load(text) ?? {};
  } catch (err) {
    throw new CodegraphConfigError(
      `failed to parse config file ${filePath}: ${(err as Error).message}`,
    );
  }
}

function validateRaw(raw: unknown, filePath: string): RawCodegraphConfig {
  const result = RawConfigSchema.safeParse(raw);
  if (!result.success) {
    throw toConfigError(result.error, filePath, 'raw config');
  }
  return result.data;
}

function toConfigError(err: ZodError, filePath: string, stage: string): CodegraphConfigError {
  const issues = err.issues.map((i) => ({
    path: i.path.join('/') || '<root>',
    message: i.message,
  }));
  const summary = issues
    .slice(0, 5)
    .map((i) => `  /${i.path}: ${i.message}`)
    .join('\n');
  const suffix = issues.length > 5 ? `\n  ... and ${issues.length - 5} more` : '';
  return new CodegraphConfigError(
    `${stage} validation failed for ${filePath}:\n${summary}${suffix}`,
    issues,
  );
}

/**
 * Deep-merge a (validated) raw user config over the built-in defaults.
 *
 * Merge rules per `spec/config-schema.md` §4:
 *   - Scalars: user wins.
 *   - `ignore`: concatenate defaults + user; the matcher resolves `!` later.
 *   - Object maps (`boundaries`, `adapters`, `diff.rules`, `output.*`): merge
 *     keys, user wins per-key.
 *   - Arrays of objects (`groups`, `entryPoints.*`): user fully replaces — no
 *     element-wise merging, since identity isn't well-defined.
 */
function mergeWithDefaults(raw: RawCodegraphConfig): CodegraphConfig {
  const d = DEFAULT_CONFIG;

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    project: { ...d.project, ...(raw.project ?? {}) },
    root: raw.root ?? d.root,
    boundaries: { ...(raw.boundaries ?? {}) },
    ignore: mergeIgnore(d.ignore, raw.ignore),
    adapters: mergeAdapters(d.adapters, raw.adapters),
    groups: raw.groups ? [...raw.groups] : [...d.groups],
    entryPoints: {
      include: raw.entryPoints?.include ? [...raw.entryPoints.include] : [...d.entryPoints.include],
      exclude: raw.entryPoints?.exclude ? [...raw.entryPoints.exclude] : [...d.entryPoints.exclude],
    },
    output: {
      ir: { ...d.output.ir, ...(raw.output?.ir ?? {}) },
      viewer: {
        publish: {
          ...d.output.viewer.publish,
          ...(raw.output?.viewer?.publish ?? {}),
        },
      },
      cache: { ...d.output.cache, ...(raw.output?.cache ?? {}) },
    },
    diff: {
      fail: raw.diff?.fail ? [...raw.diff.fail] : [...d.diff.fail],
      rules: { ...d.diff.rules, ...(raw.diff?.rules ?? {}) },
      ignore: raw.diff?.ignore ? [...raw.diff.ignore] : [...d.diff.ignore],
    },
  };
}

function mergeIgnore(defaults: readonly string[], user: readonly string[] | undefined): string[] {
  if (user === undefined) return [...defaults];
  // Defaults first so a user `!pattern` later in the list un-ignores them
  // when the matcher walks the array in order.
  return [...defaults, ...user];
}

function mergeAdapters(
  defaults: Readonly<Record<string, AdapterConfig>>,
  user: Readonly<Record<string, AdapterConfig>> | undefined,
): Record<string, AdapterConfig> {
  const out: Record<string, AdapterConfig> = { ...defaults };
  if (user === undefined) return out;
  for (const [id, cfg] of Object.entries(user)) {
    out[id] = { ...(out[id] ?? {}), ...cfg };
  }
  return out;
}

function cloneConfig(c: CodegraphConfig): CodegraphConfig {
  return {
    schemaVersion: c.schemaVersion,
    project: { ...c.project },
    root: c.root,
    boundaries: Object.fromEntries(
      Object.entries(c.boundaries).map(([k, v]) => [k, [...v]]),
    ),
    ignore: [...c.ignore],
    adapters: Object.fromEntries(
      Object.entries(c.adapters).map(([k, v]) => [k, { ...v }]),
    ),
    groups: c.groups.map((g) => ({ ...g })),
    entryPoints: {
      include: c.entryPoints.include.map((e) => ({ ...e })),
      exclude: c.entryPoints.exclude.map((e) => (typeof e === 'string' ? e : { ...e })),
    },
    output: {
      ir: { ...c.output.ir },
      viewer: { publish: { ...c.output.viewer.publish } },
      cache: { ...c.output.cache },
    },
    diff: {
      fail: [...c.diff.fail],
      rules: { ...c.diff.rules },
      ignore: [...c.diff.ignore],
    },
  };
}

function normalizeRelPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  if (s.startsWith('/')) s = s.slice(1);
  return s;
}

function makeGlobListMatcher(patterns: readonly string[]): (relPath: string) => boolean {
  // Build positive and negative regexes once; the matcher just runs them.
  const pos: RegExp[] = [];
  const neg: RegExp[] = [];
  for (const p of patterns) {
    if (p.startsWith('!')) neg.push(globToRegExp(p.slice(1)));
    else pos.push(globToRegExp(p));
  }
  return (relPath) => {
    const n = normalizeRelPath(relPath);
    if (!pos.some((re) => re.test(n))) return false;
    if (neg.some((re) => re.test(n))) return false;
    return true;
  };
}

function matchGlob(pattern: string, relPath: string): boolean {
  return globToRegExp(pattern).test(relPath);
}

/**
 * Convert a picomatch/gitignore-style glob to a `RegExp`.
 *
 * Supported:
 *   - `**`   matches across directory boundaries (zero or more segments)
 *   - `*`    matches any chars except `/`
 *   - `?`    matches any single char except `/`
 *   - `[abc]` character classes
 *   - leading `**` or no prefix matches anywhere along the path
 *
 * This is good-enough for boundary classification at config-load time. For
 * the production walker, callers can swap in `picomatch` itself; this lives
 * here only so `core` doesn't have to take a runtime dep just to classify
 * paths during config validation/test runs.
 */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** — zero or more path segments
        // consume optional trailing slash so `foo/**/bar` matches `foo/bar`
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '.' || c === '+' || c === '(' || c === ')' || c === '|' || c === '^' || c === '$' || c === '{' || c === '}' || c === '\\') {
      re += '\\' + c;
      i += 1;
    } else if (c === '[') {
      // character class — copy until `]`
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
        i += 1;
      } else {
        re += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Re-export the defaults for callers that want them without a second import. */
export { DEFAULT_CONFIG, DEFAULT_IGNORE };
