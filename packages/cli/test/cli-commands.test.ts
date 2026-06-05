import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DaemonServer } from '../src/daemon/server';
import { DaemonHandler } from '../src/daemon/handler';
import { DaemonClient } from '../src/client';
import { DaemonConnector } from '../src/connector';
import { parseEnvPairs, resolveAgentId } from '../src/cli/agent-commands';
import type { AgentConfig, AgentConfigManager, AgentRuntimeManager } from '@newio/agent-engine';

describe('parseEnvPairs', () => {
  it('parses KEY=VALUE pairs (values may contain =)', () => {
    expect(parseEnvPairs(['A=1', 'B=x=y'])).toEqual({ A: '1', B: 'x=y' });
  });

  it('rejects malformed pairs', () => {
    expect(() => parseEnvPairs(['NOEQUALS'])).toThrow('Invalid KEY=VALUE');
    expect(() => parseEnvPairs(['=novalue'])).toThrow('Invalid KEY=VALUE');
  });
});

// ---------------------------------------------------------------------------
// resolveAgentId against a real connector + mock daemon
// ---------------------------------------------------------------------------

function agent(id: string, displayName: string): AgentConfig {
  return { id, type: 'claude-code', newio: { displayName }, envVars: {}, acp: { cwd: '/tmp' } };
}

function mockConfigManager(configs: AgentConfig[]): AgentConfigManager {
  const map = new Map(configs.map((c) => [c.id, c]));
  return {
    list: () => [...map.values()],
    get: (id) => map.get(id),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
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

describe('resolveAgentId', () => {
  let server: DaemonServer;
  let connector: DaemonConnector;

  beforeEach(async () => {
    const socketPath = join(tmpdir(), `newio-cli-${randomUUID()}.sock`);
    const handler = new DaemonHandler({
      agentConfigManager: mockConfigManager([
        agent('aaaa1111-0000-0000-0000-000000000000', 'Alpha'),
        agent('aaaa2222-0000-0000-0000-000000000000', 'Beta'),
        agent('bbbb3333-0000-0000-0000-000000000000', 'Gamma'),
      ]),
      agentRuntimeManager: mockRuntimeManager(),
      version: '1.0.0',
      onReload: vi.fn().mockResolvedValue(undefined),
      onStop: vi.fn().mockResolvedValue(undefined),
    });
    server = new DaemonServer(handler);
    await server.listen(socketPath);
    connector = new DaemonConnector(new DaemonClient());
    await connector.connect(socketPath);
  });

  afterEach(async () => {
    connector.disconnect();
    await server.close();
  });

  it('matches by exact id', async () => {
    expect(await resolveAgentId(connector, 'aaaa1111-0000-0000-0000-000000000000')).toBe(
      'aaaa1111-0000-0000-0000-000000000000',
    );
  });

  it('matches by unique id prefix', async () => {
    expect(await resolveAgentId(connector, 'bbbb')).toBe('bbbb3333-0000-0000-0000-000000000000');
  });

  it('throws on an ambiguous prefix', async () => {
    await expect(resolveAgentId(connector, 'aaaa')).rejects.toThrow('Ambiguous');
  });

  it('matches by exact display name', async () => {
    expect(await resolveAgentId(connector, 'Gamma')).toBe('bbbb3333-0000-0000-0000-000000000000');
  });

  it('throws when nothing matches', async () => {
    await expect(resolveAgentId(connector, 'nope')).rejects.toThrow('No agent matching');
  });
});
