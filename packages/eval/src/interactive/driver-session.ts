/**
 * DriverSessionFactory + DriverSession — simplified ACP session management for the
 * interactive eval driver agent. Strips out domain-specific concerns (skipToken,
 * promptFormatterVersion, sessionType/externalReferenceId, config/context-window/
 * slash-command handlers, permission routing, status listeners) while preserving
 * core ACP machinery: spawn, init, multi-session creation, update buffering/replay,
 * and clean termination.
 */
import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { Writable, Readable } from 'stream';
import * as fs from 'fs/promises';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk';
import type { AgentType, AcpConfig, SessionStreamSegment } from '@newio/agent-engine';
import { getLogger } from '@newio/agent-sdk';

const log = getLogger('driver-session');

// ---------------------------------------------------------------------------
// DriverSession
// ---------------------------------------------------------------------------

export class DriverSession {
  readonly correlationId: string;

  private readonly connection: ClientSideConnection;
  private stream?: DriverSessionStream;

  constructor(correlationId: string, connection: ClientSideConnection) {
    this.correlationId = correlationId;
    this.connection = connection;
  }

  async *prompt(text: string): AsyncGenerator<SessionStreamSegment> {
    const stream = new DriverSessionStream();
    this.stream = stream;

    const promptDone = this.connection
      .prompt({ sessionId: this.correlationId, prompt: [{ type: 'text', text }] })
      .then(() => stream.finish())
      .catch((err: unknown) => {
        stream.finish();
        throw err;
      });

    try {
      yield* stream.segments();
      await promptDone;
    } finally {
      this.stream = undefined;
    }
  }

  async applyModel(model: string): Promise<void> {
    await this.connection.unstable_setSessionModel({
      sessionId: this.correlationId,
      modelId: model,
    });
  }

  async cancel(): Promise<void> {
    await this.connection.cancel({ sessionId: this.correlationId });
  }

  /** Route a session update from the factory. */
  handleSessionUpdate(update: acp.SessionUpdate): void {
    this.stream?.handleSessionUpdate(update);
  }
}

// ---------------------------------------------------------------------------
// DriverSessionFactory
// ---------------------------------------------------------------------------

export interface DriverSessionFactoryOptions {
  readonly agentType: AgentType;
  readonly envVars: Record<string, string>;
  readonly acp: AcpConfig;
  readonly appDisplayName?: string;
  readonly appVersion?: string;
}

export interface CreateDriverSessionInput {
  readonly mcpServers?: AcpMcpServer[];
}

export class DriverSessionFactory implements acp.Client {
  private childProcess?: ChildProcess;
  private connection?: ClientSideConnection;
  private stopping = false;

  private readonly sessions = new Map<string, DriverSession>();
  private readonly pendingUpdates = new Map<string, acp.SessionNotification[]>();

  private readonly options: DriverSessionFactoryOptions;
  private readonly appDisplayName: string;
  private readonly appVersion: string;

