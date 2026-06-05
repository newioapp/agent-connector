import { defineConfig } from 'tsup';

export default defineConfig([
  // Library export (DaemonConnector for the Electron app)
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  // Single `newio` binary. The daemon is reached via `newio daemon run` and is
  // code-split out of the client path via a dynamic import in cli/index.ts.
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    sourcemap: true,
    splitting: true,
  },
]);
