/**
 * Default `.codegraph.yml` values.
 *
 * Represents the "no config" experience: running codegraph against a
 * typical TypeScript monorepo with no `.codegraph.yml` file should produce
 * a useful graph using exactly these values. User configs are deep-merged
 * onto this object per the rules in `spec/config-schema.md` §4.
 */

import {
  CONFIG_SCHEMA_VERSION,
  type CodegraphConfig,
  type Severity,
} from './types.js';

/**
 * Built-in `ignore` patterns. Merged with the user's `ignore` list at load
 * time. Users opt out of any default with a leading `!` un-ignore in their
 * own list (resolution happens in the matcher, not here).
 */
export const DEFAULT_IGNORE: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/target/**',
  '**/__pycache__/**',
  '**/*.min.js',
  '**/*.lock',
];

/**
 * Conservative default severity policy. Removals warn, additions are info,
 * and any new boundary violation is a hard error — matching the rationale
 * in `spec/config-schema.md` §3.10.
 */
export const DEFAULT_DIFF_RULES: Record<string, Severity> = {
  nodeAdded: 'info',
  nodeRemoved: 'warning',
  nodeRetyped: 'warning',
  edgeAdded: 'info',
  edgeRemoved: 'warning',
  boundaryViolationAdded: 'error',
  boundaryViolationRemoved: 'info',
  entryPointAdded: 'info',
  entryPointRemoved: 'warning',
};

/**
 * The full default config. `boundaries`, `groups`, and `entryPoints.*` are
 * intentionally empty so a zero-config run produces a single implicit
 * `_unassigned` boundary and relies entirely on adapter auto-detection.
 */
export const DEFAULT_CONFIG: CodegraphConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  project: {},
  root: '.',
  boundaries: {},
  ignore: [...DEFAULT_IGNORE],
  adapters: {},
  groups: [],
  entryPoints: {
    include: [],
    exclude: [],
  },
  output: {
    ir: {
      path: '.codegraph/ir.json',
      pretty: false,
      splitChunks: false,
    },
    viewer: {
      publish: {
        kind: 'static',
        dir: '.codegraph/viewer',
        baseUrl: '/',
      },
    },
    cache: {
      path: '.codegraph/cache',
      enabled: true,
    },
  },
  diff: {
    fail: ['error'],
    rules: { ...DEFAULT_DIFF_RULES },
    ignore: [],
  },
};
