/**
 * Main process IPC handler implementations.
 *
 * Each method corresponds to an IpcApi interface method.
 * Registered with ipcMain.handle via registerIpcHandlers().
 *
 * Agent/env methods delegate to the daemon over the socket (via DaemonConnection);
 * theme/update/dialog methods are native and stay in the main process.
 */
/* eslint-disable @typescript-eslint/require-await -- IpcApi interface requires Promise returns */
import { app, dialog, shell, nativeTheme } from 'electron';
import type Store from 'electron-store';
import type { IpcApi, CreateAccountResult } from '../shared/ipc-api';
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
} from '../shared/types';
import type { DaemonConnectionStatus } from '../shared/ipc-events';
import { EVENT_CHANNELS } from '../shared/ipc-events';
import type { StoreSchema } from './store';
import type { DaemonConnection } from './daemon-connection';
import type { MainWindowManager } from './main-window';
import { createAccount } from './create-account';
import { applyUpdateMode, applyUpdateChannel, manualCheckForUpdates } from './auto-updater';

interface IpcHandlerDeps {
  readonly store: Store<StoreSchema>;
  readonly connection: DaemonConnection;
  readonly windows: MainWindowManager;
}

export class IpcHandler implements IpcApi {
  private readonly store: Store<StoreSchema>;
  private readonly connection: DaemonConnection;
  private readonly windows: MainWindowManager;

  constructor(deps: IpcHandlerDeps) {
    this.store = deps.store;
    this.connection = deps.connection;
    this.windows = deps.windows;
  }

  /** Typed handle to the daemon RPC client. */
  private get daemon() {
    return this.connection.connector;
  }

  async getVersion(): Promise<string> {
    return app.getVersion();
  }

  // Daemon connection -------------------------------------------------------

  async getDaemonConnection(): Promise<DaemonConnectionStatus> {
    return this.connection.getStatus();
  }

  async reconnectDaemon(): Promise<void> {
    await this.connection.connect();
  }

  // Stage / environment -----------------------------------------------------

  async getStageConfig(): Promise<StageConfig> {
    return { stage: this.store.get('stage'), selectorEnabled: __INCLUDE_ENV_SELECTOR__ };
  }

  async setStage(stage: Stage): Promise<void> {
    if (stage === this.store.get('stage')) {
      return;
    }
    // Switching stages means attaching to a different daemon (per-stage socket);
    // relaunch so the whole app re-resolves against the new stage cleanly.
    this.store.set('stage', stage);
    app.relaunch();
    app.quit();
  }

  // Account -----------------------------------------------------------------

  async createAccount(name: string): Promise<CreateAccountResult> {
    const apiBaseUrl = this.connection.getApiBaseUrl();
    if (!apiBaseUrl) {
      throw new Error('Not connected to a daemon — cannot create an account.');
    }
    return createAccount(apiBaseUrl, name, (url) => {
      void shell.openExternal(url);
      this.windows.send(EVENT_CHANNELS['account-approval-url'], { url });
    });
  }

  // Theme -------------------------------------------------------------------

  async getTheme(): Promise<ThemeSource> {
    return this.store.get('themeSource');
  }

  async setTheme(theme: ThemeSource): Promise<void> {
    nativeTheme.themeSource = theme;
    this.store.set('themeSource', theme);
  }

  async getNativeThemeDark(): Promise<boolean> {
    return nativeTheme.shouldUseDarkColors;
  }

  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url);
  }

  // Updates -----------------------------------------------------------------

  async getUpdateMode(): Promise<UpdateMode> {
    return this.store.get('updateMode');
  }

  async setUpdateMode(mode: UpdateMode): Promise<void> {
    this.store.set('updateMode', mode);
    applyUpdateMode(mode);
  }

  async getUpdateChannel(): Promise<UpdateChannel> {
    return this.store.get('updateChannel');
  }

  async setUpdateChannel(channel: UpdateChannel): Promise<void> {
    this.store.set('updateChannel', channel);
    applyUpdateChannel(channel);
  }

  async checkForUpdates(): Promise<void> {
    manualCheckForUpdates();
  }

  async selectDirectory(): Promise<string | undefined> {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? undefined : result.filePaths[0];
  }

  // Agents (delegated to the daemon) ----------------------------------------

  async listAgents(): Promise<AgentStatusInfo[]> {
    return this.daemon.listAgents();
  }

  async addAgent(input: AddAgentInput): Promise<AgentConfig> {
    // The daemon auto-syncs the login-shell env vars on add.
    return this.daemon.addAgent(input);
  }

  async updateAgent(agentId: string, updates: UpdateAgentInput): Promise<AgentConfig> {
    return this.daemon.updateAgent(agentId, updates);
  }

  async removeAgent(agentId: string): Promise<void> {
    await this.daemon.removeAgent(agentId);
  }

  async startAgent(agentId: string): Promise<void> {
    await this.daemon.startAgent(agentId);
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.daemon.stopAgent(agentId);
  }

  async listShells(): Promise<string[]> {
    return this.daemon.listShells();
  }

  async getShellEnv(shell: string): Promise<Record<string, string>> {
    return this.daemon.getShellEnv(shell);
  }

  async updateAgentEnvVars(agentId: string, envVars: Record<string, string>, shell?: string): Promise<AgentConfig> {
    return this.daemon.updateAgentEnvVars(agentId, envVars, shell);
  }

  async getAgentInfo(agentId: string): Promise<AgentInfo | undefined> {
    return (await this.daemon.getAgentInfo(agentId)) ?? undefined;
  }
}
