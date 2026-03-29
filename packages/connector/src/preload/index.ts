/**
 * Preload script — exposes the typed IPC API to the renderer via contextBridge.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-api';
import { EVENT_CHANNELS } from '../shared/ipc-events';
import type { MainToRendererEvents } from '../shared/ipc-events';
import type { ConnectorAPI } from './index.d';

function onEvent<K extends keyof MainToRendererEvents>(
  channel: K,
  callback: (data: MainToRendererEvents[K]) => void,
): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: MainToRendererEvents[K]): void => {
    callback(data);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: ConnectorAPI = {
  // IpcApi
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.getVersion),
  getTheme: () => ipcRenderer.invoke(IPC_CHANNELS.getTheme),
  setTheme: (theme) => ipcRenderer.invoke(IPC_CHANNELS.setTheme, theme),
  getNativeThemeDark: () => ipcRenderer.invoke(IPC_CHANNELS.getNativeThemeDark),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  listAgents: () => ipcRenderer.invoke(IPC_CHANNELS.listAgents),
  addAgent: (input) => ipcRenderer.invoke(IPC_CHANNELS.addAgent, input),
  updateAgent: (agentId, updates) => ipcRenderer.invoke(IPC_CHANNELS.updateAgent, agentId, updates),
  removeAgent: (agentId) => ipcRenderer.invoke(IPC_CHANNELS.removeAgent, agentId),
  startAgent: (agentId) => ipcRenderer.invoke(IPC_CHANNELS.startAgent, agentId),
  stopAgent: (agentId) => ipcRenderer.invoke(IPC_CHANNELS.stopAgent, agentId),

  // Push events
  onAgentStatusChanged: (callback) => onEvent(EVENT_CHANNELS['agent-status-changed'], callback),
  onAgentApprovalUrl: (callback) => onEvent(EVENT_CHANNELS['agent-approval-url'], callback),
  onAgentConfigUpdated: (callback) => onEvent(EVENT_CHANNELS['agent-config-updated'], callback),
};

contextBridge.exposeInMainWorld('api', api);
