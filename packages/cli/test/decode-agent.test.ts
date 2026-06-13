import { describe, it, expect } from 'vitest';
import { decodeAddAgentInput, decodeUpdateAgentInput } from '../src/daemon/decode-agent';

describe('decodeAddAgentInput — acp launch config', () => {
  it('decodes the path-safe command + args, preserving spaces', () => {
    const input = decodeAddAgentInput({
      type: 'custom',
      newioUsername: 'bob',
      acp: { cwd: '/tmp', command: '/Users/Jane Doe/node', args: ['/Users/Jane Doe/bin.js', '--flag x'] },
    });
    expect(input.acp).toEqual({
      cwd: '/tmp',
      command: '/Users/Jane Doe/node',
      args: ['/Users/Jane Doe/bin.js', '--flag x'],
    });
  });

  it('decodes the legacy executablePath', () => {
    const input = decodeAddAgentInput({
      type: 'custom',
      newioUsername: 'bob',
      acp: { cwd: '/tmp', executablePath: 'node wrapper.js' },
    });
    expect(input.acp).toEqual({ cwd: '/tmp', executablePath: 'node wrapper.js' });
  });

  it('rejects a non-array args', () => {
    expect(() =>
      decodeAddAgentInput({ type: 'custom', newioUsername: 'bob', acp: { cwd: '/tmp', args: 'nope' } }),
    ).toThrow(/Expected args to be an array/);
  });

  it('rejects a non-string arg element', () => {
    expect(() =>
      decodeAddAgentInput({ type: 'custom', newioUsername: 'bob', acp: { cwd: '/tmp', args: ['ok', 3] } }),
    ).toThrow(/Expected args\[1\] to be a string/);
  });
});

describe('decodeUpdateAgentInput — acp launch config', () => {
  it('decodes command + args on update too', () => {
    const updates = decodeUpdateAgentInput({ acp: { cwd: '/tmp', command: '/bin/agent', args: ['acp'] } });
    expect(updates.acp).toEqual({ cwd: '/tmp', command: '/bin/agent', args: ['acp'] });
  });
});
