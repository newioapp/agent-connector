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
import type { AgentSession } from '../agent-session';
import type { KiroCliConfig } from '../types';
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
  private chunks: string[] = [];
  private resolve: ((text: string) => void) | null = null;

  private constructor(correlationId: string) {
    this.correlationId = correlationId;
  }

  /**
   * Spawn a kiro-cli process, establish ACP connection, create a new ACP session.
   */
  static async create(config: KiroCliConfig): Promise<KiroCliSession> {
    const session = await KiroCliSession.spawnAndInit(config);
    const conn = session.getConnection();

    const sessionResult = await conn.newSession({
      cwd: config.cwd ?? process.cwd(),
      mcpServers: [],
    });

    (session as { correlationId: string }).correlationId = sessionResult.sessionId;
    log.info(`ACP session created: ${sessionResult.sessionId}`);
    return session;
  }

  /**
   * Spawn a kiro-cli process, establish ACP connection, and resume an existing session.
   * Uses ACP `session/load` to restore the previous context window.
   */
  static async resume(config: KiroCliConfig, correlationId: string): Promise<KiroCliSession> {
    const session = await KiroCliSession.spawnAndInit(config);
    (session as { correlationId: string }).correlationId = correlationId;

    await session.getConnection().loadSession({
      sessionId: correlationId,
      cwd: config.cwd ?? process.cwd(),
      mcpServers: [],
    });
    log.info(`ACP session resumed: ${correlationId}`);
    return session;
  }

  private getConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error('ACP connection not initialized');
    }
    return this.connection;
  }

  /** Spawn kiro-cli process and initialize ACP connection (shared by create/resume). */
  private static async spawnAndInit(config: KiroCliConfig): Promise<KiroCliSession> {
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
      env: { ...process.env, TERM: 'dumb' },
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
      log.info(`kiro-cli exited (code=${String(code)}, signal=${String(signal)}) [session=${session.correlationId}]`);
    });

    const conn = new ClientSideConnection((_agent) => session, stream);
    session.connection = conn;

    const initResult = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    log.info(`ACP initialized (protocol v${String(initResult.protocolVersion)})`);

    return session;
  }

  // ---------------------------------------------------------------------------
  // AgentSession
  // ---------------------------------------------------------------------------

  async prompt(text: string): Promise<string | undefined> {
    const conn = this.connection;
    if (!conn) {
      return undefined;
    }

    const responsePromise = this.startCollecting();

    const promptResult = await conn.prompt({
      sessionId: this.correlationId,
      prompt: [{ type: 'text', text }],
    });

    this.finishCollecting();

    if (promptResult.stopReason !== 'end_turn') {
      log.warn(`Prompt ended with stop reason: ${promptResult.stopReason}`);
    }

    return await responsePromise;
  }

  dispose(): void {
    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = undefined;
    }
    this.connection = undefined;
    log.info(`Session disposed: ${this.correlationId}`);
  }

  // ---------------------------------------------------------------------------
  // Internal — response collection
  // ---------------------------------------------------------------------------

  private startCollecting(): Promise<string> {
    this.chunks = [];
    return new Promise<string>((r) => {
      this.resolve = r;
    });
  }

  private finishCollecting(): void {
    const text = this.chunks.join('');
    this.chunks = [];
    this.resolve?.(text);
    this.resolve = null;
  }

  // ---------------------------------------------------------------------------
  // acp.Client — session updates
  // ---------------------------------------------------------------------------

  sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type === 'text') {
          this.chunks.push(u.content.text);
        }
        break;
      case 'tool_call':
        log.debug(`Tool call: ${u.title} (${u.status})`);
        break;
      case 'tool_call_update':
        log.debug(`Tool call update: ${u.toolCallId} ${u.status}`);
        break;
      case 'agent_thought_chunk':
        if (u.content.type === 'text') {
          log.debug(`Thought: ${u.content.text}`);
        }
        break;
      default:
        break;
    }
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
    log.debug(`ext method: ${method}`);
    return Promise.resolve({});
  }

  extNotification(method: string, _params: Record<string, unknown>): Promise<void> {
    log.debug(`ext notification: ${method}`);
    return Promise.resolve();
  }
}
