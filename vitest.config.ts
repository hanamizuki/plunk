import {defineConfig} from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '.next/',
        '**/*.config.ts',
        '**/*.config.js',
        'test/',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each fork is a worker with an isolated Postgres database and Redis db-number
    // (see test/setup.ts). That isolation is what lets us run files in parallel
    // without the cross-test interference we used to hit with a shared DB.
    pool: 'forks',
    poolOptions: {
      forks: {
        // Cap at 4 to stay within Postgres' default max_connections=100
        // when each worker uses connection_limit=20.
        maxForks: 4,
        minForks: 1,
      },
    },
    maxConcurrency: 5,
    // Only include our test files, not dependency tests
    include: [
      'apps/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'packages/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'test/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: ['node_modules/**', '**/node_modules/**', 'dist/**', '.next/**', '.turbo/**'],
  },
  resolve: {
    alias: {
      '@plunk/db': path.resolve(__dirname, './packages/db/src'),
      '@plunk/shared': path.resolve(__dirname, './packages/shared/src'),
      '@plunk/types': path.resolve(__dirname, './packages/types/src'),
      '@plunk/email': path.resolve(__dirname, './packages/email/src'),
    },
  },
});
