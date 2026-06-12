/**
 * DaemonHarness — boots the connector exactly as it ships: the real `newio`
 * daemon process (`node dist/cli.js daemon run`), driven over its JSON-RPC socket,
 * wired to a deterministic puppet.
 *
 * Where {@link ConnectorHarness} embeds the agent runtime in-process (fast, but
 * skips the CLI/daemon/RPC plumbing and hand-rolls its own EngineConfig), this
 * runs the full shipped stack: the CLI entry, the daemon process, `runDaemon`'s
 * own EngineConfig (bridge command via `resolveSelfExec`, stage-suffixed dirs),
 * the RPC transport, and on-disk config persistence. Use it for the highest-
 * fidelity platform checks and as the basis for CLI integ tests.
 *
 * Isolation: the daemon's data dir is normally `~/.newio-<stage>/connector`. We
 * point `NEWIO_HOME` at a temp dir so the test gets its own sandbox and never
 * collides with a developer's running daemon. Requires the cli + puppet builds.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { FileAgentConfigManager } from '@newio/agent-engine';
import { DaemonClient, DaemonConnector, getDaemonPaths } from '@newio/cli';
import type { PuppetDriver } from '@newio/acp-puppet';
import type { AgentCredentials } from './backend.js';

export interface DaemonHarnessOptions {
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
  readonly agent: AgentCredentials;
  readonly driver: PuppetDriver;
  /** How long to wait for the agent to reach `running` (greeting round-trip completes). */
  readonly startTimeoutMs?: number;
}

const STAGE = 'dev';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether the child process is still running (reads the exit getters fresh). */
function isProcessAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Resolve this workspace's built `newio` CLI entry (`dist/cli.js`). */
function resolveCliEntry(): string {
  const require = createRequire(import.meta.url);
  // The package main resolves to dist/index.cjs; the bin sits beside it.
  return join(dirname(require.resolve('@newio/cli')), 'cli.js');
}

export class DaemonHarness {
  private constructor(
    private readonly connector: DaemonConnector,
    private readonly child: ChildProcess,
    private readonly home: string,
    private readonly prevHome: string | undefined,
    readonly agentConfigId: string,
  ) {}

  static async start(options: DaemonHarnessOptions): Promise<DaemonHarness> {
    const home = mkdtempSync(join(tmpdir(), 'newio-e2e-home-'));
    const prevHome = process.env.NEWIO_HOME;
    // Make our own getDaemonPaths() match the daemon subprocess's data dir/socket.
    process.env.NEWIO_HOME = home;
    const paths = getDaemonPaths(STAGE);

    // Seed the agent config + tokens on disk (same as the daemon's own config
    // manager would write), so `agent.start` skips the browser-approval flow.
    const configManager = new FileAgentConfigManager(paths.dataDir);
    const config = configManager.add({
      type: 'custom',
      newioUsername: options.agent.username,
      sessionMode: 'isolated',
      acp: { executablePath: options.driver.executablePath, cwd: paths.dataDir },
      envVars: {
        PUPPET_CONTROL_SOCKET: options.driver.socketPath,
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      },
    });
    configManager.setNewioIdentity(config.id, { agentId: options.agent.agentId, username: options.agent.username });
    configManager.setTokens(config.id, {
      accessToken: options.agent.accessToken,
      refreshToken: options.agent.refreshToken,
    });

    // Spawn the real daemon process.
    const child = spawn(process.execPath, [resolveCliEntry(), 'daemon', 'run'], {
      env: {
        ...process.env,
        NEWIO_HOME: home,
        NEWIO_STAGE: STAGE,
        NEWIO_API_URL: options.apiBaseUrl,
        NEWIO_WS_URL: options.wsUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let daemonLog = '';
    const capture = (chunk: Buffer): void => {
      daemonLog += chunk.toString();
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const connector = new DaemonConnector(new DaemonClient());
    try {
      await connectWithRetry(connector, paths.socketPath, 20_000);
      await connector.startAgent(config.id);
      await waitForRunning(connector, config.id, options.startTimeoutMs ?? 90_000);
    } catch (err: unknown) {
      await teardown(connector, child, home, prevHome);
      const detail = daemonLog.trim();
      throw new Error(
        `DaemonHarness failed to start: ${String(err)}${detail ? `\n--- daemon log ---\n${detail}` : ''}`,
      );
    }

    return new DaemonHarness(connector, child, home, prevHome, config.id);
  }

  async stop(): Promise<void> {
    try {
      await Promise.race([this.connector.stopAgent(this.agentConfigId), sleep(5_000)]);
    } catch {
      /* best-effort */
    }
    await teardown(this.connector, this.child, this.home, this.prevHome);
  }
}

/** Connect to the daemon socket, retrying until it is accepting connections. */
async function connectWithRetry(connector: DaemonConnector, socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await connector.connect(socketPath);
      return;
    } catch (err: unknown) {
      lastErr = err;
      await sleep(250);
    }
  }
  throw new Error(`daemon socket not ready after ${timeoutMs}ms: ${String(lastErr)}`);
}

/** Poll `agent.list` until the agent is running, or it errors / times out. */
async function waitForRunning(connector: DaemonConnector, agentId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const agents = await connector.listAgents();
    const agent = agents.find((a) => a.id === agentId);
    if (agent?.runtimeStatus === 'running') {
      return;
    }
    if (agent?.runtimeStatus === 'error') {
      throw new Error(`agent entered error state: ${agent.error ?? 'unknown'}`);
    }
    if (agent?.runtimeStatus === 'awaiting_approval') {
      throw new Error('agent awaiting approval — seeded tokens were not accepted');
    }
    await sleep(1_000);
  }
  throw new Error(`agent did not reach running within ${timeoutMs}ms`);
}

/** Stop the daemon, kill the process if needed, remove the sandbox, restore env. */
async function teardown(
  connector: DaemonConnector,
  child: ChildProcess,
  home: string,
  prevHome: string | undefined,
): Promise<void> {
  // daemon.stop is a graceful shutdown RPC with no client-side timeout — bound it
  // so an unresponsive daemon can't hang teardown; the SIGTERM/SIGKILL below is
  // the backstop that actually guarantees the process dies.
  try {
    await Promise.race([connector.stop(), sleep(5_000)]);
  } catch {
    /* best-effort */
  }
  connector.disconnect();

  // Read the exit getters via a helper so the linter doesn't (wrongly) narrow
  // them to a stale value across the await — they can change when the child exits.
  if (isProcessAlive(child)) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(5_000)]);
    if (isProcessAlive(child)) {
      child.kill('SIGKILL');
    }
  }

  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) {
    delete process.env.NEWIO_HOME;
  } else {
    process.env.NEWIO_HOME = prevHome;
  }
}
