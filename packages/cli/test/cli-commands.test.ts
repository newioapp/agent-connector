import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DaemonServer } from '../src/daemon/server';
import { DaemonHandler } from '../src/daemon/handler';
import { DaemonClient } from '../src/client';
import { DaemonConnector } from '../src/connector';
import {
  parseEnvPairs,
  resolveAgentId,
  firstLine,
  remediationHint,
  agentAdd,
  formatStatus,
  buildAgentTable,
  agentToJson,
  startJson,
} from '../src/cli/agent-commands';
import { daemonLogsHint } from '../src/cli/daemon-commands';
import type { DaemonConnector } from '../src/connector';
import type { AgentConfig, AgentConfigManager, AgentRuntimeManager, AgentStatusInfo } from '@newio/agent-engine';

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

describe('formatStatus', () => {
  function status(wsStatus?: AgentStatusInfo['wsStatus']): AgentStatusInfo {
    return {
      id: 'agent-1',
      config: agent('agent-1', 'alpha'),
      runtimeStatus: 'running',
      ...(wsStatus ? { wsStatus } : {}),
    };
  }

  it('omits healthy WebSocket status', () => {
    expect(formatStatus(status())).toBe('running');
    expect(formatStatus(status('connected'))).toBe('running');
  });

  it('appends degraded WebSocket status', () => {
    expect(formatStatus(status('reconnecting'))).toBe('running · reconnecting');
    expect(formatStatus(status('disconnected'))).toBe('running · disconnected');
  });
});

describe('buildAgentTable', () => {
  function row(opts: {
    id: string;
    username?: string;
    sessionMode?: AgentConfig['sessionMode'];
    cwd?: string;
    runtimeStatus?: AgentStatusInfo['runtimeStatus'];
    error?: string;
    errorCode?: AgentStatusInfo['errorCode'];
  }): AgentStatusInfo {
    const config: AgentConfig = {
      id: opts.id,
      type: 'claude-code',
      newio: { username: opts.username ?? 'alpha' },
      envVars: {},
      acp: { cwd: opts.cwd ?? '/tmp' },
      ...(opts.sessionMode ? { sessionMode: opts.sessionMode } : {}),
    };
    return {
      id: opts.id,
      config,
      runtimeStatus: opts.runtimeStatus ?? 'running',
      ...(opts.error ? { error: opts.error } : {}),
      ...(opts.errorCode ? { errorCode: opts.errorCode } : {}),
    };
  }

  it('reports the empty state when there are no agents', () => {
    expect(buildAgentTable([])).toEqual([expect.stringContaining('No agents configured')]);
  });

  it('shows the fixed columns ending in SESSION-MODE, hiding DESCRIPTION and CWD by default', () => {
    const [header] = buildAgentTable([row({ id: 'aaaa1111-2222' })]);
    expect(header).toMatch(/^ID\s+NAME\s+TYPE\s+USERNAME\s+STATUS\s+SESSION-MODE$/);
    expect(header).not.toContain('DESCRIPTION');
    expect(header).not.toContain('CWD');
  });

  it('shows the effective default chat-shared when sessionMode is unset, and the explicit value otherwise', () => {
    const [, unset, explicit] = buildAgentTable([
      row({ id: 'aaaa1111' }),
      row({ id: 'bbbb2222', sessionMode: 'isolated' }),
    ]);
    expect(unset).toContain('chat-shared');
    expect(explicit).toContain('isolated');
  });

  it('appends DESCRIPTION (the error first line) only with --desc', () => {
    const agents = [row({ id: 'aaaa1111', error: 'node not found\n  at foo()' })];
    expect(buildAgentTable(agents)[0]).not.toContain('DESCRIPTION');
    const [header, dataRow] = buildAgentTable(agents, { desc: true });
    expect(header).toContain('DESCRIPTION');
    expect(dataRow).toContain('node not found');
    expect(dataRow).not.toContain('at foo()');
  });

  it('appends CWD only with --cwd', () => {
    const agents = [row({ id: 'aaaa1111', cwd: '/home/me/project' })];
    expect(buildAgentTable(agents)[0]).not.toContain('CWD');
    const [header, dataRow] = buildAgentTable(agents, { cwd: true });
    expect(header).toContain('CWD');
    expect(dataRow).toContain('/home/me/project');
  });

  it('composes --desc and --cwd, with CWD before DESCRIPTION', () => {
    const [header] = buildAgentTable([row({ id: 'aaaa1111' })], { desc: true, cwd: true });
    expect(header).toContain('DESCRIPTION');
    expect(header).toContain('CWD');
    expect(header.indexOf('CWD')).toBeLessThan(header.indexOf('DESCRIPTION'));
  });

  it('keeps errors visible without --desc via the STATUS cell and the remediation-hint block', () => {
    const lines = buildAgentTable([
      row({
        id: 'aaaa1111-2222-3333-4444-555566667777',
        runtimeStatus: 'error',
        error: 'invalid environment',
        errorCode: 'invalid_environment',
      }),
    ]);
    expect(lines[0]).not.toContain('DESCRIPTION');
    expect(lines[1]).toContain('error');
    expect(lines.some((l) => l.includes('newio agent env edit aaaa1111'))).toBe(true);
  });
});

