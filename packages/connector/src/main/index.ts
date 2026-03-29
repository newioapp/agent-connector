import { app, BrowserWindow, nativeTheme } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { createStore } from './store';
import { MainWindowManager } from './main-window';
import { IpcHandler } from './ipc-handler';
import { registerIpcHandlers } from './ipc-registry';

void app.whenReady().then(async () => {
  electronApp.setAppUserModelId('dev.newio.connector');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  const store = createStore();
  const mainWindowManager = new MainWindowManager(store);

  // Apply persisted theme
  nativeTheme.themeSource = store.get('themeSource');

  // Register IPC handlers
  const ipcHandler = new IpcHandler({ store });
  registerIpcHandlers(ipcHandler);

  await mainWindowManager.create();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void mainWindowManager.create();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
