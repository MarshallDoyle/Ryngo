import { defineConfig, mergeConfig } from 'vitest/config';
import shared from './vitest.shared';

/**
 * Root Vitest config. When invoked from the repo root with no filter, this
 * config picks up tests from every package via the include glob. Each
 * package also has its own `vitest.config.ts` that extends `vitest.shared.ts`
 * so that `pnpm --filter <pkg> test` runs only that package's suite with
 * package-specific coverage thresholds.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      name: 'codegraph',
      include: [
        'packages/*/src/**/*.{test,spec}.ts',
        'packages/*/src/**/__tests__/**/*.ts',
        'adapters/*/src/**/*.{test,spec}.ts',
        'adapters/*/src/**/__tests__/**/*.ts',
      ],
      coverage: {
        ...shared.test?.coverage,
        include: [
          'packages/*/src/**/*.{ts,tsx}',
          'adapters/*/src/**/*.{ts,tsx}',
        ],
      },
    },
  }),
);
