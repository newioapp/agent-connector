/**
 * Electron-store schema and factory for persistent app settings.
 */
import Store from 'electron-store';
import type { ThemeSource, AgentConfig } from '../shared/types';
import type { UpdateMode } from '../shared/types';

export interface AgentTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface StoreSchema {
  readonly themeSource: ThemeSource;
  readonly updateMode: UpdateMode;
  readonly windowBounds: {
    readonly x?: number;
    readonly y?: number;
    readonly width: number;
    readonly height: number;
  };
  readonly agents: AgentConfig[];
  /** Persisted tokens keyed by agent config id. */
  readonly agentTokens: Record<string, AgentTokens>;
}

export function createStore(): Store<StoreSchema> {
  return new Store<StoreSchema>({
    defaults: {
      themeSource: 'system',
      updateMode: 'auto',
      windowBounds: { width: 960, height: 640 },
      agents: [],
      agentTokens: {},
    },
  });
}
