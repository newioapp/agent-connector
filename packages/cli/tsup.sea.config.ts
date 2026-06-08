import { defineConfig } from 'tsup';

// SEA bundle — one self-contained CommonJS file for Node's Single Executable
// Application (`node --experimental-sea-config`). Unlike the npm build, this:
//   - emits CJS (SEA's injected main must be CommonJS),
//   - inlines EVERYTHING (`noExternal`), since a SEA has no node_modules at
//     runtime — third-party deps (commander, ws, zod, yaml, dotenv, ACP/MCP
//     SDKs) and the internal @newio/* packages are all bundled in,
//   - disables code splitting (a SEA loads a single script).
// Node built-ins stay external automatically.
export default defineConfig({
  entry: { 'newio-sea': 'src/cli/index.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  outDir: 'build/sea',
  noExternal: [/.*/],
});
