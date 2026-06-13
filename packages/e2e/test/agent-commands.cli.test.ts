/**
 * Hermetic CLI integ tests — drive the real `newio` CLI against a sandboxed
 * daemon (DaemonSandbox), with NO backend and NO agent process. Covers the
 * config/daemon/env command surface that doesn't require a running agent, so
 * these are deterministic and CI-runnable (unlike the live e2e specs).
 *
 * Run with: `pnpm --filter @newio/e2e test:cli` (builds the cli first).
 * `agent start`/`restart` and `create-account` need a backend + puppet and live
 * in the *.e2e.test.ts tier.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonSandbox } from '../src/daemon-sandbox.js';

describe('CLI integ (hermetic — no backend)', () => {
  let box: DaemonSandbox;

  beforeAll(async () => {
    box = await DaemonSandbox.start(); // no backend URLs — config/daemon/env only
  });

  afterAll(async () => {
    await box?.stop();
  });

  let counter = 0;
  const uniqueName = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${counter++}`;

  async function addCustom(username: string): Promise<string> {
    const result = await box.cli([
      'agent',
      'add',
      '--type',
      'custom',
      '--username',
      username,
      '--command',
      '/bin/echo',
      '--arg',
      'hi',
    ]);
    const id = /Added agent (\S+) for/.exec(result.stdout)?.[1];
    expect(id, `could not parse agent id from: ${result.stdout}`).toBeTruthy();
    return id as string;
  }

  it('add → list shows the agent → info reports not running → remove', async () => {
    const username = uniqueName('cliadd');
    const id = await addCustom(username);

    const list = await box.cli(['agent', 'list']);
    expect(list.stdout).toContain(username);

    const info = await box.cli(['agent', 'info', id]);
    expect(info.stdout).toMatch(/No runtime info/);

    await box.cli(['agent', 'remove', id]);
    const after = await box.cli(['agent', 'list']);
    expect(after.stdout).not.toContain(username);
  });

  it('env set → list shows the vars → unset removes them', async () => {
    const username = uniqueName('clienv');
    const id = await addCustom(username);

    await box.cli(['agent', 'env', 'set', id, 'FOO=bar', 'BAZ=qux']);
    const listed = await box.cli(['agent', 'env', 'list', id]);
    expect(listed.stdout).toContain('FOO=bar');
    expect(listed.stdout).toContain('BAZ=qux');

    await box.cli(['agent', 'env', 'unset', id, 'FOO']);
    const after = await box.cli(['agent', 'env', 'list', id]);
    expect(after.stdout).not.toContain('FOO=bar');
    expect(after.stdout).toContain('BAZ=qux');

    await box.cli(['agent', 'remove', id]);
  });

  it('update --cwd preserves the structured command/args (regression)', async () => {
    const username = uniqueName('cliupd');
    const id = await addCustom(username);

    await box.cli(['agent', 'update', id, '--cwd', '/new/dir']);

    const config: unknown = JSON.parse(readFileSync(join(box.dataDir, 'agents', id, 'config.json'), 'utf8'));
    const acp = (config as { acp?: Record<string, unknown> }).acp;
    expect(acp).toEqual({ cwd: '/new/dir', command: '/bin/echo', args: ['hi'] });

    await box.cli(['agent', 'remove', id]);
  });

  it('status reports the live daemon online', async () => {
    // `newio status` connects to the daemon socket (live), unlike `daemon status`
    // which reports the launchd/systemd service state (absent for a foreground run).
    const status = await box.runCli(['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/online/i);
  });

  it('daemon status reports the service state (no installed service for a foreground run)', async () => {
    const status = await box.runCli(['daemon', 'status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/newio daemon/i);
  });

  it('rejects a custom agent with no launch override', async () => {
    const result = await box.runCli(['agent', 'add', '--type', 'custom', '--username', uniqueName('clibad')]);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/A custom agent requires --command/);
  });

  it('errors on info for an unknown agent', async () => {
    const result = await box.runCli(['agent', 'info', 'no-such-agent']);
    expect(result.code).not.toBe(0);
  });
});
