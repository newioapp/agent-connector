import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/mcp/bridge.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Inject an `import.meta.url` shim in the CJS output so createRequire-based
  // resolution (claude-acp.ts) works when the connector main (CJS) loads this
  // package via the "require" condition.
  shims: true,
  // Bundle the MCP SDK (and its small runtime deps like zod-to-json-schema)
  // directly into our dist. electron-builder's pnpm dependency collector does
  // not gather transitive deps reached through a `link:` workspace package, so
  // a packaged connector that left @modelcontextprotocol/sdk external crashed at
  // launch with "Cannot find module 'zod-to-json-schema'". We only import
  // server/mcp.js + server/stdio.js (not the streamableHttp transport), so the
  // bundled subgraph stays small and pulls in no express/hono.
  noExternal: ['@modelcontextprotocol/sdk'],
});
