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
  // Bundle everything (a SEA has no node_modules) EXCEPT sharp/blurhash/@img.
  // `noExternal` overrides `external` in tsup, so the deny-list lives in the
  // noExternal regex itself (negative lookahead) rather than in `external`.
  noExternal: [/^(?!sharp$|blurhash$|@img\/).+/],
  // sharp is a native (.node) module — it can't live inside a SEA. Keeping it
  // (and its @img/* platform bindings) external means we don't ship dead, broken
  // sharp JS in the binary. At runtime the `import('sharp')` rejects and
  // agent-engine falls back to null: image blurhash/dimensions are disabled in
  // SEA builds, but media uploads still work. blurhash needs sharp's decoded
  // pixels, so it's out too.
  external: ['sharp', 'blurhash', /^@img\//],
});
