import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DaemonServer } from '../src/daemon/server';
import { DaemonHandler } from '../src/daemon/handler';
import { DaemonClient } from '../src/client';
import { DaemonConnector } from '../src/connector';
import { parseEnvPairs, resolveAgentId, firstLine, remediationHint, agentAdd } from '../src/cli/agent-commands';
import { daemonLogsHint } from '../src/cli/daemon-commands';
import type { DaemonConnector } from '../src/connector';
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

describe('daemonLogsHint', () => {
  it('omits the prefix when the command name already implies the installed stage', () => {
    expect(daemonLogsHint('prod', 'newio')).toBe('newio daemon logs -f');
    expect(daemonLogsHint('dev', 'newio-dev')).toBe('newio-dev daemon logs -f');
    expect(daemonLogsHint('integ', 'newio-integ')).toBe('newio-integ daemon logs -f');
  });

  it('prefixes NEWIO_STAGE when the prod binary drives a non-prod stage', () => {
    expect(daemonLogsHint('dev', 'newio')).toBe('NEWIO_STAGE=dev newio daemon logs -f');
    expect(daemonLogsHint('integ', 'newio')).toBe('NEWIO_STAGE=integ newio daemon logs -f');
  });

  it('prefixes NEWIO_STAGE when a stage-named binary drives a different stage', () => {
    // Without the prefix, `newio-dev daemon logs` would resolve back to dev,
    // not the prod daemon that was just installed.
    expect(daemonLogsHint('prod', 'newio-dev')).toBe('NEWIO_STAGE=prod newio-dev daemon logs -f');
    expect(daemonLogsHint('integ', 'newio-dev')).toBe('NEWIO_STAGE=integ newio-dev daemon logs -f');
  });
});

describe('firstLine', () => {
  it('returns the message unchanged when single-line', () => {
    expect(firstLine('boom')).toBe('boom');
  });

  it('trims to the first line for multi-line messages (e.g. a stack trace)', () => {
    expect(firstLine('node not found\n\n  at foo()\n  at bar()')).toBe('node not found');
  });
});

describe('remediationHint', () => {
  it('points an invalid-environment failure at `agent env edit`', () => {
    const hint = remediationHint('invalid_environment', 'aaaa1111-2222-3333-4444-555566667777');
    expect(hint).toContain('newio agent env edit aaaa1111');
  });

  it('returns undefined for an unknown/absent error code', () => {
    expect(remediationHint(undefined, 'aaaa1111')).toBeUndefined();
  });
});

describe('agentAdd', () => {
  it('rejects a custom agent with no --exec before touching the daemon', async () => {
    await expect(agentAdd('prod', { type: 'custom', username: 'bob' })).rejects.toThrow('custom agent requires --exec');
  });
});

// ---------------------------------------------------------------------------
// resolveAgentId against a real connector + mock daemon
// ---------------------------------------------------------------------------

function agent(id: string, username: string): AgentConfig {
  return { id, type: 'claude-code', newio: { username }, envVars: {}, acp: { cwd: '/tmp' } };
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
    getApprovalUrl: vi.fn().mockReturnValue(undefined),
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
        agent('aaaa1111-0000-0000-0000-000000000000', 'alpha'),
        agent('aaaa2222-0000-0000-0000-000000000000', 'beta'),
        agent('bbbb3333-0000-0000-0000-000000000000', 'gamma'),
        // Two configs sharing a username — resolving by that username is ambiguous.
        agent('cccc4444-0000-0000-0000-000000000000', 'dupe'),
        agent('dddd5555-0000-0000-0000-000000000000', 'dupe'),
      ]),
      agentRuntimeManager: mockRuntimeManager(),
      version: '1.0.0',
      stage: 'prod',
      apiBaseUrl: 'https://api.newio.app',
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

  it('matches by username, case-insensitively', async () => {
    expect(await resolveAgentId(connector, 'Gamma')).toBe('bbbb3333-0000-0000-0000-000000000000');
  });

  it('throws when a username is shared by multiple configs', async () => {
    await expect(resolveAgentId(connector, 'dupe')).rejects.toThrow('used by 2 configs');
  });

  it('throws when nothing matches', async () => {
    await expect(resolveAgentId(connector, 'nope')).rejects.toThrow('No agent matching');
  });
});
