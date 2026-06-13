import { defineConfig } from 'vitest/config';

// Live-backend e2e config (used by `test:e2e`, which builds the workspace deps
// first). Collects ONLY the *.e2e.test.ts specs, with generous timeouts and
// serial execution since each spins up a real connector against the dev backend.
export default defineConfig({
  test: {
    include: ['**/*.e2e.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
