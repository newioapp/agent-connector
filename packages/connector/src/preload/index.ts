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
  getUpdateMode: () => ipcRenderer.invoke(IPC_CHANNELS.getUpdateMode),
  setUpdateMode: (mode) => ipcRenderer.invoke(IPC_CHANNELS.setUpdateMode, mode),
  getUpdateChannel: () => ipcRenderer.invoke(IPC_CHANNELS.getUpdateChannel),
  setUpdateChannel: (channel) => ipcRenderer.invoke(IPC_CHANNELS.setUpdateChannel, channel),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.checkForUpdates),
  selectDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.selectDirectory),
  listKiroAgents: (kiroCliPath, cwd) => ipcRenderer.invoke(IPC_CHANNELS.listKiroAgents, kiroCliPath, cwd),
  listKiroModels: (kiroCliPath, cwd) => ipcRenderer.invoke(IPC_CHANNELS.listKiroModels, kiroCliPath, cwd),
  listAgents: () => ipcRenderer.invoke(IPC_CHANNELS.listAgents),
  addAgent: (input) => ipcRenderer.invoke(IPC_CHANNELS.addAgent, input),
  updateAgent: (agentId, updates) => ipcRenderer.invoke(IPC_CHANNELS.updateAgent, agentId, updates),
  removeAgent: (agentId) => ipcRenderer.invoke(IPC_CHANNELS.removeAgent, agentId),
  startAgent: (agentId) => ipcRenderer.invoke(IPC_CHANNELS.startAgent, agentId),
  stopAgent: (agentId) => ipcRenderer.invoke(IPC_CHANNELS.stopAgent, agentId),
  listShells: () => ipcRenderer.invoke(IPC_CHANNELS.listShells),
  getShellEnv: (shell) => ipcRenderer.invoke(IPC_CHANNELS.getShellEnv, shell),
  updateAgentEnvVars: (agentId, envVars) => ipcRenderer.invoke(IPC_CHANNELS.updateAgentEnvVars, agentId, envVars),

  // Push events
  onAgentStatusChanged: (callback) => onEvent(EVENT_CHANNELS['agent-status-changed'], callback),
  onAgentApprovalUrl: (callback) => onEvent(EVENT_CHANNELS['agent-approval-url'], callback),
  onAgentPollAttempt: (callback) => onEvent(EVENT_CHANNELS['agent-poll-attempt'], callback),
  onAgentConfigUpdated: (callback) => onEvent(EVENT_CHANNELS['agent-config-updated'], callback),
};

contextBridge.exposeInMainWorld('api', api);
