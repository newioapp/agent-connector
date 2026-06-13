import { defineConfig, configDefaults } from 'vitest/config';

// Default config (used by `pnpm test` / `test:coverage`). It EXCLUDES the live
// e2e specs so a normal test run never imports them — those specs import
// workspace packages through their built `dist/` exports, which may not exist on
// a clean checkout. The e2e specs run via vitest.e2e.config.ts (`test:e2e`),
// which builds those prerequisites first.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.e2e.test.ts'],
  },
});
