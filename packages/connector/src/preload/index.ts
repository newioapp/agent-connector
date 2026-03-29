/**
 * Preload script — exposes the typed IPC API to the renderer via contextBridge.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-api';
import type { ConnectorAPI } from './index.d';

const api: ConnectorAPI = {
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.getVersion),
  getTheme: () => ipcRenderer.invoke(IPC_CHANNELS.getTheme),
  setTheme: (theme) => ipcRenderer.invoke(IPC_CHANNELS.setTheme, theme),
  getNativeThemeDark: () => ipcRenderer.invoke(IPC_CHANNELS.getNativeThemeDark),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
};

contextBridge.exposeInMainWorld('api', api);
