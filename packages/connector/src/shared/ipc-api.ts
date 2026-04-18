/**
 * IPC contract between the main process and renderer process.
 *
 * Defines typed interfaces for all request/response IPC channels
 * (ipcMain.handle / ipcRenderer.invoke). Push events from main → renderer
 * are defined in ipc-events.ts.
 */
import type {
  ThemeSource,
  AgentConfig,
  AddAgentInput,
  UpdateAgentInput,
  AgentStatusInfo,
  AgentSessionConfig,
  UpdateMode,
  UpdateChannel,
} from './types';

export interface IpcApi {
  /** Get the app version. */
  getVersion(): Promise<string>;

  // Theme
  getTheme(): Promise<ThemeSource>;
  setTheme(theme: ThemeSource): Promise<void>;
  getNativeThemeDark(): Promise<boolean>;

  // External URLs
  openExternal(url: string): Promise<void>;

  // Updates
  getUpdateMode(): Promise<UpdateMode>;
  setUpdateMode(mode: UpdateMode): Promise<void>;
  getUpdateChannel(): Promise<UpdateChannel>;
  setUpdateChannel(channel: UpdateChannel): Promise<void>;
  checkForUpdates(): Promise<void>;

  // Agent CRUD
  listAgents(): Promise<AgentStatusInfo[]>;
  addAgent(input: AddAgentInput): Promise<AgentConfig>;
  updateAgent(agentId: string, updates: UpdateAgentInput): Promise<AgentConfig>;
  removeAgent(agentId: string): Promise<void>;

  // Agent lifecycle
  startAgent(agentId: string): Promise<void>;
  stopAgent(agentId: string): Promise<void>;

  // Dialogs
  /** Open a native directory picker dialog. Returns the selected path, or undefined if cancelled. */
  selectDirectory(): Promise<string | undefined>;

  // Dialogs
  /** Open a native directory picker dialog. Returns the selected path, or undefined if cancelled. */
  selectDirectory(): Promise<string | undefined>;

  // Kiro CLI discovery
  /** List available Kiro CLI agent names. Returns empty array on failure. */
  listKiroAgents(kiroCliPath?: string, cwd?: string): Promise<string[]>;
  /** List available Kiro CLI models. Returns empty array on failure. */
  listKiroModels(kiroCliPath?: string, cwd?: string): Promise<string[]>;

  // Environment
  /** List supported shells available on the system. */
  listShells(): Promise<string[]>;
  /** Resolve environment variables from a specific shell. */
  getShellEnv(shell: string): Promise<Record<string, string>>;
  /** Update only the envVars on an agent config (no restart required). */
  updateAgentEnvVars(agentId: string, envVars: Record<string, string>): Promise<AgentConfig>;

  /** List available models for a running agent. */
  listAgentModels(agentId: string): Promise<AgentSessionConfig | undefined>;
  /** List available modes for a running agent. */
  listAgentModes(agentId: string): Promise<AgentSessionConfig | undefined>;
  /** Configure model/mode on one or all sessions. */
  configureAgent(agentId: string, model?: string, mode?: string): Promise<void>;
}

/** Channel name for each IpcApi method. */
export const IPC_CHANNELS: { readonly [K in keyof IpcApi]: string } = {
  getVersion: 'get-version',
  getTheme: 'get-theme',
  setTheme: 'set-theme',
  getNativeThemeDark: 'get-native-theme-dark',
  openExternal: 'open-external',
  getUpdateMode: 'get-update-mode',
  setUpdateMode: 'set-update-mode',
  getUpdateChannel: 'get-update-channel',
  setUpdateChannel: 'set-update-channel',
  checkForUpdates: 'check-for-updates',
  selectDirectory: 'select-directory',
  listKiroAgents: 'list-kiro-agents',
  listKiroModels: 'list-kiro-models',
  listAgents: 'list-agents',
  addAgent: 'add-agent',
  updateAgent: 'update-agent',
  removeAgent: 'remove-agent',
  startAgent: 'start-agent',
  stopAgent: 'stop-agent',
  listShells: 'list-shells',
  getShellEnv: 'get-shell-env',
  updateAgentEnvVars: 'update-agent-env-vars',
  listAgentModels: 'list-agent-models',
  listAgentModes: 'list-agent-modes',
  configureAgent: 'configure-agent',
};
