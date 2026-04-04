/**
 * IPC contract between the main process and renderer process.
 *
 * Defines typed interfaces for all request/response IPC channels
 * (ipcMain.handle / ipcRenderer.invoke). Push events from main → renderer
 * are defined in ipc-events.ts.
 */
import type { ThemeSource, AgentConfig, AddAgentInput, UpdateAgentInput, AgentStatusInfo } from './types';

export interface IpcApi {
  /** Get the app version. */
  getVersion(): Promise<string>;

  // Theme
  getTheme(): Promise<ThemeSource>;
  setTheme(theme: ThemeSource): Promise<void>;
  getNativeThemeDark(): Promise<boolean>;

  // External URLs
  openExternal(url: string): Promise<void>;

  // Agent CRUD
  listAgents(): Promise<AgentStatusInfo[]>;
  addAgent(input: AddAgentInput): Promise<AgentConfig>;
  updateAgent(agentId: string, updates: UpdateAgentInput): Promise<AgentConfig>;
  removeAgent(agentId: string): Promise<void>;

  // Agent lifecycle
  startAgent(agentId: string): Promise<void>;
  stopAgent(agentId: string): Promise<void>;

  // Environment
  /** List supported shells available on the system. */
  listShells(): Promise<string[]>;
  /** Resolve environment variables from a specific shell. */
  getShellEnv(shell: string): Promise<Record<string, string>>;
  /** Update only the envVars on an agent config (no restart required). */
  updateAgentEnvVars(agentId: string, envVars: Record<string, string>): Promise<AgentConfig>;
}

/** Channel name for each IpcApi method. */
export const IPC_CHANNELS: { readonly [K in keyof IpcApi]: string } = {
  getVersion: 'get-version',
  getTheme: 'get-theme',
  setTheme: 'set-theme',
  getNativeThemeDark: 'get-native-theme-dark',
  openExternal: 'open-external',
  listAgents: 'list-agents',
  addAgent: 'add-agent',
  updateAgent: 'update-agent',
  removeAgent: 'remove-agent',
  startAgent: 'start-agent',
  stopAgent: 'stop-agent',
  listShells: 'list-shells',
  getShellEnv: 'get-shell-env',
  updateAgentEnvVars: 'update-agent-env-vars',
};
