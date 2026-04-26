import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRuntimeManager } from '../../src/core/agent-runtime-manager';
import type { StatusListener } from '../../src/core/agent-runtime-manager';
import type { AgentConfigManager } from '../../src/core/agent-config-manager';
import type { SessionStore } from '../../src/core/session-store';
import type { AgentConfig } from '../../src/core/types';

// Mock AcpAgentInstance — the only concrete implementation created by the manager
vi.mock('../../src/core/acp-agent-instance', () => ({
  AcpAgentInstance: vi.fn(),
}));

import { AcpAgentInstance } from '../../src/core/acp-agent-instance';

const MockAcpAgentInstance = vi.mocked(AcpAgentInstance);

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

function mockSessionStore(): SessionStore {
  return {} as SessionStore;
}

function mockListener(): StatusListener {
  return {
    onStatusChanged: vi.fn(),
    onApprovalUrl: vi.fn(),
    onPollAttempt: vi.fn(),
    onConfigUpdated: vi.fn(),
    onAgentInfo: vi.fn(),
    onAgentSessionConfigUpdated: vi.fn(),
  };
}

describe('AgentRuntimeManager', () => {
  let configManager: AgentConfigManager;
  let sessionStore: SessionStore;
  let listener: StatusListener;
  let manager: AgentRuntimeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    configManager = mockConfigManager([makeConfig('agent-1', 'alice'), makeConfig('agent-2', 'bob')]);
    sessionStore = mockSessionStore();
    listener = mockListener();
    manager = new AgentRuntimeManager(configManager, sessionStore, listener);

    // Default mock instance behavior
    MockAcpAgentInstance.mockImplementation(() => {
      return {
        status: 'running',
        error: undefined,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getAgentInfo: vi.fn().mockReturnValue(undefined),
        listModels: vi.fn().mockReturnValue(undefined),
        listModes: vi.fn().mockReturnValue(undefined),
        configureAgent: vi.fn().mockResolvedValue(undefined),
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

      expect(MockAcpAgentInstance).toHaveBeenCalledOnce();
      const instance = MockAcpAgentInstance.mock.results[0].value;
      expect(instance.start).toHaveBeenCalledOnce();
    });

    it('throws when agent config is not found', () => {
      expect(() => manager.start('nonexistent')).toThrow('Agent nonexistent not found');
    });

    it('skips start if agent is already running', () => {
      manager.start('agent-1');
      manager.start('agent-1'); // second call should be no-op

      expect(MockAcpAgentInstance).toHaveBeenCalledOnce();
    });

    it('allows restart after stop', async () => {
      manager.start('agent-1');
      await manager.stop('agent-1');
      manager.start('agent-1');

      expect(MockAcpAgentInstance).toHaveBeenCalledTimes(2);
    });

    it('allows restart when status is error', () => {
      MockAcpAgentInstance.mockImplementationOnce(() => {
        return { status: 'error', error: 'crashed', start: vi.fn(), stop: vi.fn() } as never;
      });
      manager.start('agent-1');

      // Now start again — should create a new instance since status is 'error'
      manager.start('agent-1');
      expect(MockAcpAgentInstance).toHaveBeenCalledTimes(2);
    });

    it('prevents two agents with the same username from running', () => {
      configManager = mockConfigManager([
        makeConfig('agent-1', 'alice'),
        makeConfig('agent-2', 'alice'), // same username
      ]);
      manager = new AgentRuntimeManager(configManager, sessionStore, listener);

      manager.start('agent-1');
      expect(() => manager.start('agent-2')).toThrow('already running with username @alice');
    });

    it('allows same username if the other agent is stopped', async () => {
      configManager = mockConfigManager([makeConfig('agent-1', 'alice'), makeConfig('agent-2', 'alice')]);
      manager = new AgentRuntimeManager(configManager, sessionStore, listener);

      manager.start('agent-1');
      await manager.stop('agent-1');
      // Should not throw now
      manager.start('agent-2');
      expect(MockAcpAgentInstance).toHaveBeenCalledTimes(2);
    });

    it('relays status events through the listener with agentId', () => {
      manager.start('agent-1');

      // Grab the instanceListener passed to the constructor
      const instanceListener = MockAcpAgentInstance.mock.calls[0][3];

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

      instanceListener.onAgentSessionConfigUpdated('sess-1', undefined, undefined);
      expect(listener.onAgentSessionConfigUpdated).toHaveBeenCalledWith('agent-1', 'sess-1', undefined, undefined);
    });
  });

  describe('stop', () => {
    it('calls instance.stop and removes from map', async () => {
      manager.start('agent-1');
      const instance = MockAcpAgentInstance.mock.results[0].value;

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
      MockAcpAgentInstance.mockImplementationOnce(() => {
        return { status: 'running', start: vi.fn(), getAgentInfo: vi.fn().mockReturnValue(info) } as never;
      });

      manager.start('agent-1');
      expect(manager.getAgentInfo('agent-1')).toBe(info);
    });

    it('getAgentInfo returns undefined for unknown agent', () => {
      expect(manager.getAgentInfo('unknown')).toBeUndefined();
    });

    it('listModels/listModes delegate to instance', () => {
      const models = { options: [{ id: 'm1', name: 'M1' }], selectedId: 'm1' };
      const modes = { options: [{ id: 'fast', name: 'Fast' }], selectedId: 'fast' };
      MockAcpAgentInstance.mockImplementationOnce(() => {
        return {
          status: 'running',
          start: vi.fn(),
          listModels: vi.fn().mockReturnValue(models),
          listModes: vi.fn().mockReturnValue(modes),
        } as never;
      });

      manager.start('agent-1');
      expect(manager.listModels('agent-1')).toBe(models);
      expect(manager.listModes('agent-1')).toBe(modes);
    });

    it('listModels/listModes return undefined for unknown agent', () => {
      expect(manager.listModels('unknown')).toBeUndefined();
      expect(manager.listModes('unknown')).toBeUndefined();
    });

    it('configureAgent delegates to instance', async () => {
      manager.start('agent-1');
      const instance = MockAcpAgentInstance.mock.results[0].value;

      await manager.configureAgent('agent-1', { model: 'gpt-4' });
      expect(instance.configureAgent).toHaveBeenCalledWith({ model: 'gpt-4' });
    });

    it('configureAgent is a no-op for unknown agent', async () => {
      await expect(manager.configureAgent('unknown', { model: 'x' })).resolves.toBeUndefined();
    });
  });
});
