import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      exclude: ['tsup.config.ts', 'vitest.config.ts', 'dist/**', 'src/index.ts', 'src/bin.ts'],
    },
  },
});
