import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 95,
        statements: 90,
      },
      exclude: [
        // Build config — not source code.
        'tsup.config.ts',
        'vitest.config.ts',
        'dist/**',
        // Pure type definitions — no runtime code.
        'src/core/types.ts',
        'src/core/events.ts',
        'src/app/types.ts',
        // Barrel re-exports — no logic.
        'src/index.ts',
        'src/app/index.ts',
        // media.ts does presigned URL upload/download + filesystem I/O — requires real S3 + fs.
        'src/app/media.ts',
      ],
    },
  },
});
