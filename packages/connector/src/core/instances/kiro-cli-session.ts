/**
 * KiroCliSession — one Kiro CLI ACP session (one context window).
 *
 * Implements AgentSession (common interface) and acp.Client (ACP protocol).
 * Owns its own kiro-cli child process and ACP connection.
 */
import { spawn, execFileSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { Writable, Readable } from 'stream';
import * as fs from 'fs/promises';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSession, SessionStatusListener } from '../agent-session';
import type { KiroCliConfig } from '../types';
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk';
import { SessionStream } from './session-stream';
import type { SessionStreamSegment } from './session-stream';
import { Logger } from '../logger';

const log = new Logger('kiro-cli-session');

/**
 * Resolve the absolute path to `kiro-cli`. Electron's PATH when launched from
 * the Dock is minimal, so we try multiple strategies.
 */
const resolvedKiroCliPath: string = (() => {
  try {
    execFileSync('kiro-cli', ['--version'], { encoding: 'utf8', timeout: 3000 });
    return 'kiro-cli';
  } catch {
    // not on PATH
  }

  const shell = process.env.SHELL ?? '/bin/zsh';
  try {
    const path = execFileSync(shell, ['-ilc', 'which kiro-cli'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TERM: 'dumb' },
    }).trim();
    if (path) {
      return path;
    }
  } catch {
    // shell resolution failed
  }

  for (const candidate of ['/Users/pineapple/.local/bin/kiro-cli', '/usr/local/bin/kiro-cli']) {
    try {
      execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 3000 });
      return candidate;
    } catch {
      // not here
    }
  }

  return 'kiro-cli';
})();

export class KiroCliSession implements AgentSession, acp.Client {
  readonly correlationId: string;

  private childProcess?: ChildProcess;
  private connection?: ClientSideConnection;
  private stream?: SessionStream;
  private statusListener: SessionStatusListener = () => {};

  private constructor(correlationId: string) {
    this.correlationId = correlationId;
  }

  /**
   * Spawn a kiro-cli process, establish ACP connection, create a new ACP session.
   */
  static async create(
    config: KiroCliConfig,
    mcpSocketPath?: string,
    envVars?: Readonly<Record<string, string>>,
  ): Promise<KiroCliSession> {
    const session = await KiroCliSession.spawnAndInit(config, envVars);
    const conn = session.getConnection();

    const sessionResult = await conn.newSession({
      cwd: config.cwd ?? process.cwd(),
      mcpServers: buildMcpServers(mcpSocketPath),
    });

    (session as { correlationId: string }).correlationId = sessionResult.sessionId;
    log.info(`[${session.correlationId}] ACP session created`);
    return session;
  }

  /**
   * Spawn a kiro-cli process, establish ACP connection, and resume an existing session.
   * Uses ACP `session/load` to restore the previous context window.
   */
  static async resume(
    config: KiroCliConfig,
    correlationId: string,
    mcpSocketPath?: string,
    envVars?: Readonly<Record<string, string>>,
  ): Promise<KiroCliSession> {
    const session = await KiroCliSession.spawnAndInit(config, envVars);
    (session as { correlationId: string }).correlationId = correlationId;

    await session.getConnection().loadSession({
      sessionId: correlationId,
      cwd: config.cwd ?? process.cwd(),
      mcpServers: buildMcpServers(mcpSocketPath),
    });
    log.info(`[${correlationId}] ACP session resumed`);
    return session;
  }

