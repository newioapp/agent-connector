import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { commandPathOf, shouldEnforceVersionGate } from '../src/cli/version-gate';

/** Build a `newio <path...>` command tree and return the leaf command. */
function leaf(...path: string[]): Command {
  const root = new Command('newio');
  let parent = root;
  let current = root;
  for (const name of path) {
    current = new Command(name);
    parent.addCommand(current);
    parent = current;
  }
  return current;
}

describe('commandPathOf', () => {
  it('joins the subcommand path, excluding the root program name', () => {
    expect(commandPathOf(leaf('daemon', 'stop'))).toBe('daemon stop');
    expect(commandPathOf(leaf('agent', 'start'))).toBe('agent start');
    expect(commandPathOf(leaf('update'))).toBe('update');
  });

  it('returns an empty string for the root program itself', () => {
    expect(commandPathOf(new Command('newio'))).toBe('');
  });
});

describe('shouldEnforceVersionGate', () => {
  it('skips the gate for the updater, the internal bridge, and daemon manage/inspect verbs', () => {
    for (const path of [
      'update',
      'mcp-bridge',
      'daemon stop',
      'daemon status',
      'daemon logs',
      'daemon uninstall',
      'daemon reload',
    ]) {
      expect(shouldEnforceVersionGate(path)).toBe(false);
    }
  });

  it('gates commands that start work or interact with the daemon', () => {
    for (const path of [
      'daemon start',
      'daemon run',
      'daemon restart',
      'agent add',
      'agent start',
      'status',
      'env print',
    ]) {
      expect(shouldEnforceVersionGate(path)).toBe(true);
    }
  });
});
