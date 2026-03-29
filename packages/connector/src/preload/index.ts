import { contextBridge } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

const api = {
  // Agent lifecycle IPC will be added here
};

contextBridge.exposeInMainWorld('electron', electronAPI);
contextBridge.exposeInMainWorld('api', api);
