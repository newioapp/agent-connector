/**
 * Main process IPC handler implementations.
 *
 * Each method corresponds to an IpcApi interface method.
 * Registered with ipcMain.handle via registerIpcHandlers().
 */
/* eslint-disable @typescript-eslint/require-await -- IpcApi interface requires Promise returns */
import { app, dialog, shell, nativeTheme } from 'electron';
import { execFile } from 'child_process';
import type Store from 'electron-store';
import type { IpcApi } from '../shared/ipc-api';
import type {
  ThemeSource,
  AgentConfig,
  AddAgentInput,
  UpdateAgentInput,
  AgentStatusInfo,
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

  async listKiroAgents(kiroCliPath?: string, cwd?: string): Promise<string[]> {
    return this.execAcpCli(kiroCliPath, ['agent'], cwd, (output) => {
      // Lines like "* kiro_default  ..." or "  amzn-builder  ..." — name starts at column 2, followed by 2+ spaces
      return [...output.matchAll(/^[* ] (\S+) {2,}/gm)].map((m) => m[1]);
    });
  }

  async listKiroModels(kiroCliPath?: string, cwd?: string): Promise<string[]> {
    return this.execAcpCli(kiroCliPath, ['chat', '--list-models'], cwd, (output) => {
      return [...output.matchAll(/^[* ] (\S+) {2,}/gm)].map((m) => m[1]);
    });
  }

  private async execAcpCli(
    executablePath: string | undefined,
    args: string[],
    cwd: string | undefined,
    parse: (output: string) => string[],
  ): Promise<string[]> {
    const cmd = executablePath || 'kiro-cli';
    // When no explicit path, resolve shell env so the executable is on PATH
    const env = executablePath ? undefined : await this.getShellEnvCached();
    return new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { timeout: 10_000, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) },
        (err, stdout, stderr) => {
          if (err) {
            resolve([]);
            return;
          }
          const result = parse(stdout);
          resolve(result.length > 0 ? result : parse(stderr));
        },
      );
    });
  }

  private shellEnvCache?: Record<string, string>;
  private async getShellEnvCached(): Promise<Record<string, string>> {
    if (!this.shellEnvCache) {
      const shells = listAvailableShells();
      this.shellEnvCache = await getShellEnv(shells[0]);
    }
    return this.shellEnvCache;
  }

  async listAgents(): Promise<AgentStatusInfo[]> {
    return this.agentConfigManager.list().map((config) => {
      const { status, error } = this.agentRuntimeManager.getStatus(config.id);
      return { id: config.id, config, runtimeStatus: status, error };
    });
  }

  async addAgent(input: AddAgentInput): Promise<AgentConfig> {
    return await this.agentConfigManager.add(input);
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

  async updateAgentEnvVars(agentId: string, envVars: Record<string, string>): Promise<AgentConfig> {
    return this.agentConfigManager.update(agentId, { envVars });
  }

  async listAgentModels(agentId: string): Promise<import('../shared/types').AgentSessionConfig | undefined> {
    return this.agentRuntimeManager.listModels(agentId);
  }

  async listAgentModes(agentId: string): Promise<import('../shared/types').AgentSessionConfig | undefined> {
    return this.agentRuntimeManager.listModes(agentId);
  }

  async configureAgent(agentId: string, model?: string, mode?: string): Promise<void> {
    await this.agentRuntimeManager.configureAgent(agentId, { model, mode });
  }
}
