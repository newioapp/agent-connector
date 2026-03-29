/**
 * IPC contract between the main process and renderer process.
 *
 * Defines typed interfaces for all request/response IPC channels
 * (ipcMain.handle / ipcRenderer.invoke). Push events from main → renderer
 * will be defined separately when needed.
 */
import type { ThemeSource } from './types';

export interface IpcApi {
  /** Get the app version. */
  getVersion(): Promise<string>;

  // Theme
  getTheme(): Promise<ThemeSource>;
  setTheme(theme: ThemeSource): Promise<void>;
  getNativeThemeDark(): Promise<boolean>;

  // External URLs
  openExternal(url: string): Promise<void>;
}

/** Channel name for each IpcApi method. */
export const IPC_CHANNELS: { readonly [K in keyof IpcApi]: string } = {
  getVersion: 'get-version',
  getTheme: 'get-theme',
  setTheme: 'set-theme',
  getNativeThemeDark: 'get-native-theme-dark',
  openExternal: 'open-external',
};
