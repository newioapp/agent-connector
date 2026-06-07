/**
 * Electron-store schema and factory for persistent app settings.
 *
 * Agent configs and tokens are stored in ~/.newio[-stage]/connector/ (FileAgentConfigManager).
 * This store holds only UI/desktop-specific settings.
 */
import Store from 'electron-store';
import type { ThemeSource, UpdateMode, UpdateChannel, Stage } from '../shared/types';

export interface StoreSchema {
  readonly themeSource: ThemeSource;
  readonly updateMode: UpdateMode;
  readonly updateChannel: UpdateChannel;
  /** Which stage's daemon the desktop attaches to. Defaults to the build's stage. */
  readonly stage: Stage;
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
      stage: __NEWIO_STAGE__,
      windowBounds: { width: 960, height: 640 },
    },
  });
}
