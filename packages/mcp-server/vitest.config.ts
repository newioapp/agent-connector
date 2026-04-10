import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 100,
        statements: 95,
      },
      exclude: ['src/index.ts', 'src/bridge.ts', 'src/uds.ts', '*.config.ts', 'dist/**'],
    },
  },
});
