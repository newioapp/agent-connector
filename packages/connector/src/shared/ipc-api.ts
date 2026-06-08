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
  AgentInfo,
  UpdateMode,
  UpdateChannel,
  Stage,
  StageConfig,
  EnvSyncMode,
} from './types';
import type { DaemonConnectionStatus } from './ipc-events';

/** Result of creating a new Newio agent account from the desktop. */
export interface CreateAccountResult {
  readonly username: string;
  readonly agentId: string;
}

export interface IpcApi {
  /** Get the app version. */
  getVersion(): Promise<string>;

  // Daemon connection
  /** Current state of the connection to the daemon. */
  getDaemonConnection(): Promise<DaemonConnectionStatus>;
  /** Re-attempt connecting to the daemon (e.g. after the user starts it). */
  reconnectDaemon(): Promise<void>;

  // Stage / environment
  /** The stage the desktop attaches to, plus whether the user may switch it. */
  getStageConfig(): Promise<StageConfig>;
  /** Switch stages: persists the choice and relaunches the app. */
  setStage(stage: Stage): Promise<void>;

  // Account
  /**
   * Register a brand-new Newio agent account against the connected daemon's
   * backend. Opens the approval URL in the browser and resolves once approved.
   */
  createAccount(name: string): Promise<CreateAccountResult>;

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

  // Environment
  /** Capture environment variables from this app's own process (basic essentials, or all). */
  captureEnv(mode: EnvSyncMode): Promise<Record<string, string>>;
  /** Update only the envVars on an agent config (no restart required). */
  updateAgentEnvVars(agentId: string, envVars: Record<string, string>): Promise<AgentConfig>;

  /** Get runtime agent info (capabilities, auth methods) for a running agent. */
  getAgentInfo(agentId: string): Promise<AgentInfo | undefined>;
}

/** Channel name for each IpcApi method. */
export const IPC_CHANNELS: { readonly [K in keyof IpcApi]: string } = {
  getVersion: 'get-version',
  getDaemonConnection: 'get-daemon-connection',
  reconnectDaemon: 'reconnect-daemon',
  getStageConfig: 'get-stage-config',
  setStage: 'set-stage',
  createAccount: 'create-account',
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
  listAgents: 'list-agents',
  addAgent: 'add-agent',
  updateAgent: 'update-agent',
  removeAgent: 'remove-agent',
  startAgent: 'start-agent',
  stopAgent: 'stop-agent',
  captureEnv: 'capture-env',
  updateAgentEnvVars: 'update-agent-env-vars',
  getAgentInfo: 'get-agent-info',
};
