import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  define: {
    __NEWIO_STAGE__: JSON.stringify('dev'),
    __API_BASE_URL__: JSON.stringify('https://api.newio.app'),
    __WS_BASE_URL__: JSON.stringify('wss://ws.newio.app'),
    __APP_DISPLAY_NAME__: JSON.stringify('Agent Connector'),
    __APP_VERSION__: JSON.stringify('0.0.0'),
  },
  resolve: {
    alias: {
      '@newio/core': resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
