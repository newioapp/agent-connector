import { defineConfig } from 'tsup';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const version: string = (require('./package.json') as { version: string }).version;

const stage = process.env.NEWIO_STAGE ?? 'prod';
const apiBaseUrl = process.env.API_BASE_URL ?? 'https://api.newio.app';
const wsBaseUrl = process.env.WS_BASE_URL ?? 'wss://ws.newio.app';
const appDisplayName = process.env.APP_DISPLAY_NAME ?? 'Agent Connector';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  define: {
    __NEWIO_STAGE__: JSON.stringify(stage),
    __API_BASE_URL__: JSON.stringify(apiBaseUrl),
    __WS_BASE_URL__: JSON.stringify(wsBaseUrl),
    __APP_DISPLAY_NAME__: JSON.stringify(appDisplayName),
    __APP_VERSION__: JSON.stringify(version),
  },
});
