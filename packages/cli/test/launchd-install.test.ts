import { describe, it, expect, vi, beforeEach } from 'vitest';

// Record every launchctl invocation so we can assert install/start behavior
// without touching the real launchd or filesystem.
const execCalls: string[][] = [];

vi.mock('child_process', () => ({
  execFileSync: (cmd: string, args: string[]) => {
    execCalls.push([cmd, ...args]);
    return '';
  },
}));

vi.mock('fs', () => ({
  existsSync: () => true,
  mkdirSync: () => undefined,
  writeFileSync: () => undefined,
  unlinkSync: () => undefined,
  readFileSync: () => '',
}));

import { LaunchdServiceManager } from '../src/service/launchd';
import type { InstallOptions } from '../src/service/types';

const baseOpts: InstallOptions = {
  programArguments: ['/Users/nan/.newio/bin/newio', 'daemon', 'run'],
  env: { NEWIO_STAGE: 'prod' },
  logPath: '/Users/nan/.newio/connector/daemon.log',
  enable: true,
};

function subcommands(): string[] {
  // launchctl subcommand is execCalls[i][1] (argv: ['launchctl', '<sub>', ...]).
  return execCalls.filter((c) => c[0] === 'launchctl').map((c) => c[1] ?? '');
}

describe('LaunchdServiceManager.install', () => {
  beforeEach(() => {
    execCalls.length = 0;
  });

  it('starts via kickstart on a --no-enable install (RunAtLoad=false would not launch it)', () => {
    new LaunchdServiceManager('prod').install({ ...baseOpts, enable: false });
    // bootstrap loads the plist; with RunAtLoad off it must be kickstarted too.
    expect(subcommands()).toContain('bootstrap');
    expect(subcommands()).toContain('kickstart');
  });

  it('does not kickstart when enabled (RunAtLoad launches it on bootstrap)', () => {
    new LaunchdServiceManager('prod').install({ ...baseOpts, enable: true });
    expect(subcommands()).toContain('bootstrap');
    expect(subcommands()).not.toContain('kickstart');
  });
});
