import {defineConfig} from 'vitest/config';

/**
 * Lightweight config for pure unit tests that don't need database or other services.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/**/utils/__tests__/**/*.test.ts', 'packages/**/utils/__tests__/**/*.test.ts'],
  },
});
