import { defineConfig } from 'tsup';

export default defineConfig([
  // Library export (DaemonConnector for the Electron app). Only consumed
  // in-workspace by @newio/connector, which depends on @newio/agent-engine
  // itself — so keep the internal packages external here to avoid shipping a
  // second, duplicate copy of the engine into the Electron bundle.
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: [/^@newio\//],
  },
  // Single `newio` binary, published to npm. The internal @newio/* packages are
  // not published, so bundle them in to make the binary self-contained. Their
  // third-party deps (commander, ws, zod, yaml, dotenv, ACP/MCP SDKs, blurhash)
  // stay external and are declared in this package's `dependencies` so npm
  // installs them. The daemon is reached via `newio daemon run` and is code-
  // split out of the client path via a dynamic import in cli/index.ts.
  //
  // sharp + its @img/* native bindings are explicitly external so `npm i -g`
  // resolves them from node_modules (the matching @img/* prebuild) rather than
  // bundling broken native JS into dist. tsup auto-externalizes `dependencies`
  // but NOT `optionalDependencies`, where sharp lives — hence the explicit list.
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    sourcemap: true,
    splitting: true,
    noExternal: [/^@newio\//],
    external: ['sharp', /^@img\//],
  },
]);
