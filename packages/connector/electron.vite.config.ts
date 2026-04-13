import { resolve } from 'path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// electron-vite's isolatedEntries calls process.stdout.clearLine which doesn't
// exist in non-TTY environments (CI, piped output). Polyfill to avoid crashes.
if (!process.stdout.clearLine) {
  process.stdout.clearLine = (): boolean => true;
  process.stdout.cursorTo = (): boolean => true;
  process.stdout.moveCursor = (): boolean => true;
}

// Build-time environment config — injected as compile-time constants.
// CI sets these via env vars; local dev falls back to prod defaults.
const apiBaseUrl = process.env.API_BASE_URL ?? 'https://api.newio.app';
const wsBaseUrl = process.env.WS_BASE_URL ?? 'wss://ws.newio.app';
const appDisplayName = process.env.APP_DISPLAY_NAME ?? 'Newio Agent Connector';

const enableDevTools = process.env.ENABLE_DEV_TOOLS;
if (enableDevTools === undefined) {
  throw new Error('ENABLE_DEV_TOOLS environment variable is required');
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: [
          '@anthropic-ai/claude-agent-sdk',
          '@newio/mcp-server',
          'better-sqlite3',
          'electron-store',
          'electron-updater',
        ],
      },
    },
    define: {
      __API_BASE_URL__: JSON.stringify(apiBaseUrl),
      __WS_BASE_URL__: JSON.stringify(wsBaseUrl),
      __APP_DISPLAY_NAME__: JSON.stringify(appDisplayName),
      __ENABLE_DEV_TOOLS__: JSON.stringify(enableDevTools === 'true'),
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
        },
      },
      isolatedEntries: true,
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
