import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRuntimeManager } from '../../src/agent-runtime-manager';
import type { StatusListener } from '../../src/agent-runtime-manager';
import type { AgentConfigManager } from '../../src/agent-config-manager';
import type { CronStore } from '../../src/cron-store';
import type { AgentConfig } from '../../src/types';
import type { EngineConfig } from '../../src/engine-config';

// Mock AgentInstanceImpl — the only concrete implementation created by the manager
vi.mock('../../src/agent-instance-impl', () => ({
  AgentInstanceImpl: vi.fn(),
}));

import { AgentInstanceImpl } from '../../src/agent-instance-impl';

const MockAgentInstanceImpl = vi.mocked(AgentInstanceImpl);

function makeConfig(id: string, username?: string): AgentConfig {
  return {
    id,
    type: 'claude-code',
    newio: username ? { username, displayName: username } : undefined,
    envVars: {},
    acp: { cwd: '/tmp' },
  };
}

function mockConfigManager(configs: AgentConfig[]): AgentConfigManager {
  const map = new Map(configs.map((c) => [c.id, c]));
  return {
    list: () => [...map.values()],
    get: (id: string) => map.get(id),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    setNewioIdentity: vi.fn(),
    getTokens: vi.fn(),
    setTokens: vi.fn(),
    clearTokens: vi.fn(),
  };
}

function mockCronStore(): CronStore {
  return {} as CronStore;
}

const mockEngineConfig: EngineConfig = {
  apiBaseUrl: 'https://api.test.newio.app',
  wsUrl: 'wss://ws.test.newio.app',
  stage: 'dev',
  appDisplayName: 'Test Connector',
  appVersion: '0.0.1',
  dataDir: '/tmp/newio-test',
};

function mockListener(): StatusListener {
  return {
    onStatusChanged: vi.fn(),
    onApprovalUrl: vi.fn(),
    onPollAttempt: vi.fn(),
    onConfigUpdated: vi.fn(),
    onAgentInfo: vi.fn(),
  };
}

