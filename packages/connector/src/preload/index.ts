import { contextBridge } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

const api = {
  // Agent lifecycle IPC will be added here
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error -- fallback for non-isolated context
  window.electron = electronAPI;
  // @ts-expect-error -- fallback for non-isolated context
  window.api = api;
}
