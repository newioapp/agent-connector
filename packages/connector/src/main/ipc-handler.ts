/**
 * Main process IPC handler implementations.
 *
 * Each method corresponds to an IpcApi interface method.
 * Registered with ipcMain.handle via registerIpcHandlers().
 */
/* eslint-disable @typescript-eslint/require-await -- IpcApi interface requires Promise returns */
import { app, shell, nativeTheme } from 'electron';
import type Store from 'electron-store';
import type { IpcApi } from '../shared/ipc-api';
import type { ThemeSource, AgentConfig, AddAgentInput, UpdateAgentInput, AgentStatusInfo } from '../shared/types';
import type { StoreSchema } from './store';
import type { AgentConfigManager } from './agent-config-manager';

interface IpcHandlerDeps {
  readonly store: Store<StoreSchema>;
  readonly agentConfigManager: AgentConfigManager;
}

export class IpcHandler implements IpcApi {
  private readonly store: Store<StoreSchema>;
  private readonly agentConfigManager: AgentConfigManager;

  constructor(deps: IpcHandlerDeps) {
    this.store = deps.store;
    this.agentConfigManager = deps.agentConfigManager;
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

  async listAgents(): Promise<AgentStatusInfo[]> {
    // C2: all agents are stopped. C3 will add runtime status.
    return this.agentConfigManager.list().map((config) => ({
      id: config.id,
      config,
      runtimeStatus: 'stopped',
    }));
  }

  async addAgent(input: AddAgentInput): Promise<AgentConfig> {
    return this.agentConfigManager.add(input);
  }

  async updateAgent(agentId: string, updates: UpdateAgentInput): Promise<AgentConfig> {
    return this.agentConfigManager.update(agentId, updates);
  }

  async removeAgent(agentId: string): Promise<void> {
    this.agentConfigManager.remove(agentId);
  }
}