  private getConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error('ACP connection not initialized');
    }
    return this.connection;
  }

  /** Spawn kiro-cli process and initialize ACP connection (shared by create/resume). */
  private static async spawnAndInit(
    config: KiroCliConfig,
    envVars?: Readonly<Record<string, string>>,
  ): Promise<KiroCliSession> {
    const { agentName, model, kiroCliPath, cwd } = config;
    const executable = kiroCliPath ?? resolvedKiroCliPath;
    const args = ['acp', '--trust-all-tools'];
    if (agentName) {
      args.push('--agent', agentName);
    }
    if (model) {
      args.push('--model', model);
    }

    log.info(`Spawning: ${executable} ${args.join(' ')}`);

    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...envVars, TERM: 'dumb' },
      ...(cwd ? { cwd } : {}),
    });

    child.stderr.on('data', (data: Buffer) => {
      log.debug(`[kiro-cli stderr] ${data.toString().trimEnd()}`);
    });

    child.on('error', (err) => {
      log.error(`kiro-cli process error: ${err.message}`);
    });

    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);

    // Create session object first so it can be used as the acp.Client
    const session = new KiroCliSession(''); // correlationId set after ACP session creation
    session.childProcess = child;

    child.on('exit', (code, signal) => {
      log.info(`[${session.correlationId}] kiro-cli exited (code=${String(code)}, signal=${String(signal)})`);
    });

    const conn = new ClientSideConnection((_agent) => session, stream);
    session.connection = conn;

    const initResult = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    log.info(`[${session.correlationId}] ACP initialized (protocol v${String(initResult.protocolVersion)})`);

    return session;
  }

  // ---------------------------------------------------------------------------
  // AgentSession
  // ---------------------------------------------------------------------------

  onStatus(listener: SessionStatusListener): void {
    this.statusListener = listener;
  }

  private prompting = false;

  async *prompt(text: string): AsyncGenerator<SessionStreamSegment> {
    const conn = this.connection;
    if (!conn) {
      return;
    }

    this.prompting = true;
    this.statusListener('thinking');
    const stream = new SessionStream(this.statusListener);
    this.stream = stream;

    const promptDone = conn
      .prompt({
        sessionId: this.correlationId,
        prompt: [{ type: 'text', text }],
      })
      .then((result) => {
        stream.finish();
        if (result.stopReason !== 'end_turn') {
          log.warn(`[${this.correlationId}] Prompt ended with stop reason: ${result.stopReason}`);
        }
      })
      .catch((err: unknown) => {
        log.error(`[${this.correlationId}] Prompt failed: ${err instanceof Error ? err.message : String(err)}`);
        stream.finish();
        throw err;
      });

    try {
      yield* stream.segments();
      await promptDone;
    } finally {
      this.stream = undefined;
      this.prompting = false;
      this.statusListener('idle');
    }
  }

  dispose(): void {
    this.disposeAsync().catch((err: unknown) => {
      log.error(
        `[${this.correlationId}] Error during async dispose: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async disposeAsync(): Promise<void> {
    const conn = this.connection;
    const child = this.childProcess;

    // 1. Cancel any in-flight prompt via ACP session/cancel
    if (conn && this.prompting) {
      log.info(`[${this.correlationId}] Cancelling in-flight prompt...`);
      try {
        await conn.cancel({ sessionId: this.correlationId });
      } catch (err) {
        log.debug(
          `[${this.correlationId}] Cancel notification failed (expected if already done): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.connection = undefined;

    if (!child) {
      log.info(`[${this.correlationId}] Session disposed (no child process)`);
      return;
    }

    // 2. Close stdin to signal the child process to exit
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.end();
    }

    // 3. Wait for graceful exit with a 5s hard timeout
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        child.once('exit', () => resolve(true));
        if (child.exitCode !== null) {
          resolve(true);
        }
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);

    if (!exited) {
      log.warn(`[${this.correlationId}] Child process did not exit within 5s, sending SIGKILL`);
      child.kill('SIGKILL');
    }

    this.childProcess = undefined;
    log.info(`[${this.correlationId}] Session disposed`);
  }

  // ---------------------------------------------------------------------------
  // acp.Client — session updates
  // ---------------------------------------------------------------------------

  sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.stream?.handleSessionUpdate(params);
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // acp.Client — permissions (auto-approve)
  // ---------------------------------------------------------------------------

  requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const allowOption = params.options.find((o) => o.kind === 'allow_always' || o.kind === 'allow_once');
    return Promise.resolve({
      outcome: {
        outcome: 'selected',
        optionId: allowOption?.optionId ?? params.options[0].optionId,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // acp.Client — file system
  // ---------------------------------------------------------------------------

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.readFile(params.path, 'utf-8');
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.writeFile(params.path, params.content, 'utf-8');
    return {};
  }

  // ---------------------------------------------------------------------------
  // acp.Client — extensions
  // ---------------------------------------------------------------------------

  extMethod(method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> {
    log.debug(`[${this.correlationId}] ext method: ${method}`);
    return Promise.resolve({});
  }

  extNotification(method: string, _params: Record<string, unknown>): Promise<void> {
    log.debug(`[${this.correlationId}] ext notification: ${method}`);
    return Promise.resolve();
  }
}

function buildMcpServers(mcpSocketPath?: string): AcpMcpServer[] {
  if (!mcpSocketPath) {
    return [];
  }
  return [
    {
      name: 'newio',
      command: 'node',
      args: [resolveBridgePath(), mcpSocketPath],
      env: [],
    },
  ];
}

/** Resolve absolute path to the bridge script from @newio/mcp-server package. */
function resolveBridgePath(): string {
  return require.resolve('@newio/mcp-server/bridge');
}
