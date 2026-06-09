import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';
import type { Options } from 'tsup';

type EsbuildPlugin = NonNullable<Options['esbuildPlugins']>[number];

// esbuild parses every bundled file in strict mode (the root tsconfig sets
// `strict: true`, which implies `alwaysStrict`), and strict mode forbids legacy
// octal escape sequences. `qrcode-terminal` (used for the agent-approval QR) is
// an old CommonJS dep whose source still writes ANSI codes as `\033[40m`, so it
// fails to bundle into the SEA. The npm build never hits this because it keeps
// deps external; the SEA inlines everything. Rewrite the offending escapes to
// their hex form (`\x1b`) on load — scoped to this one dependency.
const fixLegacyOctalPlugin: EsbuildPlugin = {
  name: 'fix-legacy-octal',
  setup(build) {
    build.onLoad({ filter: /qrcode-terminal[\\/].*\.js$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8');
      // \033 (octal ESC) -> \x1b (hex ESC): same byte, strict-mode-legal.
      const contents = source.replace(/\\033/g, '\\x1b');
      return { contents, loader: 'js' };
    });
  },
};

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
  esbuildPlugins: [fixLegacyOctalPlugin],
});
