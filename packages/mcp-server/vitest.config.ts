import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
      exclude: ['src/index.ts', 'src/bridge.ts', 'src/uds.ts', '*.config.ts', 'dist/**'],
    },
  },
});