describe('agentAdd', () => {
  it('rejects a custom agent without --command before touching the daemon', async () => {
    await expect(agentAdd('prod', { type: 'custom', username: 'bob' })).rejects.toThrow(
      'A custom agent requires --command',
    );
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
      apiBaseUrl: 'https://api-v2.newio.app',
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

// ---------------------------------------------------------------------------
// agentToJson — the machine-readable view shared by --json start/list/status
// ---------------------------------------------------------------------------

describe('agentToJson', () => {
  const base: AgentStatusInfo = {
    id: 'aaaa1111-0000-0000-0000-000000000000',
    config: {
      id: 'aaaa1111-0000-0000-0000-000000000000',
      type: 'claude-code',
      newio: { username: 'bot', displayName: 'Bot' },
      sessionMode: 'isolated',
      envVars: {},
      acp: { cwd: '/work' },
    },
    runtimeStatus: 'running',
  };

  it('maps core fields and omits optional fields when absent', () => {
    expect(agentToJson(base)).toEqual({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      username: 'bot',
      displayName: 'Bot',
      type: 'claude-code',
      status: 'running',
      sessionMode: 'isolated',
      cwd: '/work',
    });
  });

  it('defaults sessionMode to chat-shared and nulls missing username/displayName/cwd', () => {
    expect(
      agentToJson({ id: 'x', config: { id: 'x', type: 'codex', envVars: {} }, runtimeStatus: 'stopped' }),
    ).toMatchObject({ username: null, displayName: null, cwd: null, sessionMode: 'chat-shared', status: 'stopped' });
  });

  it('includes approvalUrl while awaiting approval', () => {
    const view = agentToJson({
      ...base,
      runtimeStatus: 'awaiting_approval',
      approvalUrl: 'https://newio.app/agents/approve?code=abc',
    });
    expect(view.status).toBe('awaiting_approval');
    expect(view.approvalUrl).toBe('https://newio.app/agents/approve?code=abc');
  });

  it('surfaces error, errorCode, and the remediation hint on failure', () => {
    const view = agentToJson({
      ...base,
      runtimeStatus: 'error',
      error: 'cwd does not exist',
      errorCode: 'invalid_working_directory',
    });
    expect(view).toMatchObject({
      status: 'error',
      error: 'cwd does not exist',
      errorCode: 'invalid_working_directory',
    });
    expect(view.hint).toContain('newio agent update');
  });

  it('includes wsStatus only when the realtime link is degraded', () => {
    expect(agentToJson(base).wsStatus).toBeUndefined();
    expect(agentToJson({ ...base, wsStatus: 'reconnecting' }).wsStatus).toBe('reconnecting');
  });
});

// ---------------------------------------------------------------------------
// startJson — deterministic output for `agent start --json`
// ---------------------------------------------------------------------------

describe('startJson', () => {
  function info(runtimeStatus: AgentStatusInfo['runtimeStatus'], approvalUrl?: string): AgentStatusInfo {
    return {
      id: 'id-1',
      config: { id: 'id-1', type: 'claude-code', newio: { username: 'bot' }, envVars: {}, acp: { cwd: '/work' } },
      runtimeStatus,
      ...(approvalUrl ? { approvalUrl } : {}),
    };
  }

  it('pins status to awaiting_approval on an approval-triggered early return, even if the record still reads a transient', () => {
    // The daemon emits the URL just before flipping to awaiting_approval, so a
    // non-blocking re-read can catch the record mid-transition at `starting`.
    const view = startJson(info('starting'), { onApproval: true, approvalUrl: 'https://newio.app/approve?c=1' });
    expect(view.status).toBe('awaiting_approval');
    expect(view.approvalUrl).toBe('https://newio.app/approve?c=1');
  });

  it('overrides a missing/stale record approvalUrl with the one seen on the event', () => {
    const view = startJson(info('awaiting_approval'), {
      onApproval: true,
      approvalUrl: 'https://newio.app/approve?c=2',
    });
    expect(view.approvalUrl).toBe('https://newio.app/approve?c=2');
  });

  it('trusts the record on a terminal (non-approval) return', () => {
    const view = startJson(info('running'), { onApproval: false });
    expect(view.status).toBe('running');
    expect(view.approvalUrl).toBeUndefined();
  });

  it('does not inject a stale approvalUrl when the agent reached a terminal state', () => {
    // A URL was seen earlier but the blocking wait ran to `running`: no approvalUrl.
    const view = startJson(info('running'), { onApproval: false, approvalUrl: 'https://newio.app/approve?c=3' });
    expect(view.status).toBe('running');
    expect(view.approvalUrl).toBeUndefined();
  });
});
