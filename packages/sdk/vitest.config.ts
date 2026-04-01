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
      exclude: [
        // newio-app.ts has integration-heavy code (auth flows, WebSocket connect,
        // backfill) that requires real network calls. Unit-testable portions are
        // covered via createFromComponents() tests.
        'src/newio-app.ts',
      ],
    },
  },
});
