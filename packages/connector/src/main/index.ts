import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron';
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

// Set app name before app.whenReady() so macOS menu bar shows the correct name
app.name = __APP_DISPLAY_NAME__;

void app.whenReady().then(async () => {
  electronApp.setAppUserModelId('dev.newio.connector');

  // Hide "Toggle Developer Tools" from the View menu in production builds
  if (!__ENABLE_DEV_TOOLS__) {
    const menu = Menu.getApplicationMenu();
    const viewMenu = menu?.items.find((item) => item.label === 'View');
    const devToolsItem = viewMenu?.submenu?.items.find((item) => item.role === 'toggleDevTools');
    if (devToolsItem) {
      devToolsItem.visible = false;
    }
  }

  app.on('browser-window-created', (_, window) => {
    if (__ENABLE_DEV_TOOLS__) {
      optimizer.watchWindowShortcuts(window);
    }
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
    onAgentSessionConfigUpdated(agentId, sessionId, models, modes) {
      mainWindowManager.send(EVENT_CHANNELS['agent-session-config-updated'], { agentId, sessionId, models, modes });
    },
  });

  // Apply persisted theme
  nativeTheme.themeSource = store.get('themeSource');

  // Register IPC handlers
  const ipcHandler = new IpcHandler({ store, agentConfigManager, agentRuntimeManager });
  registerIpcHandlers(ipcHandler);

  // Auto-update and force-update
  initAutoUpdater(store);
  initForceUpdateCheck(__API_BASE_URL__);

  await mainWindowManager.create();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void mainWindowManager.create();
    }
  });

  let cleanedUp = false;
  const cleanup = (): Promise<void> =>
    agentRuntimeManager
      .stopAll()
      .catch(() => {})
      .then(() => sessionStore.close());

  app.on('before-quit', (event) => {
    if (!cleanedUp) {
      event.preventDefault();
      void cleanup().finally(() => {
        cleanedUp = true;
        app.quit();
      });
    }
  });

  // Handle SIGINT/SIGTERM (e.g. Ctrl+C in dev mode) — Electron doesn't exit on these by default,
  // and child processes keep the event loop alive via stdio pipes.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (cleanedUp) {
        app.exit(0);
        return;
      }
      cleanedUp = true;
      void cleanup().finally(() => app.exit(0));
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
