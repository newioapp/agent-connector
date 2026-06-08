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
  // third-party deps (commander, ws, zod, yaml, dotenv, ACP/MCP SDKs) stay
  // external and are declared in this package's `dependencies` so npm installs
  // them. The daemon is reached via `newio daemon run` and is code-split out of
  // the client path via a dynamic import in cli/index.ts.
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    sourcemap: true,
    splitting: true,
    noExternal: [/^@newio\//],
  },
]);
