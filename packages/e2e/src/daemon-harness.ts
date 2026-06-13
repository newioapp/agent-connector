/**
 * DaemonHarness — boots the connector exactly as it ships and configures it the
 * way a user does: the real `newio` daemon process (`node dist/cli.js daemon run`)
 * driven by the real CLI subcommands (`agent add` / `agent env set` /
 * `agent start`), wired to a deterministic puppet.
 *
 * Where {@link ConnectorHarness} embeds the agent runtime in-process (fast, but
 * skips the CLI/daemon/RPC plumbing and hand-rolls its own EngineConfig), this
 * runs the full shipped stack: the CLI entry + commands, the daemon process,
 * `runDaemon`'s own EngineConfig (bridge command via `resolveSelfExec`,
 * stage-suffixed dirs), the RPC transport, and on-disk config — all defined
 * through the CLI rather than JavaScript.
 *
 * The one thing the CLI can't do is inject credentials (tokens only ever come
 * from the approval flow). To keep the test deterministic we write the agent's
 * `.credentials.json` directly — the single byte of state the connector's own
 * approval-poll would otherwise have written. Tokens come from `OwnerBackend`
 * (the human side legitimately registers + approves the agent).
 *
 * Isolation: the daemon's data dir is normally `~/.newio-<stage>/connector`. We
 * point `NEWIO_HOME` at a temp dir so the test gets its own sandbox and never
 * collides with a developer's running daemon. Requires the cli + puppet builds.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { getDaemonPaths } from '@newio/cli';
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

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
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
    private readonly daemon: ChildProcess,
    private readonly env: NodeJS.ProcessEnv,
    private readonly home: string,
    private readonly prevHome: string | undefined,
    readonly agentConfigId: string,
  ) {}

  static async start(options: DaemonHarnessOptions): Promise<DaemonHarness> {
    const home = mkdtempSync(join(tmpdir(), 'newio-e2e-home-'));
    const prevHome = process.env.NEWIO_HOME;
    // Make our own getDaemonPaths() match the daemon subprocess's data dir.
    process.env.NEWIO_HOME = home;
    const paths = getDaemonPaths(STAGE);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NEWIO_HOME: home,
      NEWIO_STAGE: STAGE,
      NEWIO_API_URL: options.apiBaseUrl,
      NEWIO_WS_URL: options.wsUrl,
    };

    const daemon = spawn(process.execPath, [resolveCliEntry(), 'daemon', 'run'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let daemonLog = '';
    const capture = (chunk: Buffer): void => {
      daemonLog += chunk.toString();
    };
    daemon.stdout.on('data', capture);
    daemon.stderr.on('data', capture);

    try {
      await waitForDaemonReady(env, 20_000);

      // Define the agent through the CLI (no JS config code). Use the path-safe
      // --command/--arg form so a runtime/bin path with spaces still works.
      const added = await runCli(
        [
          'agent',
          'add',
          '--type',
          'custom',
          '--username',
          options.agent.username,
          '--command',
          options.driver.command,
          ...options.driver.args.flatMap((arg) => ['--arg', arg]),
        ],
        env,
      );
      if (added.code !== 0) {
        throw new Error(`\`agent add\` failed (exit ${added.code}): ${added.stderr || added.stdout}`);
      }
      const agentId = parseAddedAgentId(added.stdout);

      // Token seam: write the credentials the approval-poll would have persisted.
      const credsPath = join(paths.dataDir, 'agents', agentId, '.credentials.json');
      writeFileSync(
        credsPath,
        JSON.stringify({ accessToken: options.agent.accessToken, refreshToken: options.agent.refreshToken }),
        { mode: 0o600 },
      );

      // Point the puppet at the driver's control socket (merges with the env
      // `agent add` captured, so PATH etc. survive).
      const envSet = await runCli(
        ['agent', 'env', 'set', agentId, `PUPPET_CONTROL_SOCKET=${options.driver.socketPath}`],
        env,
      );
      if (envSet.code !== 0) {
        throw new Error(`\`agent env set\` failed (exit ${envSet.code}): ${envSet.stderr || envSet.stdout}`);
      }

      // Start it — blocks until a terminal status (running/error/stopped).
      const started = await runCli(['agent', 'start', agentId], env, options.startTimeoutMs ?? 90_000);
      const reachedRunning = started.stdout
        .split('\n')
        .map((line) => line.trim())
        .includes('running');
      if (!reachedRunning) {
        throw new Error(`agent did not reach running:\n${started.stdout}\n${started.stderr}`);
      }

      return new DaemonHarness(daemon, env, home, prevHome, agentId);
    } catch (err: unknown) {
      await teardown(daemon, env, home, prevHome);
      const detail = daemonLog.trim();
      throw new Error(
        `DaemonHarness failed to start: ${String(err)}${detail ? `\n--- daemon log ---\n${detail}` : ''}`,
      );
    }
  }

  async stop(): Promise<void> {
    await teardown(this.daemon, this.env, this.home, this.prevHome);
  }
}

/** Parse the agent id out of `agent add`'s "Added agent <id> for @username." line. */
function parseAddedAgentId(stdout: string): string {
  const match = /Added agent (\S+) for/.exec(stdout);
  if (!match?.[1]) {
    throw new Error(`could not parse agent id from \`agent add\` output: ${stdout}`);
  }
  return match[1];
}

/** Run a `newio` CLI subcommand against the sandboxed daemon; resolves with its result. */
function runCli(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolveCliEntry(), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI command timed out after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Poll `agent list` until the daemon is accepting connections. */
async function waitForDaemonReady(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: CliResult | undefined;
  while (Date.now() < deadline) {
    last = await runCli(['agent', 'list'], env, 10_000).catch((err: unknown) => ({
      code: -1,
      stdout: '',
      stderr: String(err),
    }));
    if (last.code === 0) {
      return;
    }
    await sleep(300);
  }
  throw new Error(`daemon not ready after ${timeoutMs}ms: ${last?.stderr ?? ''}`);
}

/** Stop the daemon gracefully, kill it if needed, remove the sandbox, restore env. */
async function teardown(
  daemon: ChildProcess,
  env: NodeJS.ProcessEnv,
  home: string,
  prevHome: string | undefined,
): Promise<void> {
  // Graceful shutdown via the CLI, bounded so an unresponsive daemon can't hang
  // teardown; the SIGTERM/SIGKILL below is the backstop that guarantees exit.
  await runCli(['daemon', 'stop'], env, 5_000).catch(() => undefined);

  if (isProcessAlive(daemon)) {
    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
    daemon.kill('SIGTERM');
    await Promise.race([exited, sleep(5_000)]);
    if (isProcessAlive(daemon)) {
      daemon.kill('SIGKILL');
    }
  }

  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) {
    delete process.env.NEWIO_HOME;
  } else {
    process.env.NEWIO_HOME = prevHome;
  }
}
