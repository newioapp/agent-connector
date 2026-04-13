/**
 * Auto-update and force-update logic for the Agent Connector.
 *
 * Auto-update: Uses electron-updater with a generic provider (S3 + CloudFront CDN).
 * Force update: Calls the Newio backend version check endpoint to enforce minimum versions.
 */
import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, dialog, shell } from 'electron';
import type Store from 'electron-store';
import type { StoreSchema } from './store';
import type { UpdateMode, UpdateChannel } from '../shared/types';
import { Logger } from '../shared/logger';

const log = new Logger('auto-updater');

// Disable auto-download — we download in background after checking
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FORCE_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let periodicTimer: ReturnType<typeof setInterval> | null = null;

function getWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function getPlatform(): string {
  if (process.platform === 'darwin') {
    return 'macos';
  }
  if (process.platform === 'win32') {
    return 'windows';
  }
  return 'linux';
}

export function initAutoUpdater(store: Store<StoreSchema>): void {
  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info.version);
    void autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-not-available', () => {
    log.info('No update available');
  });

  autoUpdater.on('download-progress', (progress) => {
    log.info(`Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info.version);
    const win = getWindow();
    if (!win) {
      return;
    }
    void dialog
      .showMessageBox(win, {
        type: 'info',
        title: 'Update Ready',
        message: `Newio Agent Connector ${info.version} is ready to install.`,
        detail: 'The update will be applied when you restart the app.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on('error', (err) => {
    log.info('Update error:', err.message);
  });

  applyUpdateChannel(store.get('updateChannel'));
  applyUpdateMode(store.get('updateMode'));
}

/**
 * Apply the update mode — starts or stops periodic checks.
 */
export function applyUpdateMode(mode: UpdateMode): void {
  if (periodicTimer !== null) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }

  if (mode === 'disabled') {
    log.info('Auto-update disabled');
    return;
  }

  autoUpdater.checkForUpdates().catch((err: unknown) => {
    log.info('Initial update check failed:', err instanceof Error ? err.message : String(err));
  });

  if (mode === 'auto') {
    periodicTimer = setInterval(() => {
      autoUpdater.checkForUpdates().catch((err: unknown) => {
        log.info('Periodic update check failed:', err instanceof Error ? err.message : String(err));
      });
    }, UPDATE_CHECK_INTERVAL_MS);
  }
}

/**
 * Apply the update channel — sets the electron-updater channel.
 * allowDowngrade is always enabled so users can switch from beta
 * back to stable even when the stable version is numerically lower.
 */
export function applyUpdateChannel(channel: UpdateChannel): void {
  log.info(`Setting update channel: ${channel}`);
  autoUpdater.channel = channel;
  autoUpdater.allowDowngrade = true;
}

// ---------------------------------------------------------------------------
// Force update check — calls backend version check endpoint
// ---------------------------------------------------------------------------

interface VersionCheckResponse {
  readonly forceUpdate: boolean;
  readonly latestVersion: string;
  readonly updateUrl: string;
}

export function initForceUpdateCheck(apiBaseUrl: string): void {
  const check = async (): Promise<void> => {
    try {
      const version = app.getVersion();
      const platform = getPlatform();
      const url = `${apiBaseUrl}/version/check?currentVersion=${encodeURIComponent(version)}&software=connector&platform=${platform}`;
      const res = await fetch(url);
      if (!res.ok) {
        log.warn('Force update check returned non-OK status:', res.status);
        return;
      }
      const result = (await res.json()) as VersionCheckResponse;
      if (!result.forceUpdate) {
        return;
      }
      const win = getWindow();
      if (!win) {
        return;
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Update Required',
        message: 'This version of Newio Agent Connector is no longer supported.',
        detail: `Please update to version ${result.latestVersion} or later to continue.`,
        buttons: ['Download Update', 'Quit'],
        defaultId: 0,
        noLink: true,
      });
      if (response === 0) {
        await shell.openExternal(result.updateUrl);
      }
      app.quit();
    } catch (err) {
      log.info('Force update check failed:', err instanceof Error ? err.message : String(err));
    }
  };

  void check();
  setInterval(() => void check(), FORCE_UPDATE_CHECK_INTERVAL_MS);
}

/**
 * Manually trigger an update check. Shows a native dialog with the result.
 */
export function manualCheckForUpdates(): void {
  void autoUpdater
    .checkForUpdates()
    .then((result) => {
      const currentVersion = app.getVersion();
      if (!result?.updateInfo || result.updateInfo.version === currentVersion) {
        const win = getWindow();
        if (win) {
          void dialog.showMessageBox(win, {
            type: 'info',
            title: 'No Updates',
            message: "You're up to date!",
            detail: `Newio Agent Connector ${currentVersion} is the latest version.`,
            buttons: ['OK'],
          });
        }
      }
    })
    .catch((err: unknown) => {
      log.info('Manual update check failed:', err instanceof Error ? err.message : String(err));
      const win = getWindow();
      if (win) {
        void dialog.showMessageBox(win, {
          type: 'error',
          title: 'Update Check Failed',
          message: 'Could not check for updates.',
          detail: err instanceof Error ? err.message : String(err),
          buttons: ['OK'],
        });
      }
    });
}
