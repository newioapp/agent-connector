import { contextBridge, ipcRenderer } from 'electron';

/**
 * Typed IPC API exposed to the renderer via contextBridge.
 * Agent lifecycle IPC channels will be added in C2/C3.
 */
const api = {
  /** Get the app version. */
  getVersion: (): Promise<string> => ipcRenderer.invoke('get-version'),
};

export type ConnectorAPI = typeof api;

contextBridge.exposeInMainWorld('api', api);
