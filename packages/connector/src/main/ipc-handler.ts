/**
 * Main process IPC handler implementations.
 *
 * Each method corresponds to an IpcApi interface method.
 * Registered with ipcMain.handle via registerIpcHandlers().
 */
/* eslint-disable @typescript-eslint/require-await -- IpcApi interface requires Promise returns */
import { app, dialog, shell, nativeTheme } from 'electron';
import type Store from 'electron-store';
import type { IpcApi } from '../shared/ipc-api';
import type {
  ThemeSource,
  AgentConfig,
  AddAgentInput,
  UpdateAgentInput,
  AgentStatusInfo,
  AgentSessionConfig,
  AgentInfo,
  UpdateMode,
  UpdateChannel,
} from '../shared/types';
import type { StoreSchema } from './store';
import type { AgentConfigManager } from '../core/agent-config-manager';
import type { AgentRuntimeManager } from '../core/agent-runtime-manager';
import { getShellEnv, listAvailableShells } from './shell-env';
import { applyUpdateMode, applyUpdateChannel, manualCheckForUpdates } from './auto-updater';

interface IpcHandlerDeps {
  readonly store: Store<StoreSchema>;
  readonly agentConfigManager: AgentConfigManager;
  readonly agentRuntimeManager: AgentRuntimeManager;
}

export class IpcHandler implements IpcApi {
  private readonly store: Store<StoreSchema>;
  private readonly agentConfigManager: AgentConfigManager;
  private readonly agentRuntimeManager: AgentRuntimeManager;

  constructor(deps: IpcHandlerDeps) {
    this.store = deps.store;
    this.agentConfigManager = deps.agentConfigManager;
    this.agentRuntimeManager = deps.agentRuntimeManager;
  }

  async getVersion(): Promise<string> {
    return app.getVersion();
  }

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

  async listAgents(): Promise<AgentStatusInfo[]> {
    return this.agentConfigManager.list().map((config) => {
      const { status, error } = this.agentRuntimeManager.getStatus(config.id);
      return { id: config.id, config, runtimeStatus: status, error };
    });
  }

  async addAgent(input: AddAgentInput): Promise<AgentConfig> {
    const config = await this.agentConfigManager.add(input);
    // Auto-detect shell and populate env vars for the new agent
    const shells = listAvailableShells();
    const selectedShell = shells.length > 0 ? shells[0] : undefined;
    if (selectedShell) {
      const envVars = await getShellEnv(selectedShell);
      return this.agentConfigManager.update(config.id, { envVars, envVarsShell: selectedShell });
    }
    return config;
  }

  async updateAgent(agentId: string, updates: UpdateAgentInput): Promise<AgentConfig> {
    return this.agentConfigManager.update(agentId, updates);
  }

  async removeAgent(agentId: string): Promise<void> {
    await this.agentRuntimeManager.stop(agentId);
    this.agentConfigManager.remove(agentId);
  }

  async startAgent(agentId: string): Promise<void> {
    this.agentRuntimeManager.start(agentId);
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.agentRuntimeManager.stop(agentId);
  }

  async listShells(): Promise<string[]> {
    return listAvailableShells();
  }

  async getShellEnv(shell: string): Promise<Record<string, string>> {
    return getShellEnv(shell);
  }

  async updateAgentEnvVars(agentId: string, envVars: Record<string, string>, shell?: string): Promise<AgentConfig> {
    return this.agentConfigManager.update(agentId, { envVars, ...(shell ? { envVarsShell: shell } : {}) });
  }

  async listAgentModels(agentId: string): Promise<AgentSessionConfig | undefined> {
    return this.agentRuntimeManager.listModels(agentId);
  }

  async listAgentModes(agentId: string): Promise<AgentSessionConfig | undefined> {
    return this.agentRuntimeManager.listModes(agentId);
  }

  async configureAgent(agentId: string, model?: string, mode?: string): Promise<void> {
    await this.agentRuntimeManager.configureAgent(agentId, { model, mode });
  }

  async getAgentInfo(agentId: string): Promise<AgentInfo | undefined> {
    return this.agentRuntimeManager.getAgentInfo(agentId);
  }
}
