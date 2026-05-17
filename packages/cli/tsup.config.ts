import { defineConfig } from 'tsup';

export default defineConfig([
  // Library export (DaemonClient for Electron app)
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  // Daemon binary
  {
    entry: { daemon: 'src/daemon/index.ts' },
    format: ['esm'],
    sourcemap: true,
  },
  // CLI binary
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    sourcemap: true,
  },
]);