describe('AgentRuntimeManager', () => {
  let configManager: AgentConfigManager;
  let sessionStore: CronStore;
  let listener: StatusListener;
  let manager: AgentRuntimeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    configManager = mockConfigManager([makeConfig('agent-1', 'alice'), makeConfig('agent-2', 'bob')]);
    sessionStore = mockCronStore();
    listener = mockListener();
    manager = new AgentRuntimeManager(configManager, sessionStore, listener, mockEngineConfig);

    // Default mock instance behavior
    MockAgentInstanceImpl.mockImplementation(() => {
      return {
        status: 'running',
        error: undefined,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getAgentInfo: vi.fn().mockReturnValue(undefined),
      } as never;
    });
  });

  describe('getStatus', () => {
    it('returns stopped for unknown agent', () => {
      expect(manager.getStatus('unknown')).toEqual({ status: 'stopped' });
    });

    it('returns instance status after start', () => {
      manager.start('agent-1');
      expect(manager.getStatus('agent-1')).toEqual({ status: 'running', error: undefined });
    });
  });

  describe('start', () => {
    it('creates an AcpAgentInstance and calls start', () => {
      manager.start('agent-1');

      expect(MockAgentInstanceImpl).toHaveBeenCalledOnce();
      const instance = MockAgentInstanceImpl.mock.results[0]!.value;
      expect(instance.start).toHaveBeenCalledOnce();
    });

    it('throws when agent config is not found', () => {
      expect(() => manager.start('nonexistent')).toThrow('Agent nonexistent not found');
    });

    it('skips start if agent is already running', () => {
      manager.start('agent-1');
      manager.start('agent-1'); // second call should be no-op

      expect(MockAgentInstanceImpl).toHaveBeenCalledOnce();
    });

    it('allows restart after stop', async () => {
      manager.start('agent-1');
      await manager.stop('agent-1');
      manager.start('agent-1');

      expect(MockAgentInstanceImpl).toHaveBeenCalledTimes(2);
    });

    it('allows restart when status is error', () => {
      MockAgentInstanceImpl.mockImplementationOnce(() => {
        return { status: 'error', error: 'crashed', start: vi.fn(), stop: vi.fn() } as never;
      });
      manager.start('agent-1');

      // Now start again — should create a new instance since status is 'error'
      manager.start('agent-1');
      expect(MockAgentInstanceImpl).toHaveBeenCalledTimes(2);
    });

    it('prevents two agents with the same username from running', () => {
      configManager = mockConfigManager([
        makeConfig('agent-1', 'alice'),
        makeConfig('agent-2', 'alice'), // same username
      ]);
      manager = new AgentRuntimeManager(configManager, sessionStore, listener, mockEngineConfig);

      manager.start('agent-1');
      expect(() => manager.start('agent-2')).toThrow('already running with username @alice');
    });

    it('allows same username if the other agent is stopped', async () => {
      configManager = mockConfigManager([makeConfig('agent-1', 'alice'), makeConfig('agent-2', 'alice')]);
      manager = new AgentRuntimeManager(configManager, sessionStore, listener, mockEngineConfig);

      manager.start('agent-1');
      await manager.stop('agent-1');
      // Should not throw now
      manager.start('agent-2');
      expect(MockAgentInstanceImpl).toHaveBeenCalledTimes(2);
    });

    it('relays status events through the listener with agentId', () => {
      manager.start('agent-1');

      // Grab the instanceListener passed to the constructor
      const instanceListener = MockAgentInstanceImpl.mock.calls[0]![3];

      instanceListener.onStatusChanged('running');
      expect(listener.onStatusChanged).toHaveBeenCalledWith('agent-1', 'running', undefined);

      instanceListener.onApprovalUrl('https://example.com/approve');
      expect(listener.onApprovalUrl).toHaveBeenCalledWith('agent-1', 'https://example.com/approve');

      instanceListener.onPollAttempt();
      expect(listener.onPollAttempt).toHaveBeenCalledWith('agent-1');

      instanceListener.onConfigUpdated();
      expect(listener.onConfigUpdated).toHaveBeenCalledWith('agent-1');

      const info = { protocol: 'acp' as const, protocolVersion: '1.0', capabilities: [] };
      instanceListener.onAgentInfo(info);
      expect(listener.onAgentInfo).toHaveBeenCalledWith('agent-1', info);
    });
  });

  describe('stop', () => {
    it('calls instance.stop and removes from map', async () => {
      manager.start('agent-1');
      const instance = MockAgentInstanceImpl.mock.results[0]!.value;

      await manager.stop('agent-1');

      expect(instance.stop).toHaveBeenCalledOnce();
      expect(manager.getStatus('agent-1')).toEqual({ status: 'stopped' });
    });

    it('is a no-op for unknown agent', async () => {
      await expect(manager.stop('unknown')).resolves.toBeUndefined();
    });
  });

  describe('stopAll', () => {
    it('stops all running agents', async () => {
      manager.start('agent-1');
      manager.start('agent-2');

      await manager.stopAll();

      expect(manager.getStatus('agent-1')).toEqual({ status: 'stopped' });
      expect(manager.getStatus('agent-2')).toEqual({ status: 'stopped' });
    });
  });

  describe('delegation methods', () => {
    it('getAgentInfo delegates to instance', () => {
      const info = { protocol: 'acp' as const, protocolVersion: '1.0', capabilities: [] };
      MockAgentInstanceImpl.mockImplementationOnce(() => {
        return { status: 'running', start: vi.fn(), getAgentInfo: vi.fn().mockReturnValue(info) } as never;
      });

      manager.start('agent-1');
      expect(manager.getAgentInfo('agent-1')).toBe(info);
    });

    it('getAgentInfo returns undefined for unknown agent', () => {
      expect(manager.getAgentInfo('unknown')).toBeUndefined();
    });
  });
});
