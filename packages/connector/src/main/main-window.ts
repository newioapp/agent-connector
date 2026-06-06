/**
 * Main window manager — owns the lifecycle of the primary BrowserWindow.
 *
 * Handles creation, bounds persistence, and focus/restore operations.
 */
import { BrowserWindow, nativeTheme, shell } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';
import { join } from 'path';
import { is } from '@electron-toolkit/utils';
import type Store from 'electron-store';
import type { StoreSchema } from './store';

export class MainWindowManager {
  private window: BrowserWindow | null = null;
  private readonly store: Store<StoreSchema>;

  constructor(store: Store<StoreSchema>) {
    this.store = store;
  }

  /** Get the current main window, or null if none exists. */
  getWindow(): BrowserWindow | null {
    return this.window;
  }

  /** Send an IPC event to the renderer. No-op if no window exists. */
  send(channel: string, event: unknown): void {
    this.window?.webContents.send(channel, event);
  }

  /** Focus the main window, restoring it if minimized. */
  focus(): void {
    if (!this.window) {
      return;
    }
    if (this.window.isMinimized()) {
      this.window.restore();
    }
    this.window.focus();
  }

  /** Create and show the main window. */
  async create(): Promise<BrowserWindow> {
    const bounds = this.store.get('windowBounds');

    // macOS only: hide the title bar but keep the inset traffic-light buttons,
    // letting the renderer draw its own drag strip flush to the top. On
    // Linux/Windows this option has no effect, so we keep the native title bar
    // there (and the renderer omits the macOS drag strip — see App.tsx).
    const macTitleBar: Pick<BrowserWindowConstructorOptions, 'titleBarStyle'> =
      process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {};

    this.window = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: 720,
      minHeight: 480,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0A1E3D' : '#05a5c8',
      ...macTitleBar,
      // Hide the default Chromium menu bar on Linux/Windows (toggle with Alt).
      // No effect on macOS, where the menu lives in the system menu bar.
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
      },
    });

    this.window.on('ready-to-show', () => {
      this.window?.show();
    });

    this.window.on('closed', () => {
      this.window = null;
    });

    const saveBounds = (): void => {
      const b = this.window?.getBounds();
      if (!b) {
        return;
      }
      this.store.set('windowBounds', { x: b.x, y: b.y, width: b.width, height: b.height });
    };
    this.window.on('resized', saveBounds);
    this.window.on('moved', saveBounds);

    this.window.webContents.setWindowOpenHandler((details) => {
      void shell.openExternal(details.url);
      return { action: 'deny' };
    });

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await this.window.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
      await this.window.loadFile(join(__dirname, '../renderer/index.html'));
    }

    if (is.dev) {
      this.window.webContents.openDevTools({ mode: 'bottom' });
    }

    return this.window;
  }
}
