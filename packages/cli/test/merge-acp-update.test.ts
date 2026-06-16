import { describe, it, expect } from 'vitest';
import { mergeAcpUpdate, hasLaunchOverride } from '../src/cli/agent-commands';
import type { AcpConfig } from '@newio/agent-engine';

const structured: AcpConfig = { cwd: '/old', command: '/usr/bin/node', args: ['/bin.js', '--flag'] };

describe('mergeAcpUpdate', () => {
  it('preserves structured command + args when only --cwd changes (the data-loss bug)', () => {
    expect(mergeAcpUpdate({ cwd: '/new' }, structured)).toEqual({
      cwd: '/new',
      command: '/usr/bin/node',
      args: ['/bin.js', '--flag'],
    });
  });

  it('preserves a legacy executablePath when only --cwd changes', () => {
    const existing: AcpConfig = { cwd: '/old', executablePath: 'node wrapper.js' };
    expect(mergeAcpUpdate({ cwd: '/new' }, existing)).toEqual({ cwd: '/new', executablePath: 'node wrapper.js' });
  });

  it('a new --command/--arg replaces the prior launch config', () => {
    expect(mergeAcpUpdate({ command: '/other/agent', arg: ['acp'] }, structured)).toEqual({
      cwd: '/old',
      command: '/other/agent',
      args: ['acp'],
    });
  });

  it('carries kiroCliTrustAllTools forward', () => {
    const existing: AcpConfig = { cwd: '/old', command: '/c', args: [], kiroCliTrustAllTools: false };
    expect(mergeAcpUpdate({ cwd: '/new' }, existing)).toEqual({
      cwd: '/new',
      command: '/c',
      args: [],
      kiroCliTrustAllTools: false,
    });
  });
});

describe('hasLaunchOverride', () => {
  it('detects --command, ignores empty', () => {
    expect(hasLaunchOverride({ command: '/c' })).toBe(true);
    expect(hasLaunchOverride({})).toBe(false);
    expect(hasLaunchOverride({ command: '' })).toBe(false);
  });
});
