import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron';
import { join } from 'path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { setLogHandler } from '@newio/agent-sdk';
import { createStore } from './store';
import { MainWindowManager } from './main-window';
import { FileAgentConfigManager, NEWIO_DIR, ensureNewioDir } from '../core/file-agent-config-manager';
import { AgentRuntimeManager } from '../core/agent-runtime-manager';
import { SessionStore } from '../core/session-store';
import { IpcHandler } from './ipc-handler';
import { registerIpcHandlers } from './ipc-registry';
import { EVENT_CHANNELS } from '../shared/ipc-events';
import { initAutoUpdater, initForceUpdateCheck } from './auto-updater';
import { setLogLevel, Logger } from '../shared/logger';

// Set log level from build-time config (default: info)
setLogLevel(__LOG_LEVEL__);

// Route SDK logs through the connector's Logger (respects global log level)
const sdkLoggers = new Map<string, Logger>();
const log = new Logger('app');
setLogHandler((level, name, message, args) => {
  let logger = sdkLoggers.get(name);
  if (!logger) {
    logger = new Logger(`sdk:${name}`);
    sdkLoggers.set(name, logger);
  }
  logger[level](message, ...args);
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
  const agentConfigManager = new FileAgentConfigManager();
  ensureNewioDir();
  const sessionStore = new SessionStore(join(NEWIO_DIR, 'sessions.db'));

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
    onAgentInfo(agentId, info) {
      mainWindowManager.send(EVENT_CHANNELS['agent-acp-info'], { agentId, info });
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
      log.info('before-quit: starting cleanup');
      event.preventDefault();
      void cleanup().finally(() => {
        log.info('before-quit: cleanup complete, quitting');
        cleanedUp = true;
        app.quit();
      });
    }
  });

  // Handle SIGINT/SIGTERM (e.g. Ctrl+C in dev mode) — Electron doesn't exit on these by default,
  // and child processes keep the event loop alive via stdio pipes.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info(`Received ${signal}`);
      if (cleanedUp) {
        log.info(`${signal}: already cleaned up, exiting`);
        app.exit(0);
        return;
      }
      cleanedUp = true;
      void cleanup().finally(() => {
        log.info(`${signal}: cleanup complete, exiting`);
        app.exit(0);
      });
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
