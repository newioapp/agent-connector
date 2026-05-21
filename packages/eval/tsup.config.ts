import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    dts: false,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: ['src/interactive/cli.ts'],
    format: ['esm'],
    dts: false,
    sourcemap: true,
    outDir: 'dist/interactive',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
