import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { createStore } from './store';
import { MainWindowManager } from './main-window';
import { AgentConfigManager } from './agent-config-manager';
import { AgentRuntimeManager } from './agent-runtime-manager';
import { IpcHandler } from './ipc-handler';
import { registerIpcHandlers } from './ipc-registry';
import { EVENT_CHANNELS } from '../shared/ipc-events';

void app.whenReady().then(async () => {
  electronApp.setAppUserModelId('dev.newio.connector');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  const store = createStore();
  const mainWindowManager = new MainWindowManager(store);
  const agentConfigManager = new AgentConfigManager(store);

  const agentRuntimeManager = new AgentRuntimeManager(store, agentConfigManager, {
    onStatusChanged(agentId, status, error) {
      mainWindowManager.send(EVENT_CHANNELS['agent-status-changed'], { agentId, status, error });
    },
    onApprovalUrl(agentId, approvalUrl) {
      mainWindowManager.send(EVENT_CHANNELS['agent-approval-url'], { agentId, approvalUrl });
      void shell.openExternal(approvalUrl);
    },
    onConfigUpdated(agentId) {
      const config = agentConfigManager.get(agentId);
      if (config) {
        mainWindowManager.send(EVENT_CHANNELS['agent-config-updated'], { agentId, config });
      }
    },
  });

  // Apply persisted theme
  nativeTheme.themeSource = store.get('themeSource');

  // Register IPC handlers
  const ipcHandler = new IpcHandler({ store, agentConfigManager, agentRuntimeManager });
  registerIpcHandlers(ipcHandler);

  await mainWindowManager.create();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void mainWindowManager.create();
    }
  });

  app.on('before-quit', () => {
    void agentRuntimeManager.stopAll();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
