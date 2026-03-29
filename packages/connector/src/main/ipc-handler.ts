/**
 * Main process IPC handler implementations.
 *
 * Each method corresponds to an IpcApi interface method.
 * Registered with ipcMain.handle via registerIpcHandlers().
 */
/* eslint-disable @typescript-eslint/require-await -- IpcApi interface requires Promise returns */
import { app, shell, nativeTheme } from 'electron';
import type Store from 'electron-store';
import type { IpcApi } from '../shared/ipc-api';
import type { ThemeSource } from '../shared/types';
import type { StoreSchema } from './store';

interface IpcHandlerDeps {
  readonly store: Store<StoreSchema>;
}

export class IpcHandler implements IpcApi {
  private readonly store: Store<StoreSchema>;

  constructor(deps: IpcHandlerDeps) {
    this.store = deps.store;
  }

  async getVersion(): Promise<string> {
    return app.getVersion();
  }

  async getTheme(): Promise<ThemeSource> {
    return this.store.get('themeSource');
  }

  async setTheme(theme: ThemeSource): Promise<void> {
    nativeTheme.themeSource = theme;
    this.store.set('themeSource', theme);
  }

  async getNativeThemeDark(): Promise<boolean> {
    return nativeTheme.shouldUseDarkColors;
  }

  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url);
  }
}
