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

  it('add many → list → remove two → list → add one → list → remove all', async () => {
    // Add three agents.
    const a = { name: uniqueName('cliadd'), id: '' };
    const b = { name: uniqueName('cliadd'), id: '' };
    const c = { name: uniqueName('cliadd'), id: '' };
    a.id = await addCustom(a.name);
    b.id = await addCustom(b.name);
    c.id = await addCustom(c.name);

    // List shows all three.
    const list1 = await box.cli(['agent', 'list']);
    expect(list1.stdout).toContain(a.name);
    expect(list1.stdout).toContain(b.name);
    expect(list1.stdout).toContain(c.name);

    // None are running yet.
    const info = await box.cli(['agent', 'info', a.id]);
    expect(info.stdout).toMatch(/No runtime info/);

    // Remove two (a and c), keep b.
    await box.cli(['agent', 'remove', a.id]);
    await box.cli(['agent', 'remove', c.id]);

    const list2 = await box.cli(['agent', 'list']);
    expect(list2.stdout).not.toContain(a.name);
    expect(list2.stdout).not.toContain(c.name);
    expect(list2.stdout).toContain(b.name);

    // Add one more.
    const d = { name: uniqueName('cliadd'), id: '' };
    d.id = await addCustom(d.name);

    const list3 = await box.cli(['agent', 'list']);
    expect(list3.stdout).toContain(b.name);
    expect(list3.stdout).toContain(d.name);
    expect(list3.stdout).not.toContain(a.name);
    expect(list3.stdout).not.toContain(c.name);

    // Remove the rest.
    await box.cli(['agent', 'remove', b.id]);
    await box.cli(['agent', 'remove', d.id]);

    const list4 = await box.cli(['agent', 'list']);
    expect(list4.stdout).not.toContain(b.name);
    expect(list4.stdout).not.toContain(d.name);
  });

  it('env set → list shows the vars → unset removes them', async () => {
    const username = uniqueName('clienv');
    const id = await addCustom(username);

    // `agent add` syncs an allowlist of shell vars (HOME/PATH/USER/…), so the env
    // isn't empty — but the keys we're about to set must not be present yet.
    const before = await box.cli(['agent', 'env', 'list', id]);
    expect(before.stdout).not.toContain('FOO=bar');
    expect(before.stdout).not.toContain('BAZ=qux');

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

    const readAcp = (): Record<string, unknown> | undefined => {
      const config: unknown = JSON.parse(readFileSync(join(box.dataDir, 'agents', id, 'config.json'), 'utf8'));
      return (config as { acp?: Record<string, unknown> }).acp;
    };

    // With no --cwd on `add`, the agent's cwd defaults to the cwd of the process
    // that ran the CLI — which, since runCli() spawns without a cwd override, is
    // this test runner's own working directory.
    expect(readAcp()).toEqual({ cwd: process.cwd(), command: '/bin/echo', args: ['hi'] });

    await box.cli(['agent', 'update', id, '--cwd', '/new/dir']);

    expect(readAcp()).toEqual({ cwd: '/new/dir', command: '/bin/echo', args: ['hi'] });

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

  it('rejects the removed --exec flag (superseded by --command/--arg)', async () => {
    const result = await box.runCli([
      'agent',
      'add',
      '--type',
      'custom',
      '--username',
      uniqueName('cliexec'),
      '--exec',
      '/bin/echo hi',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/unknown option.*--exec/);
  });

  it('rejects the removed --session-mode flag', async () => {
    const result = await box.runCli([
      'agent',
      'add',
      '--type',
      'custom',
      '--username',
      uniqueName('clismode'),
      '--command',
      '/bin/echo',
      '--session-mode',
      'shared',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/unknown option.*--session-mode/);
  });

  it('does not write a sessionMode into the config — the agent takes the chat-shared default', async () => {
    const username = uniqueName('clidefmode');
    const id = await addCustom(username);

    const config: unknown = JSON.parse(readFileSync(join(box.dataDir, 'agents', id, 'config.json'), 'utf8'));
    // The CLI no longer sets a session mode; the engine resolves an absent mode to
    // chat-shared at runtime, so the persisted config carries no sessionMode field.
    expect(config).not.toHaveProperty('sessionMode');

    await box.cli(['agent', 'remove', id]);
  });

  it('errors on info for an unknown agent', async () => {
    const result = await box.runCli(['agent', 'info', 'no-such-agent']);
    expect(result.code).not.toBe(0);
  });
});
