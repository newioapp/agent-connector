import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Store from 'electron-store';
import type { Stage } from '../../src/shared/types';
import type { StoreSchema } from '../../src/main/store';
import type { DaemonConnection } from '../../src/main/daemon-connection';
import type { MainWindowManager } from '../../src/main/main-window';

const mocks = vi.hoisted(() => ({
  relaunch: vi.fn(),
  quit: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { relaunch: mocks.relaunch, quit: mocks.quit, getVersion: () => '1.2.3' },
  dialog: {},
  shell: {},
  nativeTheme: {},
}));

vi.mock('../../src/main/create-account', () => ({ createAccount: vi.fn() }));

vi.mock('../../src/main/auto-updater', () => ({
  applyUpdateMode: vi.fn(),
  applyUpdateChannel: vi.fn(),
  manualCheckForUpdates: vi.fn(),
}));

import { IpcHandler } from '../../src/main/ipc-handler';

function makeStore(stage: Stage) {
  const state = { stage };
  return {
    get: vi.fn((key: keyof StoreSchema) => state[key as 'stage']),
    set: vi.fn((key: keyof StoreSchema, value: Stage) => {
      state[key as 'stage'] = value;
    }),
  } as unknown as Store<StoreSchema>;
}

function makeHandler(store: Store<StoreSchema>) {
  const connection = {} as unknown as DaemonConnection;
  const windows = { send: vi.fn() } as unknown as MainWindowManager;
  return new IpcHandler({ store, connection, windows });
}

describe('IpcHandler.setStage', () => {
  beforeEach(() => {
    mocks.relaunch.mockClear();
    mocks.quit.mockClear();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__INCLUDE_ENV_SELECTOR__;
  });

  it('rejects when the env selector is disabled in this build', async () => {
    (globalThis as Record<string, unknown>).__INCLUDE_ENV_SELECTOR__ = false;
    const store = makeStore('prod');
    const handler = makeHandler(store);

    await expect(handler.setStage('dev')).rejects.toThrow(/disabled/);
    expect(store.set).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it('rejects an unknown stage value even when the selector is enabled', async () => {
    (globalThis as Record<string, unknown>).__INCLUDE_ENV_SELECTOR__ = true;
    const store = makeStore('dev');
    const handler = makeHandler(store);

    await expect(handler.setStage('staging' as Stage)).rejects.toThrow(/Invalid stage/);
    expect(store.set).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it('is a no-op when the requested stage is already active', async () => {
    (globalThis as Record<string, unknown>).__INCLUDE_ENV_SELECTOR__ = true;
    const store = makeStore('dev');
    const handler = makeHandler(store);

    await handler.setStage('dev');
    expect(store.set).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it('persists a valid new stage and relaunches', async () => {
    (globalThis as Record<string, unknown>).__INCLUDE_ENV_SELECTOR__ = true;
    const store = makeStore('dev');
    const handler = makeHandler(store);

    await handler.setStage('integ');
    expect(store.set).toHaveBeenCalledWith('stage', 'integ');
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });
});
