/**
 * Electron-store schema and factory for persistent app settings.
 */
import Store from 'electron-store';
import type { ThemeSource, AgentConfig } from '../shared/types';

export interface StoreSchema {
  readonly themeSource: ThemeSource;
  readonly windowBounds: {
    readonly x?: number;
    readonly y?: number;
    readonly width: number;
    readonly height: number;
  };
  readonly agents: AgentConfig[];
}

export function createStore(): Store<StoreSchema> {
  return new Store<StoreSchema>({
    defaults: {
      themeSource: 'system',
      windowBounds: { width: 960, height: 640 },
      agents: [],
    },
  });
}
