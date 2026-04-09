import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { join } from 'path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { setLogHandler } from '@newio/sdk';
import { createStore } from './store';
import { MainWindowManager } from './main-window';
import { StoreAgentConfigManager } from './agent-config-manager';
import { AgentRuntimeManager } from '../core/agent-runtime-manager';
import { SessionStore } from '../core/session-store';
import { IpcHandler } from './ipc-handler';
import { registerIpcHandlers } from './ipc-registry';
import { EVENT_CHANNELS } from '../shared/ipc-events';
import { initAutoUpdater, initForceUpdateCheck } from './auto-updater';

// Route SDK logs through the connector's log format at debug level
setLogHandler((level, name, message, args) => {
  const timestamp = new Date().toISOString();
  const prefix = `${timestamp} [${level.toUpperCase()}] [sdk:${name}]`;
  console[level](prefix, message, ...args);
});

void app.whenReady().then(async () => {
  electronApp.setAppUserModelId('dev.newio.connector');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  const store = createStore();
  const mainWindowManager = new MainWindowManager(store);
  const agentConfigManager = new StoreAgentConfigManager(store);
  const sessionStore = new SessionStore(join(app.getPath('userData'), 'sessions.db'));

  const agentRuntimeManager = new AgentRuntimeManager(agentConfigManager, sessionStore, {
    onStatusChanged(agentId, status, error) {
      mainWindowManager.send(EVENT_CHANNELS['agent-status-changed'], { agentId, status, error });
    },
    onApprovalUrl(agentId, approvalUrl) {
      mainWindowManager.send(EVENT_CHANNELS['agent-approval-url'], { agentId, approvalUrl });
      void shell.openExternal(approvalUrl);
    },
    onPollAttempt(agentId) {
      mainWindowManager.send(EVENT_CHANNELS['agent-poll-attempt'], { agentId });
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

  // Auto-update and force-update
  initAutoUpdater(store);
  initForceUpdateCheck('https://api.conduit.qinnan.dev');

  await mainWindowManager.create();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void mainWindowManager.create();
    }
  });

  app.on('before-quit', () => {
    void agentRuntimeManager.stopAll().then(() => {
      sessionStore.close();
    });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
