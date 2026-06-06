import { describe, it, expect } from 'vitest';
import { buildClaudeAuthCommand, buildClaudeRunCommand, resolveClaudeAcpEntry } from '../src/claude-acp.js';
import { resolveCommand } from '../src/utils.js';
import type { AcpConfig } from '../src/types.js';

describe('claude-acp', () => {
  it('resolves the bundled claude-agent-acp entry', () => {
    const entry = resolveClaudeAcpEntry();
    expect(entry).toMatch(/claude-agent-acp[/\\]dist[/\\]index\.js$/);
  });

  it('builds the ACP runtime command via the current executable as node', () => {
    const cmd = buildClaudeRunCommand();
    expect(cmd.command).toBe(process.execPath);
    expect(cmd.args).toEqual([resolveClaudeAcpEntry()]);
    expect(cmd.env?.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('points claude-agent-acp at the native binary it should exec', () => {
    const cmd = buildClaudeRunCommand();
    // On this machine the platform binary is installed, so it must be wired.
    expect(cmd.env?.CLAUDE_CODE_EXECUTABLE).toMatch(/claude(\.exe)?$/);
  });

  it('builds the subscription login command (--claudeai)', () => {
    const cmd = buildClaudeAuthCommand('subscription');
    expect(cmd.command).toBe(process.execPath);
    expect(cmd.args.slice(1)).toEqual(['--cli', 'auth', 'login', '--claudeai']);
    expect(cmd.env?.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('builds the console login command (--console)', () => {
    const cmd = buildClaudeAuthCommand('console');
    expect(cmd.args.slice(1)).toEqual(['--cli', 'auth', 'login', '--console']);
  });
});

describe('resolveCommand (claude-code)', () => {
  const baseConfig: AcpConfig = { cwd: '/tmp/work' };

  it('defaults to the bundled binary run command', () => {
    const resolved = resolveCommand('claude-code', baseConfig);
    expect(resolved).toEqual(buildClaudeRunCommand());
  });

  it('honors an explicit executablePath override', () => {
    const resolved = resolveCommand('claude-code', {
      ...baseConfig,
      executablePath: '/usr/local/bin/claude-agent-acp',
    });
    expect(resolved.command).toBe('/usr/local/bin/claude-agent-acp');
    expect(resolved.args).toEqual([]);
    expect(resolved.env).toBeUndefined();
  });
});
