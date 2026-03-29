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

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['@anthropic-ai/claude-agent-sdk'],
      },
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
