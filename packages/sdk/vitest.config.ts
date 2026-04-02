import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 80,
        branches: 78,
        functions: 80,
        statements: 80,
      },
      exclude: [
        // newio-app.ts has integration-heavy code (auth flows, WebSocket connect,
        // backfill) that requires real network calls. Unit-testable portions are
        // covered via createFromComponents() tests.
        'src/app/newio-app.ts',
        // events.ts wires WebSocket events to store updates — requires live
        // WebSocket + store integration. Core logic tested via newio-app tests.
        'src/app/events.ts',
        // media.ts does presigned URL upload/download — requires real S3.
        'src/app/media.ts',
        // logger.ts is trivial glue (global handler dispatch + console wrapper).
        'src/core/logger.ts',
      ],
    },
  },
});
