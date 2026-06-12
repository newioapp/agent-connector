import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Live-backend e2e: generous timeouts, run serially.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
