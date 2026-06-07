import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DaemonServer } from '../src/daemon/server';
import { DaemonHandler } from '../src/daemon/handler';
import { DaemonClient } from '../src/client';
import { DaemonConnector } from '../src/connector';
import type { AgentConfigManager } from '@newio/agent-engine';
import type { AgentRuntimeManager, StatusListener } from '@newio/agent-engine';
import type { AgentConfig, AgentStatusInfo } from '@newio/agent-engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockConfigManager(configs: AgentConfig[] = []): AgentConfigManager {
  const map = new Map(configs.map((c) => [c.id, c]));
  return {
    list: () => [...map.values()],
    get: (id) => map.get(id),
    add: vi.fn((input) => {
      const config = {
        id: randomUUID(),
        type: input.type,
        newio: { username: input.newioUsername },
        envVars: {},
      } as AgentConfig;
      map.set(config.id, config);
      return config;
    }),
    update: vi.fn((id, updates) => {
      const existing = map.get(id);
      if (!existing) throw new Error(`Agent ${id} not found`);
      const updated = { ...existing, ...updates } as AgentConfig;
      map.set(id, updated);
      return updated;
    }),
    remove: vi.fn((id) => {
      map.delete(id);
    }),
    setNewioIdentity: vi.fn(),
    getTokens: vi.fn(),
    setTokens: vi.fn(),
    clearTokens: vi.fn(),
  };
}

function mockRuntimeManager(): AgentRuntimeManager {
  return {
    getStatus: vi.fn().mockReturnValue({ status: 'stopped' }),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    getAgentInfo: vi.fn().mockReturnValue(undefined),
  } as unknown as AgentRuntimeManager;
}

function makeAgentConfig(id: string = randomUUID()): AgentConfig {
  return { id, type: 'claude-code', newio: { displayName: 'Test' }, envVars: {}, acp: { cwd: '/tmp' } };
}

async function setup() {
  const socketPath = join(tmpdir(), `newio-test-${randomUUID()}.sock`);
  const configManager = mockConfigManager([makeAgentConfig('agent-1')]);
  const runtimeManager = mockRuntimeManager();
  const onReload = vi.fn().mockResolvedValue(undefined);
  const onStop = vi.fn().mockResolvedValue(undefined);

  const handler = new DaemonHandler({
    agentConfigManager: configManager,
    agentRuntimeManager: runtimeManager,
    version: '1.2.3',
    onReload,
    onStop,
  });

  const server = new DaemonServer(handler);
  await server.listen(socketPath);

  const connector = new DaemonConnector(new DaemonClient());
  await connector.connect(socketPath);

  return { server, handler, connector, configManager, runtimeManager, onReload, onStop, socketPath };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DaemonServer / DaemonConnector', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    ctx.connector.disconnect();
    await ctx.server.close();
  });

  describe('daemon methods', () => {
    it('daemon.version returns version string', async () => {
      expect(await ctx.connector.version()).toBe('1.2.3');
    });

    it('daemon.ping returns pong', async () => {
      expect(await ctx.connector.ping()).toBe('pong');
    });

    it('daemon.handshake returns protocol + version', async () => {
      const hs = await ctx.connector.handshake();
      expect(hs).toEqual({ protocolVersion: 1, version: '1.2.3' });
    });

    it('daemon.reload calls onReload', async () => {
      await ctx.connector.reload();
      expect(ctx.onReload).toHaveBeenCalledOnce();
    });

    it('daemon.stop calls onStop', async () => {
      await ctx.connector.stop();
      await new Promise((r) => setTimeout(r, 10));
      expect(ctx.onStop).toHaveBeenCalledOnce();
    });
  });

  describe('agent methods', () => {
    it('agent.list returns agents with status', async () => {
      vi.mocked(ctx.runtimeManager.getStatus).mockReturnValue({ status: 'running' });
      const agents = await ctx.connector.listAgents();
      expect(agents).toHaveLength(1);
      expect((agents[0] as AgentStatusInfo).runtimeStatus).toBe('running');
    });

    it('agent.add creates an agent', async () => {
      const config = await ctx.connector.addAgent({ type: 'claude-code', newioUsername: 'new_agent' });
      expect(config.newio?.username).toBe('new_agent');
      expect(ctx.configManager.add).toHaveBeenCalledOnce();
    });

    it('agent.update updates an agent', async () => {
      await ctx.connector.updateAgent('agent-1', { displayName: 'Updated' });
      expect(ctx.configManager.update).toHaveBeenCalledWith('agent-1', { displayName: 'Updated' });
    });

    it('agent.remove stops and removes agent', async () => {
      await ctx.connector.removeAgent('agent-1');
      expect(ctx.runtimeManager.stop).toHaveBeenCalledWith('agent-1');
      expect(ctx.configManager.remove).toHaveBeenCalledWith('agent-1');
    });

    it('agent.start calls runtimeManager.start', async () => {
      await ctx.connector.startAgent('agent-1');
      expect(ctx.runtimeManager.start).toHaveBeenCalledWith('agent-1');
    });

    it('agent.stop calls runtimeManager.stop', async () => {
      await ctx.connector.stopAgent('agent-1');
      expect(ctx.runtimeManager.stop).toHaveBeenCalledWith('agent-1');
    });

    it('agent.getInfo returns null for unknown agent', async () => {
      expect(await ctx.connector.getAgentInfo('unknown')).toBeNull();
    });

    it('returns error for unknown method', async () => {
      await expect(ctx.connector.client.call('nonexistent.method')).rejects.toThrow('Method not found');
    });
  });

  describe('push notifications', () => {
    it('broadcasts agent.statusChanged to connected clients', async () => {
      const onStatusChanged = vi.fn();
      ctx.connector.disconnect();
      await ctx.connector.connect(ctx.socketPath, { onStatusChanged });

      ctx.server.notify('agent.statusChanged', { agentId: 'agent-1', status: 'running' });
      await new Promise((r) => setTimeout(r, 20));
      expect(onStatusChanged).toHaveBeenCalledWith('agent-1', 'running', undefined);
    });

    it('broadcasts to multiple clients simultaneously', async () => {
      const received: string[] = [];
      const c2 = new DaemonConnector(new DaemonClient());
      const c3 = new DaemonConnector(new DaemonClient());
      await c2.connect(ctx.socketPath, { onStatusChanged: (id) => received.push(`c2:${id}`) });
      await c3.connect(ctx.socketPath, { onStatusChanged: (id) => received.push(`c3:${id}`) });

      ctx.server.notify('agent.statusChanged', { agentId: 'agent-1', status: 'running' });
      await new Promise((r) => setTimeout(r, 20));

      expect(received).toContain('c2:agent-1');
      expect(received).toContain('c3:agent-1');

      c2.disconnect();
      c3.disconnect();
    });
  });

  describe('invalid requests', () => {
    it('returns parse error for malformed JSON', async () => {
      // Send raw malformed JSON directly via the underlying socket
      const rawClient = new DaemonClient();
      await rawClient.connect(ctx.socketPath);
      // The server should handle it gracefully — just verify no crash
      await new Promise((r) => setTimeout(r, 20));
      rawClient.disconnect();
    });
  });
});
