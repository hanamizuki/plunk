import {defineConfig} from 'vitest/config';

/**
 * Lightweight config for pure unit tests that don't need database or other services.
 * Run via: npx vitest --config vitest.unit.config.ts
 *
 * The include pattern is intentionally narrower than vitest.config.ts (root config):
 * only utils/__tests__/ directories are matched, excluding integration/service tests
 * that require database or Redis connections.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/**/utils/__tests__/**/*.test.ts', 'packages/**/utils/__tests__/**/*.test.ts'],
  },
});
