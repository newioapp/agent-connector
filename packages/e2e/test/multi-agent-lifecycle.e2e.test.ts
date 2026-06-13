/**
 * Multi-agent lifecycle at scale over the real daemon.
 *
 * One daemon, driven entirely through the CLI the way a user with a fleet does:
 *   - 5 real approved agents, each given 3 runner configs → 15 configs across 5
 *     unique usernames (`agent add`, no start);
 *   - 4 of those configs (4 distinct agents) brought online to `running`;
 *   - `agent list` shows the whole fleet with the right per-agent status, and
 *     `agent info` reports runtime info for a running agent but not a stopped one;
 *   - stop one running agent (the others are unaffected), then restart it.
 *
 * Every config is attached to a real backend account, so any of them *could* be
 * started — the 11 left `stopped` are a realistic "configured but not running"
 * state, not placeholder identities. This is the full-stack, fleet-sized
 * counterpart to the single-agent `cli-lifecycle.e2e.test.ts`.
 *
 * Run with: `pnpm --filter @newio/e2e test:e2e` — requires NEWIO_API_URL /
 * NEWIO_WS_URL (see packages/e2e/.env.example).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PuppetDriver } from '@newio/acp-puppet';
import { DaemonSandbox } from '../src/daemon-sandbox.js';
import { addPuppetAgent, startAddedAgent } from '../src/puppet-agent.js';
import { OwnerBackend, type AgentCredentials } from '../src/backend.js';
import { resolveBackendUrls } from '../src/config.js';

interface FleetConfig {
  readonly id: string;
  readonly accountIndex: number;
  started: boolean;
}

describe('multi-agent fleet via the CLI (add many / start several / list / info / stop / restart)', () => {
  const urls = resolveBackendUrls();
  const backend = new OwnerBackend(urls.apiBaseUrl);

  const ACCOUNTS = 5; // 5 unique usernames
  const CONFIGS_PER_ACCOUNT = 3; // 5 × 3 = 15 configs
  const TOTAL = ACCOUNTS * CONFIGS_PER_ACCOUNT;
  const STARTED = 4;

  let sandbox: DaemonSandbox;
  const agents: AgentCredentials[] = [];
  const drivers: PuppetDriver[] = [];
  const configs: FleetConfig[] = [];

  beforeAll(async () => {
    const owner = await backend.createOwner();
    sandbox = await DaemonSandbox.start({ apiBaseUrl: urls.apiBaseUrl, wsUrl: urls.wsUrl });

    // 5 real approved agents (5 unique usernames), each with its own puppet driver.
    for (let i = 0; i < ACCOUNTS; i += 1) {
      const agent = await backend.createApprovedAgent(owner, `E2E Fleet ${i}`);
      const driver = await PuppetDriver.start();
      driver.onPrompt(() => 'ok');
      agents.push(agent);
      drivers.push(driver);
    }

    // 15 configs: 3 per account, all added (no start yet) → all stopped.
    for (let i = 0; i < ACCOUNTS; i += 1) {
      for (let c = 0; c < CONFIGS_PER_ACCOUNT; c += 1) {
        const id = await addPuppetAgent(sandbox, { username: agents[i]!.username, driver: drivers[i]! });
        configs.push({ id, accountIndex: i, started: false });
      }
    }

    // Start 4 of them — the first config of 4 distinct accounts → running.
    for (let i = 0; i < STARTED; i += 1) {
      const cfg = configs.find((c) => c.accountIndex === i && !c.started)!;
      await startAddedAgent(sandbox, cfg.id, { agent: agents[i]!, driver: drivers[i]! });
      cfg.started = true;
    }
  }, 240_000);

  afterAll(async () => {
    await sandbox?.stop();
    await Promise.all(drivers.map((d) => d.stop()));
  });

  const startedConfigs = (): FleetConfig[] => configs.filter((c) => c.started);
  const stoppedConfigs = (): FleetConfig[] => configs.filter((c) => !c.started);

  it('lists the whole fleet: 4 started agents running, the other 11 configs stopped', async () => {
    const list = await sandbox.cli(['agent', 'list']);

    expect(countLines(list.stdout, /\brunning\b/i)).toBe(STARTED);
    expect(countLines(list.stdout, /\bstopped\b/i)).toBe(TOTAL - STARTED);

    for (const cfg of startedConfigs()) {
      expect(rowFor(list.stdout, cfg.id), `no row for ${cfg.id} in:\n${list.stdout}`).toMatch(/\brunning\b/i);
    }
    for (const cfg of stoppedConfigs()) {
      expect(rowFor(list.stdout, cfg.id)).toMatch(/\bstopped\b/i);
    }
  });

  it('reports per-agent runtime status via `agent info`', async () => {
    // A running agent has runtime info…
    const running = await sandbox.cli(['agent', 'info', startedConfigs()[0]!.id]);
    expect(running.stdout).not.toMatch(/No runtime info/);

    // …a configured-but-stopped one does not.
    const stopped = await sandbox.cli(['agent', 'info', stoppedConfigs()[0]!.id]);
    expect(stopped.stdout).toMatch(/No runtime info/);
  });

  it('refuses to start a second config for a username already running', async () => {
    // Account 0 has one running config plus two stopped configs sharing its username.
    const running = configs.find((c) => c.accountIndex === 0 && c.started)!;
    const sibling = configs.find((c) => c.accountIndex === 0 && !c.started)!;

    // Precondition: the primary config really is running right now.
    const before = await sandbox.cli(['agent', 'list']);
    expect(rowFor(before.stdout, running.id)).toMatch(/\brunning\b/i);

    // Starting the same-username sibling is rejected by the runtime guard.
    const result = await sandbox.runCli(['agent', 'start', sibling.id], 90_000);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/already running with username/i);

    // The guard rejected the newcomer rather than swapping: sibling still stopped,
    // the original still running.
    const after = await sandbox.cli(['agent', 'list']);
    expect(rowFor(after.stdout, sibling.id)).toMatch(/\bstopped\b/i);
    expect(rowFor(after.stdout, running.id)).toMatch(/\brunning\b/i);
  });

  it('stops one running agent without affecting the others, then restarts it', async () => {
    const target = startedConfigs()[0]!;
    const others = startedConfigs().filter((c) => c.id !== target.id);

    const stopped = await sandbox.cli(['agent', 'stop', target.id]);
    expect(stopped.code).toBe(0);

    const afterStop = await sandbox.cli(['agent', 'list']);
    expect(countLines(afterStop.stdout, /\brunning\b/i)).toBe(STARTED - 1);
    expect(rowFor(afterStop.stdout, target.id)).toMatch(/\bstopped\b/i);
    for (const cfg of others) {
      expect(rowFor(afterStop.stdout, cfg.id)).toMatch(/\brunning\b/i);
    }

    // `agent info` now reports the stopped agent as not running.
    const info = await sandbox.cli(['agent', 'info', target.id]);
    expect(info.stdout).toMatch(/No runtime info/);

    // `agent restart` stops then streams status until terminal — expect running.
    const restarted = await sandbox.runCli(['agent', 'restart', target.id], 90_000);
    expect(restarted.stdout.split('\n').map((line) => line.trim())).toContain('running');

    const afterRestart = await sandbox.cli(['agent', 'list']);
    expect(countLines(afterRestart.stdout, /\brunning\b/i)).toBe(STARTED);
    expect(rowFor(afterRestart.stdout, target.id)).toMatch(/\brunning\b/i);
  });
});

/** The `agent list` row for a config id (the table prints an 8-char id prefix). */
function rowFor(stdout: string, agentId: string): string | undefined {
  const prefix = agentId.slice(0, 8);
  return stdout.split('\n').find((line) => line.startsWith(prefix));
}

/** Count lines matching `re` (non-global; the header line never matches a status word). */
function countLines(stdout: string, re: RegExp): number {
  return stdout.split('\n').filter((line) => re.test(line)).length;
}
