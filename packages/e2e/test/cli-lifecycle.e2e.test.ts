/**
 * Backend CLI tier — the CLI commands that need a live backend (and, for the
 * runtime ones, the puppet): agent stop/restart lifecycle and the real
 * `create-account` register → owner-approves → poll handshake.
 *
 * The config/daemon/env command surface is covered hermetically in
 * agent-commands.cli.test.ts; these need the dev backend, so they run only via
 * the e2e config. Run with `pnpm --filter @newio/e2e test:e2e` — requires
 * NEWIO_API_URL / NEWIO_WS_URL (see packages/e2e/.env.example).
 *
 * Note: `resolveBackendUrls()` is called inside `beforeAll`/`it` (never at module
 * or describe-body scope), which run only on execution — so a missing .env surfaces
 * as a failing test rather than a collection-time error for the whole file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { PuppetDriver } from '@newio/acp-puppet';
import { startPuppetAgent } from '../src/puppet-agent.js';
import { DaemonSandbox, newioCliEntry } from '../src/daemon-sandbox.js';
import { OwnerBackend, type AgentCredentials } from '../src/backend.js';
import { resolveBackendUrls } from '../src/config.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `produce()` until it returns a truthy value, or time out. */
async function waitFor<T>(produce: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = produce();
    if (value) {
      return value;
    }
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

describe('agent lifecycle via the CLI (stop / restart)', () => {
  let agent: AgentCredentials;
  let driver: PuppetDriver;
  let sandbox: DaemonSandbox;
  let agentConfigId: string;

  beforeAll(async () => {
    const urls = resolveBackendUrls();
    const backend = new OwnerBackend(urls.apiBaseUrl);
    const owner = await backend.createOwner();
    agent = await backend.createApprovedAgent(owner);
    driver = await PuppetDriver.start();
    driver.onPrompt(() => 'ok');
    sandbox = await DaemonSandbox.start({ apiBaseUrl: urls.apiBaseUrl, wsUrl: urls.wsUrl });
    agentConfigId = await startPuppetAgent(sandbox, { agent, driver });
  });

  afterAll(async () => {
    await sandbox?.stop();
    await driver?.stop();
  });

  it('stop leaves the agent stopped; restart brings it back to running', async () => {
    const id = agentConfigId;

    const stopped = await sandbox.runCli(['agent', 'stop', id]);
    expect(stopped.code).toBe(0);

    // Target this agent's specific row (by username) — not a bare /stopped/ match
    // that any stopped agent could satisfy once the fixture grows.
    const list = await sandbox.runCli(['agent', 'list']);
    const row = list.stdout.split('\n').find((line) => line.includes(agent.username));
    expect(row, `agent @${agent.username} not found in:\n${list.stdout}`).toBeDefined();
    expect(row).toMatch(/stopped/i);

    // `agent restart` stops then streams status until terminal — expect running.
    const restarted = await sandbox.runCli(['agent', 'restart', id], 90_000);
    const statuses = restarted.stdout.split('\n').map((line) => line.trim());
    expect(statuses).toContain('running');
  });
});

describe('agent create-account (register → owner approves → poll)', () => {
  it('completes the approval handshake and reports the account created', async () => {
    const urls = resolveBackendUrls();
    const backend = new OwnerBackend(urls.apiBaseUrl);
    const owner = await backend.createOwner();
    const username = `cliacct_${Date.now().toString(36)}`;

    // create-account is standalone (no daemon): it registers, prints the approval
    // URL, and polls until approved. Needs the backend URL + stage in its env.
    const child = spawn(process.execPath, [newioCliEntry(), 'agent', 'create-account', '--name', 'E2E CLI Account'], {
      env: { ...process.env, NEWIO_API_URL: urls.apiBaseUrl, NEWIO_STAGE: 'dev' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      out += c.toString();
    });

    try {
      // Wait for the approval URL the CLI prints, then approve as the owner.
      const url = await waitFor(() => /https?:\/\/\S*\/agents\/approve\?\S+/.exec(out)?.[0], 30_000);
      const params = new URL(url).searchParams;
      const approvalId = params.get('approvalId');
      const token = params.get('token');
      expect(approvalId, `approvalId missing from URL: ${url}`).toBeTruthy();
      expect(token, `token missing from URL: ${url}`).toBeTruthy();

      await backend.approvePendingAgent(owner, approvalId as string, token as string, username);

      // Wait for the CLI's poll to detect approval and report success. We assert
      // on the output, not a clean exit: `create-account` currently keeps a handle
      // open and doesn't exit on its own after success (a CLI hygiene issue — it
      // logically completes here), so the `finally` kills the lingering process.
      await waitFor(() => (out.includes('Account created') ? out : undefined), 40_000);
      expect(out).toContain('Account created');
      expect(out).toContain(username);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  });
});
