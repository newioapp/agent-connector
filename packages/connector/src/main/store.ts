/**
 * Electron-store schema and factory for persistent app settings.
 *
 * Agent configs and tokens are stored in ~/.newio/ (FileAgentConfigManager).
 * This store holds only UI/desktop-specific settings and per-agent env vars
 * (synced from the user's login shell — a desktop-only feature).
 */
import Store from 'electron-store';
import type { ThemeSource } from '../shared/types';
import type { UpdateMode, UpdateChannel } from '../shared/types';

export interface AgentEnvConfig {
  readonly envVars: Readonly<Record<string, string>>;
  readonly envVarsShell?: string;
}

export interface StoreSchema {
  readonly themeSource: ThemeSource;
  readonly updateMode: UpdateMode;
  readonly updateChannel: UpdateChannel;
  readonly windowBounds: {
    readonly x?: number;
    readonly y?: number;
    readonly width: number;
    readonly height: number;
  };
  /** Per-agent environment variables, keyed by agent config id. Desktop-only (synced from shell). */
  readonly agentEnvVars: Partial<Record<string, AgentEnvConfig>>;
}

export function createStore(): Store<StoreSchema> {
  return new Store<StoreSchema>({
    defaults: {
      themeSource: 'system',
      updateMode: 'auto',
      updateChannel: 'latest',
      windowBounds: { width: 960, height: 640 },
      agentEnvVars: {},
    },
  });
}