  constructor(options: DriverSessionFactoryOptions) {
    this.options = options;
    this.appDisplayName = options.appDisplayName ?? 'Newio Eval Driver';
    this.appVersion = options.appVersion ?? '0.1.0';
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    const { command, args } = resolveCommand(this.options.agentType, this.options.acp);
    log.info(`[driver] Spawning: ${command} ${args.join(' ')}`);

    const child = await spawnAsync(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...this.options.envVars, TERM: 'dumb' },
      ...(this.options.acp.cwd ? { cwd: this.options.acp.cwd } : {}),
    });

    child.stderr?.on('data', (data: Buffer) => {
      log.debug(`[driver] [stderr] ${data.toString().trimEnd()}`);
    });

    child.on('exit', (code, signal) => {
      log.info(`[driver] ACP process exited (code=${String(code)}, signal=${String(signal)})`);
    });

    this.childProcess = child;

    if (!child.stdin || !child.stdout) {
      throw new Error('Driver ACP child process missing stdio streams');
    }

    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);

    const conn = new ClientSideConnection(() => this, stream);
    this.connection = conn;

    const initResult = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: this.appDisplayName, version: this.appVersion },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });

    log.info(`[driver] ACP initialized (protocol v${String(initResult.protocolVersion)})`);
  }

  async terminate(): Promise<void> {
    this.stopping = true;
    this.sessions.clear();
    this.pendingUpdates.clear();
    this.connection = undefined;
    await this.killProcess();
  }

  // ---------------------------------------------------------------------------
  // Session creation
  // ---------------------------------------------------------------------------

  async createSession(input?: CreateDriverSessionInput): Promise<DriverSession> {
    const conn = this.getConnection();

    const result = await conn.newSession({
      cwd: this.options.acp.cwd,
      mcpServers: input?.mcpServers ?? [],
    });

    const session = new DriverSession(result.sessionId, conn);
    this.registerSession(result.sessionId, session);
    log.info(`[driver] Session created: ${result.sessionId}`);
    return session;
  }

  private registerSession(correlationId: string, session: DriverSession): void {
    this.sessions.set(correlationId, session);

    const buffered = this.pendingUpdates.get(correlationId);
    if (buffered) {
      this.pendingUpdates.delete(correlationId);
      // Only replay config updates — skip historical content (tool calls, messages, etc.)
      const replayable = new Set(['current_mode_update', 'config_option_update']);
      for (const update of buffered) {
        if (replayable.has(update.update.sessionUpdate)) {
          session.handleSessionUpdate(update.update);
        }
      }
      log.debug(`[driver] Replayed buffered update(s) for ${correlationId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // acp.Client callbacks
  // ---------------------------------------------------------------------------

  sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.handleSessionUpdate(params.update);
    } else {
      let buffered = this.pendingUpdates.get(params.sessionId);
      if (!buffered) {
        buffered = [];
        this.pendingUpdates.set(params.sessionId, buffered);
      }
      buffered.push(params);
    }
    return Promise.resolve();
  }

  requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    // Heuristically pick the best "allow" option from the provided options
    const options = params.options;
    const allow =
      options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once') ?? options[0];
    const optionId = allow?.optionId ?? 'allow';
    return Promise.resolve({ outcome: { outcome: 'selected', optionId } });
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.readFile(params.path, 'utf-8');
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.writeFile(params.path, params.content, 'utf-8');
    return {};
  }

  extMethod(_method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  extNotification(_method: string, _params: Record<string, unknown>): Promise<void> {
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private getConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error('Driver ACP connection not initialized');
    }
    return this.connection;
  }

  private async killProcess(): Promise<void> {
    const child = this.childProcess;
    if (!child) {
      return;
    }
    this.stopping = true;
    this.childProcess = undefined;

    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.end();
    }

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
      child.kill('SIGKILL');
    }
    log.info('[driver] ACP process terminated');
  }
}

// ---------------------------------------------------------------------------
// DriverSessionStream — minimal streaming (text + tool calls, no skip token)
// ---------------------------------------------------------------------------

class DriverSessionStream {
  private queue: SessionStreamSegment[] = [];
  private waiter: (() => void) | undefined;
  private done = false;
  private currentType: SessionStreamSegment['type'] | undefined;
  private currentText = '';

  handleSessionUpdate(update: acp.SessionUpdate): void {
    const type = update.sessionUpdate;

    if (type === 'agent_message_chunk') {
      const text =
        update.content.type === 'text' && typeof update.content.text === 'string' ? update.content.text : undefined;
      this.pushText('agent_message_chunk', text);
    } else if (type === 'agent_thought_chunk') {
      const text =
        update.content.type === 'text' && typeof update.content.text === 'string' ? update.content.text : undefined;
      this.pushText('agent_thought_chunk', text);
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      this.flushCurrent();
      const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : 'unknown';
      const text = typeof update.title === 'string' ? update.title : toolCallId;
      this.queue.push({ type: 'tool_call', text, toolCallId, toolCallStatus: update.status ?? undefined });
      this.waiter?.();
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.flushCurrent();
    this.done = true;
    this.waiter?.();
  }

  async *segments(): AsyncGenerator<SessionStreamSegment> {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      let next = this.queue.shift();
      while (next) {
        yield next;
        next = this.queue.shift();
      }
      if (this.done) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = undefined;
    }
  }

  private pushText(type: SessionStreamSegment['type'], text?: string): void {
    if (this.currentType && this.currentType !== type) {
      this.flushCurrent();
    }
    this.currentType = type;
    if (text) {
      this.currentText += text;
    }
  }

  private flushCurrent(): void {
    if (this.currentType) {
      this.queue.push({ type: this.currentType, text: this.currentText });
      this.currentType = undefined;
      this.currentText = '';
      this.waiter?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spawnAsync(command: string, args: readonly string[], options: SpawnOptions): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const onError = (err: Error): void => {
      child.removeListener('spawn', onSpawn);
      reject(err);
    };
    const onSpawn = (): void => {
      child.removeListener('error', onError);
      resolve(child);
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

function resolveCommand(
  type: AgentType,
  config: AcpConfig,
): { readonly command: string; readonly args: readonly string[] } {
  if (type === 'kiro-cli') {
    const command = config.executablePath ?? 'kiro-cli';
    const args = config.kiroCliTrustAllTools !== false ? ['acp', '--trust-all-tools'] : ['acp'];
    return { command, args };
  }
  if (type === 'claude-code') {
    return { command: config.executablePath ?? 'claude-agent-acp', args: [] };
  }
  if (type === 'codex') {
    return { command: config.executablePath ?? 'codex-acp', args: [] };
  }
  if (type === 'cursor') {
    return { command: config.executablePath ?? 'agent', args: ['acp'] };
  }
  if (type === 'gemini') {
    return { command: config.executablePath ?? 'gemini', args: ['--acp'] };
  }
  if (!config.executablePath) {
    throw new Error('No executable path configured for custom agent type');
  }
  const parts = config.executablePath.trim().split(/\s+/).filter(Boolean);
  const command = parts[0];
  if (command === undefined) {
    throw new Error('No executable path configured for custom agent type');
  }
  return { command, args: parts.slice(1) };
}
