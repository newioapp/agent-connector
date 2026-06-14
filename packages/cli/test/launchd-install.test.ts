import { describe, it, expect, vi, beforeEach } from 'vitest';

// Configurable stand-ins for the OS calls LaunchdServiceManager makes, so we can
// drive install/status behavior without touching the real launchd or filesystem.
// vi.hoisted lets the (hoisted) vi.mock factories below close over them safely.
const h = vi.hoisted(() => ({
  /** Every launchctl invocation, as [cmd, ...args]. */
  execCalls: [] as string[][],
  /** `launchctl` output; throw to simulate an unloaded label (`list` fails). */
  execImpl: (() => '') as (cmd: string, args: string[]) => string,
  /** Whether the plist exists on disk (drives isInstalled). */
  existsImpl: (() => true) as () => boolean,
  /** Plist file contents (drives RunAtLoad detection in status). */
  readFileImpl: (() => '') as () => string,
}));

vi.mock('child_process', () => ({
  execFileSync: (cmd: string, args: string[]) => {
    h.execCalls.push([cmd, ...args]);
    return h.execImpl(cmd, args);
  },
}));

vi.mock('fs', () => ({
  existsSync: () => h.existsImpl(),
  mkdirSync: () => undefined,
  writeFileSync: () => undefined,
  unlinkSync: () => undefined,
  readFileSync: () => h.readFileImpl(),
}));

import { LaunchdServiceManager } from '../src/service/launchd';
import type { InstallOptions } from '../src/service/types';

const baseOpts: InstallOptions = {
  programArguments: ['/Users/nan/.newio/bin/newio', 'daemon', 'run'],
  env: { NEWIO_STAGE: 'prod' },
  logPath: '/Users/nan/.newio/connector/daemon.log',
  enable: true,
};

const PLIST_RUN_AT_LOAD = '<key>RunAtLoad</key>\n  <true/>';
const PLIST_NO_RUN_AT_LOAD = '<key>RunAtLoad</key>\n  <false/>';

function launchctlSubcommands(): string[] {
  // argv is ['launchctl', '<sub>', ...]; the subcommand is index 1.
  return h.execCalls.filter((c) => c[0] === 'launchctl').map((c) => c[1] ?? '');
}

describe('LaunchdServiceManager.install', () => {
  beforeEach(() => {
    h.execCalls.length = 0;
    h.execImpl = () => '';
    h.existsImpl = () => true;
    h.readFileImpl = () => '';
  });

  it('starts via kickstart on a --no-enable install (RunAtLoad=false would not launch it)', () => {
    new LaunchdServiceManager('prod').install({ ...baseOpts, enable: false });
    // bootstrap loads the plist; with RunAtLoad off it must be kickstarted too.
    expect(launchctlSubcommands()).toContain('bootstrap');
    expect(launchctlSubcommands()).toContain('kickstart');
  });

  it('does not kickstart when enabled (RunAtLoad launches it on bootstrap)', () => {
    new LaunchdServiceManager('prod').install({ ...baseOpts, enable: true });
    expect(launchctlSubcommands()).toContain('bootstrap');
    expect(launchctlSubcommands()).not.toContain('kickstart');
  });
});

describe('LaunchdServiceManager.status', () => {
  beforeEach(() => {
    h.execCalls.length = 0;
    h.execImpl = () => '';
    h.existsImpl = () => true;
    h.readFileImpl = () => '';
  });

  it('reports not-installed when no plist is on disk', () => {
    h.existsImpl = () => false;
    expect(new LaunchdServiceManager('prod').status()).toEqual({ state: 'not-installed' });
  });

  it('reports running with the pid when the label is loaded with a PID', () => {
    h.readFileImpl = () => PLIST_RUN_AT_LOAD;
    h.execImpl = () => '{\n\t"PID" = 4321;\n\t"Label" = "app.newio.connectord";\n};';
    expect(new LaunchdServiceManager('prod').status()).toEqual({ state: 'running', pid: 4321, enabled: true });
  });

  it('reports stopped (loaded, no PID) with enabled following RunAtLoad', () => {
    h.readFileImpl = () => PLIST_NO_RUN_AT_LOAD; // a --no-enable install
    h.execImpl = () => '{\n\t"Label" = "app.newio.connectord";\n};'; // loaded, not running
    expect(new LaunchdServiceManager('prod').status()).toEqual({ state: 'stopped', enabled: false });
  });

  it('keeps enabled from RunAtLoad even when the plist is on disk but not loaded', () => {
    // `launchctl list` throws for an unloaded label, but a LaunchAgent with
    // RunAtLoad=true still starts at next login, so enabled must stay true.
    h.readFileImpl = () => PLIST_RUN_AT_LOAD;
    h.execImpl = () => {
      throw new Error('Could not find service');
    };
    expect(new LaunchdServiceManager('prod').status()).toEqual({ state: 'stopped', enabled: true });
  });
});
