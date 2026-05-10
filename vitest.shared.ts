import { defineConfig } from 'vitest/config';

const PROPERTY_SEED = process.env['FC_SEED'];
const FAST_CHECK_NUM_RUNS = process.env['FC_NUM_RUNS'] ?? (process.env['CI'] ? '100' : '50');

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'src/**/*.{test,spec}.ts',
      'src/**/__tests__/**/*.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/test-fixtures/**',
      '**/__fixtures__/**',
    ],

    reporters: process.env['CI'] ? ['default', 'junit'] : ['default'],
    outputFile: process.env['CI']
      ? { junit: './coverage/junit.xml' }
      : undefined,

    bail: process.env['CI'] ? 0 : 1,

    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        useAtomics: true,
      },
    },

    testTimeout: 10_000,
    hookTimeout: 10_000,

    sequence: {
      shuffle: false,
      concurrent: false,
    },

    env: {
      ...(PROPERTY_SEED ? { FC_SEED: PROPERTY_SEED } : {}),
      FC_NUM_RUNS: FAST_CHECK_NUM_RUNS,
      TZ: 'UTC',
      NO_COLOR: process.env['NO_COLOR'] ?? '1',
    },

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/**/__tests__/**',
        'src/**/__fixtures__/**',
        'src/**/generated/**',
        'src/sample/**',
      ],
      all: true,
      clean: true,
    },
  },
});
