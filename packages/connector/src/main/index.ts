import { app, BrowserWindow, Menu, nativeTheme } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { setLogHandler } from '@newio/agent-sdk';
import { createStore } from './store';
import { MainWindowManager } from './main-window';
import { DaemonConnection } from './daemon-connection';
import { IpcHandler } from './ipc-handler';
import { registerIpcHandlers } from './ipc-registry';
import { initAutoUpdater, initForceUpdateCheck } from './auto-updater';
import { blockChromiumShortcuts } from './keyboard-shortcuts';
import { setLogLevel, Logger, initElectronLog } from '../shared/logger';

// Set log level from build-time config (default: info)
setLogLevel(__LOG_LEVEL__);

// Configure electron-log file transport (must be called before any Logger usage)
initElectronLog();

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

// Set app name before app.whenReady() so macOS menu bar shows the correct name.
// On X11 this also becomes the window's WM_CLASS, which the desktop environment
// matches against the .desktop file's StartupWMClass to pick the dock icon — the
// Linux build sets StartupWMClass to this same value (see scripts/build-linux.sh).
app.name = __APP_DISPLAY_NAME__;

// Enforce a single running instance: a second launch focuses the existing window
// instead of spawning another process. Set once the window manager exists.
let activeWindowManager: MainWindowManager | undefined;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    activeWindowManager?.focus();
  });
}

void app.whenReady().then(async () => {
  // A primary instance already owns the lock; this duplicate is quitting.
  if (!hasSingleInstanceLock) {
    return;
  }
  // Windows AppUserModelID — controls taskbar grouping and toast-notification
  // attribution. Must match `appId` in electron-builder.yml. No-op on macOS/Linux.
  electronApp.setAppUserModelId('app.newio.connector');

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
    blockChromiumShortcuts(window);
  });

  const store = createStore();
  const mainWindowManager = new MainWindowManager(store);
  activeWindowManager = mainWindowManager;

  // The desktop is a thin client of the per-stage daemon — it owns no agent
  // runtime or config of its own; everything goes over the socket.
  const connection = new DaemonConnection(__NEWIO_STAGE__, mainWindowManager);

  // Apply persisted theme
  nativeTheme.themeSource = store.get('themeSource');

  // Register IPC handlers
  const ipcHandler = new IpcHandler({ store, connection });
  registerIpcHandlers(ipcHandler);

  // Auto-update and force-update
  initAutoUpdater(store);
  initForceUpdateCheck(__API_BASE_URL__);

  await mainWindowManager.create();

  // Attach to the daemon after the window exists so connection-state events land.
  void connection.connect();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void mainWindowManager.create();
    }
  });

  // The daemon owns the agent runtime and its lifecycle; the desktop just drops
  // its socket on quit.
  app.on('before-quit', () => {
    log.info('before-quit: disconnecting from daemon');
    connection.disconnect();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
