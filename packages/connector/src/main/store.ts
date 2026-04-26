/**
 * Electron-store schema and factory for persistent app settings.
 *
 * Agent configs and tokens are stored in ~/.newio/connector/ (FileAgentConfigManager).
 * This store holds only UI/desktop-specific settings.
 */
import Store from 'electron-store';
import type { ThemeSource } from '../shared/types';
import type { UpdateMode, UpdateChannel } from '../shared/types';

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
}

export function createStore(): Store<StoreSchema> {
  return new Store<StoreSchema>({
    defaults: {
      themeSource: 'system',
      updateMode: 'auto',
      updateChannel: 'latest',
      windowBounds: { width: 960, height: 640 },
    },
  });
}
