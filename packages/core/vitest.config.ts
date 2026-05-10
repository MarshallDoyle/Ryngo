import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared';

/**
 * `@codegraph/core` is the load-bearing logic — IR, schema, diff. Per
 * design/test-strategy.md §5, this package has the only enforced coverage
 * floor in the repo: 80% line, 75% branch. CI fails if the gate is missed
 * here; other packages report coverage but don't block.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      name: '@codegraph/core',
      root: __dirname,
      coverage: {
        ...shared.test?.coverage,
        include: ['src/**/*.ts'],
        exclude: [
          ...(shared.test?.coverage && 'exclude' in shared.test.coverage
            ? (shared.test.coverage.exclude as string[])
            : []),
          'src/sample/**',
        ],
        thresholds: {
          lines: 80,
          branches: 75,
          functions: 80,
          statements: 80,
        },
      },
    },
  }),
);
