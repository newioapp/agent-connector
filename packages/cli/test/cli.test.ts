import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentStatusInfo, AgentConfig } from '@newio/agent-engine';

// ---------------------------------------------------------------------------
// Mock connectOrExit before importing commands
// ---------------------------------------------------------------------------

const mockConnector = vi.hoisted(() => ({
  listAgents: vi.fn(),
  startAgent: vi.fn(),
  stopAgent: vi.fn(),
  reload: vi.fn(),
  version: vi.fn(),
  stop: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../src/cli/utils', () => ({
  connectOrExit: vi.fn().mockResolvedValue(mockConnector),
  resolveAgent: vi.fn((agents: AgentStatusInfo[], name: string) => {
    const found = agents.find(
      (a) => a.id === name || a.config.newio?.displayName === name || a.config.newio?.username === name,
    );
    if (!found) throw new Error(`No agent found matching "${name}"`);
    return found;
  }),
  getDataDir: vi.fn().mockReturnValue('/tmp/newio-test'),
  getSocketPath: vi.fn().mockReturnValue('/tmp/newio-test/daemon.sock'),
  getApiBaseUrl: vi.fn().mockReturnValue('https://api.test.newio.app'),
}));

import { agentCommands } from '../src/cli/agent-cmd';
import { configCommands } from '../src/cli/config-cmd';
import { daemonCommand } from '../src/cli/daemon-cmd';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(id: string, displayName: string, status = 'stopped'): AgentStatusInfo {
  return {
    id,
    config: { id, type: 'kiro-cli', newio: { displayName }, envVars: {}, acp: { cwd: '/tmp' } } as AgentConfig,
    runtimeStatus: status as AgentStatusInfo['runtimeStatus'],
  };
}

function makeProgram(): Command {
  const p = new Command().exitOverride();
  agentCommands(p);
  configCommands(p);
  p.addCommand(daemonCommand());
  return p;
}

async function run(program: Command, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => stdoutLines.push(a.join(' '));
  console.error = (...a) => stderrLines.push(a.join(' '));
  try {
    await program.parseAsync(['node', 'newio', ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLI commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnector.listAgents.mockResolvedValue([]);
    mockConnector.startAgent.mockResolvedValue(undefined);
    mockConnector.stopAgent.mockResolvedValue(undefined);
    mockConnector.reload.mockResolvedValue(undefined);
    mockConnector.version.mockResolvedValue('1.0.0');
    mockConnector.stop.mockResolvedValue(undefined);
    mockConnector.disconnect.mockReturnValue(undefined);
  });

  describe('newio list', () => {
    it('shows "No agents configured" when empty', async () => {
      const { stdout } = await run(makeProgram(), ['list']);
      expect(stdout).toContain('No agents configured');
    });

    it('lists agents with status', async () => {
      mockConnector.listAgents.mockResolvedValue([makeAgent('id-1', 'My Agent', 'running')]);
      const { stdout } = await run(makeProgram(), ['list']);
      expect(stdout).toContain('My Agent');
      expect(stdout).toContain('running');
    });

    it('shows error indicator for errored agents', async () => {
      mockConnector.listAgents.mockResolvedValue([{ ...makeAgent('id-1', 'Broken', 'error'), error: 'crashed' }]);
      const { stdout } = await run(makeProgram(), ['list']);
      expect(stdout).toContain('✗');
      expect(stdout).toContain('crashed');
    });
  });

  describe('newio start', () => {
    it('starts an agent by name', async () => {
      mockConnector.listAgents.mockResolvedValue([makeAgent('id-1', 'My Agent')]);
      await run(makeProgram(), ['start', 'My Agent']);
      expect(mockConnector.startAgent).toHaveBeenCalledWith('id-1');
    });

    it('starts an agent by id', async () => {
      mockConnector.listAgents.mockResolvedValue([makeAgent('id-1', 'My Agent')]);
      await run(makeProgram(), ['start', 'id-1']);
      expect(mockConnector.startAgent).toHaveBeenCalledWith('id-1');
    });
  });

  describe('newio stop', () => {
    it('stops an agent by name', async () => {
      mockConnector.listAgents.mockResolvedValue([makeAgent('id-1', 'My Agent', 'running')]);
      await run(makeProgram(), ['stop', 'My Agent']);
      expect(mockConnector.stopAgent).toHaveBeenCalledWith('id-1');
    });
  });

  describe('newio restart', () => {
    it('stops then starts the agent', async () => {
      mockConnector.listAgents.mockResolvedValue([makeAgent('id-1', 'My Agent', 'running')]);
      await run(makeProgram(), ['restart', 'My Agent']);
      expect(mockConnector.stopAgent).toHaveBeenCalledWith('id-1');
      expect(mockConnector.startAgent).toHaveBeenCalledWith('id-1');
    });
  });

  describe('newio reload', () => {
    it('calls connector.reload', async () => {
      await run(makeProgram(), ['reload']);
      expect(mockConnector.reload).toHaveBeenCalledOnce();
    });
  });

  describe('newio config path', () => {
    it('prints the config path', async () => {
      const { stdout } = await run(makeProgram(), ['config', 'path']);
      expect(stdout).toContain('config.json');
    });
  });

  describe('newio daemon stop', () => {
    it('calls connector.stop', async () => {
      await run(makeProgram(), ['daemon', 'stop']);
      expect(mockConnector.stop).toHaveBeenCalledOnce();
    });
  });
});
