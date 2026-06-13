/**
 * DaemonSandbox — a real `newio` daemon (`node dist/cli.js daemon run`) running
 * in an isolated `NEWIO_HOME` temp dir, plus a `runCli()` helper that drives it
 * with real CLI subcommands.
 *
 * This is the shared substrate for both the platform e2e (`DaemonHarness`, which
 * adds a puppet agent) and the CLI integ tests (which drive `agent`/`env`/`daemon`
 * commands directly). Backend URLs are optional — the config/daemon/env command
 * surface works with no backend at all; only `agent start` needs one.
 *
 * Requires the cli build (`dist/cli.js`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { getDaemonPaths } from '@newio/cli';

export interface DaemonSandboxOptions {
  /** Backend REST URL for the daemon. Omit for hermetic, no-backend CLI tests. */
  readonly apiBaseUrl?: string;
  /** Backend WebSocket URL for the daemon. Omit for hermetic, no-backend CLI tests. */
  readonly wsUrl?: string;
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const STAGE = 'dev';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Resolve this workspace's built `newio` CLI entry (`dist/cli.js`). */
export function newioCliEntry(): string {
  const require = createRequire(import.meta.url);
  // The package main resolves to dist/index.cjs; the bin sits beside it.
  return join(dirname(require.resolve('@newio/cli')), 'cli.js');
}

export class DaemonSandbox {
  private constructor(
    /** The daemon's data dir (`<NEWIO_HOME>/.newio-dev/connector`). */
    readonly dataDir: string,
    private readonly daemon: ChildProcess,
    private readonly env: NodeJS.ProcessEnv,
    private readonly home: string,
    private readonly prevHome: string | undefined,
    private readonly readLog: () => string,
  ) {}

  static async start(options: DaemonSandboxOptions = {}): Promise<DaemonSandbox> {
    const home = mkdtempSync(join(tmpdir(), 'newio-e2e-home-'));
    const prevHome = process.env.NEWIO_HOME;
    // Make our own getDaemonPaths() match the daemon subprocess's data dir.
    process.env.NEWIO_HOME = home;
    const { dataDir } = getDaemonPaths(STAGE);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NEWIO_HOME: home,
      NEWIO_STAGE: STAGE,
      ...(options.apiBaseUrl ? { NEWIO_API_URL: options.apiBaseUrl } : {}),
      ...(options.wsUrl ? { NEWIO_WS_URL: options.wsUrl } : {}),
    };

    const daemon = spawn(process.execPath, [newioCliEntry(), 'daemon', 'run'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const capture = (chunk: Buffer): void => {
      log += chunk.toString();
    };
    daemon.stdout.on('data', capture);
    daemon.stderr.on('data', capture);

    const sandbox = new DaemonSandbox(dataDir, daemon, env, home, prevHome, () => log);
    try {
      await sandbox.waitReady(20_000);
      return sandbox;
    } catch (err: unknown) {
      await sandbox.stop();
      throw new Error(
        `daemon failed to start: ${String(err)}${log.trim() ? `\n--- daemon log ---\n${log.trim()}` : ''}`,
      );
    }
  }

  /** The accumulated daemon stdout+stderr (for diagnostics). */
  get daemonLog(): string {
    return this.readLog();
  }

  /** Run a `newio` CLI subcommand against this sandbox's daemon. */
  runCli(args: readonly string[], timeoutMs = 30_000): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [newioCliEntry(), ...args], {
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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

  /** Run a CLI command and throw with diagnostics if it exits non-zero. */
  async cli(args: readonly string[], timeoutMs?: number): Promise<CliResult> {
    const result = await this.runCli(args, timeoutMs);
    if (result.code !== 0) {
      throw new Error(`\`newio ${args.join(' ')}\` failed (exit ${result.code}): ${result.stderr || result.stdout}`);
    }
    return result;
  }

  private async waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: CliResult | undefined;
    while (Date.now() < deadline) {
      last = await this.runCli(['agent', 'list'], 10_000).catch((err: unknown) => ({
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

  async stop(): Promise<void> {
    // Graceful shutdown via the CLI, bounded so an unresponsive daemon can't hang
    // teardown; the SIGTERM/SIGKILL below is the backstop that guarantees exit.
    await this.runCli(['daemon', 'stop'], 5_000).catch(() => undefined);

    if (isProcessAlive(this.daemon)) {
      const exited = new Promise<void>((resolve) => this.daemon.once('exit', () => resolve()));
      this.daemon.kill('SIGTERM');
      await Promise.race([exited, sleep(5_000)]);
      if (isProcessAlive(this.daemon)) {
        this.daemon.kill('SIGKILL');
      }
    }

    rmSync(this.home, { recursive: true, force: true });
    if (this.prevHome === undefined) {
      delete process.env.NEWIO_HOME;
    } else {
      process.env.NEWIO_HOME = this.prevHome;
    }
  }
}
