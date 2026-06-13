import { defineConfig } from 'vitest/config';

// Hermetic CLI integ config (used by `test:cli`, which builds the cli first).
// Collects only *.cli.test.ts — these drive the real `newio` CLI against a
// sandboxed daemon with NO backend, so they are deterministic and CI-runnable.
export default defineConfig({
  test: {
    include: ['**/*.cli.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
