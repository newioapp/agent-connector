/**
 * ACP agent instance — single process, single connection, multiple sessions.
 *
 * Owns the ACP child process and ClientSideConnection. Implements acp.Client
 * to route sessionUpdate and requestPermission to the correct AcpAgentSession
 * by sessionId (correlationId). Sessions are lightweight — they share this
 * connection and don't own their own process.
 */
import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { Writable, Readable } from 'stream';
import * as fs from 'fs/promises';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk';
import { BaseAgentInstance } from './base-agent-instance';
import { AcpAgentSession } from './acp-agent-session';
import type { PermissionHandler } from './acp-agent-session';
import type { AgentSession } from './agent-session';
import type { AgentSessionConfig, ConfigureAgentInput } from './agent-instance';
import type { SessionStreamSegment } from './types';
import { resolveCommand, extractErrorMessage } from './types';
import { Logger } from './logger';

const log = new Logger('acp-agent-instance');

/**
 * Awaitable spawn — resolves with the child process once the OS has successfully
 * created it (`spawn` event), or rejects if the process fails to start (e.g. ENOENT).
 */
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

export class AcpAgentInstance extends BaseAgentInstance implements acp.Client {
  private childProcess?: ChildProcess;
  private connection?: ClientSideConnection;

  /** correlationId → live session, for routing acp.Client callbacks. */
  private readonly acpSessions = new Map<string, AcpAgentSession>();

  /** Whether the ACP agent supports session/close. */
  private supportsClose = false;

  /** Set to true when stop/kill is intentional — prevents the exit handler from treating it as unexpected. */
  private stopping = false;

  /** The first session created (greeting session) — used to expose available models/modes. */
  private representativeSession?: AcpAgentSession;

  /** Runtime-selected model — applied to new sessions. */
  private selectedModel?: string;

  /** Runtime-selected mode — applied to new sessions. */
  private selectedMode?: string;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected async onConnected(): Promise<void> {
    log.info('ACP agent instance connected, spawning ACP process...');
    if (!this.config.acp) {
      throw new Error('ACP config missing');
    }

    await this.spawnAndInit();
    this.representativeSession = await this.sendGreeting();
    this.representativeSession.onConfigChanged(() => {
      const models = this.representativeSession?.listModels();
      const modes = this.representativeSession?.listModes();
      if (models?.selectedId) {
        this.selectedModel = models.selectedId;
      }
      if (modes?.selectedId) {
        this.selectedMode = modes.selectedId;
      }
      if (this.representativeSession) {
        this.listener.onAgentSessionConfigUpdated(this.representativeSession.correlationId, models, modes);
      }
    });
  }

  protected async onStopped(): Promise<void> {
    log.info('ACP agent instance stopping...');
    this.representativeSession = undefined;
    this.selectedModel = undefined;
    this.selectedMode = undefined;
    this.acpSessions.clear();
    this.connection = undefined;
    await this.killProcess();
  }

  protected onSessionDisposed(correlationId: string): void {
    this.acpSessions.delete(correlationId);
    if (this.representativeSession?.correlationId === correlationId) {
      this.representativeSession = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Process management
  // ---------------------------------------------------------------------------

  private async spawnAndInit(): Promise<void> {
    const config = this.config.acp;
    if (!config) {
      throw new Error('ACP config missing');
    }

    this.stopping = false;

    const { cwd } = config;
    const { command, args } = resolveCommand(this.config.type, config);

    log.info(`Spawning: ${command} ${args.join(' ')}`);

    const child = await spawnAsync(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...this.config.envVars, TERM: 'dumb' },
      ...(cwd ? { cwd } : {}),
    });

    const stderrChunks: string[] = [];
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trimEnd();
      log.debug(`[acp stderr] ${text}`);
      stderrChunks.push(text);
      // Keep only the last 20 lines to bound memory
      if (stderrChunks.length > 20) {
        stderrChunks.shift();
      }
    });

    child.on('error', (err) => {
      log.error(`ACP agent process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      log.info(`ACP agent exited (code=${String(code)}, signal=${String(signal)})`);
      if (!this.stopping) {
        this.childProcess = undefined;
        this.connection = undefined;
        const stderr = stderrChunks.join('\n').trim();
        const detail = stderr || `code=${String(code)}, signal=${String(signal)}`;
        void this.cleanup().then(() => {
          void this.onStopped();
          this.setStatus('error', `Agent process exited unexpectedly.\n\n${detail}`);
        });
      }
    });

    this.childProcess = child;

    if (!child.stdin || !child.stdout) {
      throw new Error('ACP child process missing stdio streams');
    }
    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);

    const conn = new ClientSideConnection(() => this, stream);
    this.connection = conn;

    const initResult = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: __APP_DISPLAY_NAME__, version: __APP_VERSION__ },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    log.info(`ACP initialized (protocol v${String(initResult.protocolVersion)})`);

    // Validate loadSession capability
    if (!initResult.agentCapabilities?.loadSession) {
      await this.killProcess();
      throw new Error(
        `ACP agent "${initResult.agentInfo?.name ?? 'unknown'}" does not support loadSession. ` +
          'The Newio Agent Connector requires loadSession capability to route conversations.',
      );
    }

    this.supportsClose = initResult.agentCapabilities.sessionCapabilities?.close != null;

    // Persist agent info for UI display
    this.configManager.setAcpAgentInfo(this.config.id, {
      protocolVersion: String(initResult.protocolVersion),
      agentName: initResult.agentInfo?.name,
      agentVersion: initResult.agentInfo?.version,
      agentTitle: initResult.agentInfo?.title ?? undefined,
      loadSession: initResult.agentCapabilities.loadSession,
    });
    this.listener.onConfigUpdated();
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
      log.warn('Child process did not exit within 5s, sending SIGKILL');
      child.kill('SIGKILL');
    }

    log.info('ACP process terminated');
  }

  private getConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error('ACP connection not initialized');
    }
    return this.connection;
  }

  // ---------------------------------------------------------------------------
  // Permission handler
  // ---------------------------------------------------------------------------

  private readonly permissionHandler: PermissionHandler = async (correlationId, params) => {
    const title = params.toolCall.title ?? 'Permission request';
    if (params.toolCall.content) {
      log.debug(`[${correlationId}] Permission request toolCall content: ${JSON.stringify(params.toolCall.content)}`);
    }

    try {
      const selectedOptionId = await this.handlePermissionRequest(correlationId, params.options, title);
      return { outcome: { outcome: 'selected' as const, optionId: selectedOptionId } };
    } catch (err: unknown) {
      log.warn('Permission request failed', err);
      return { outcome: { outcome: 'cancelled' as const } };
    }
  };

  // ---------------------------------------------------------------------------
  // Public — model/mode queries and configuration
  // ---------------------------------------------------------------------------

  /** Apply the runtime-selected model/mode to a session. Best-effort — errors are logged, not thrown. */
  private async applySessionConfig(session: AcpAgentSession): Promise<void> {
    try {
      if (this.selectedModel) {
        await session.setModel(this.selectedModel);
      }
      if (this.selectedMode) {
        await session.setMode(this.selectedMode);
      }
    } catch (err: unknown) {
      log.warn(`Failed to apply session config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  listModels(): AgentSessionConfig | undefined {
    return this.representativeSession?.listModels();
  }

  listModes(): AgentSessionConfig | undefined {
    return this.representativeSession?.listModes();
  }

  async configureAgent(input: ConfigureAgentInput): Promise<void> {
    const targets = input.sessionId
      ? ([this.acpSessions.get(input.sessionId)].filter(Boolean) as AcpAgentSession[])
      : [...this.acpSessions.values()];

    const promises: Promise<void>[] = [];
    for (const session of targets) {
      if (input.model) {
        promises.push(session.setModel(input.model));
      }
      if (input.mode) {
        promises.push(session.setMode(input.mode));
      }
    }
    await Promise.all(promises);

    if (input.model) {
      this.selectedModel = input.model;
    }
    if (input.mode) {
      this.selectedMode = input.mode;
    }
    log.info(`Configured ${String(targets.length)} session(s): model=${input.model ?? '-'}, mode=${input.mode ?? '-'}`);
  }

  // ---------------------------------------------------------------------------
  // Session factory
  // ---------------------------------------------------------------------------

  protected async createSession(): Promise<AgentSession> {
    const config = this.config.acp;
    if (!config) {
      throw new Error('ACP config missing');
    }

    log.info('Creating new ACP session...');
    const conn = this.getConnection();

    const result = await conn.newSession({
      cwd: config.cwd,
      mcpServers: buildMcpServers(this.mcpSocketPath),
    });

    const session = new AcpAgentSession({
      correlationId: result.sessionId,
      connection: conn,
      permissionHandler: this.permissionHandler,
      sessionResponse: result,
      disposable: this.supportsClose,
    });
    this.acpSessions.set(result.sessionId, session);
    log.info(`Session created: ${result.sessionId}`);

    await this.applySessionConfig(session);

    // Send Newio instruction as the first prompt so the session has context
    log.debug(`[${result.sessionId}] Sending Newio instruction to new session`);
    const instruction = this.promptManager.buildNewioInstruction();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of session.prompt(instruction)) {
      // discard
    }
    log.debug(`[${result.sessionId}] Newio instruction delivered`);

    return session;
  }

  protected async resumeSession(correlationId: string): Promise<AgentSession> {
    const config = this.config.acp;
    if (!config) {
      throw new Error('ACP config missing');
    }

    log.info(`Resuming ACP session: ${correlationId}`);
    const conn = this.getConnection();

    const loadResult = await conn.loadSession({
      sessionId: correlationId,
      cwd: config.cwd,
      mcpServers: buildMcpServers(this.mcpSocketPath),
    });

    const session = new AcpAgentSession({
      correlationId,
      connection: conn,
      permissionHandler: this.permissionHandler,
      sessionResponse: loadResult,
      disposable: this.supportsClose,
    });
    this.acpSessions.set(correlationId, session);
    log.info(`Session resumed: ${correlationId}`);

    await this.applySessionConfig(session);

    return session;
  }

  // ---------------------------------------------------------------------------
  // acp.Client — routed to the correct session
  // ---------------------------------------------------------------------------

  sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const session = this.acpSessions.get(params.sessionId);
    if (session) {
      session.handleSessionUpdate(params);
    } else {
      log.warn(`sessionUpdate for unknown session: ${params.sessionId}`);
    }
    return Promise.resolve();
  }

  requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const session = this.acpSessions.get(params.sessionId);
    if (session) {
      return session.handleRequestPermission(params);
    }
    log.warn(`requestPermission for unknown session: ${params.sessionId}`);
    return Promise.resolve({ outcome: { outcome: 'cancelled' } });
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.readFile(params.path, 'utf-8');
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.writeFile(params.path, params.content, 'utf-8');
    return {};
  }

  extMethod(method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> {
    log.debug(`ext method: ${method}`);
    return Promise.resolve({});
  }

  extNotification(method: string, _params: Record<string, unknown>): Promise<void> {
    log.debug(`ext notification: ${method}`);
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Greeting
  // ---------------------------------------------------------------------------

  private async sendGreeting(): Promise<AcpAgentSession> {
    if (!this.app.identity.ownerId) {
      log.warn('No ownerId set, skipping greeting');
      // Still need a representative session — create one for the owner DM
      const session = (await this.getOrCreateSession(await this.getOwnerDmOrThrow())) as AcpAgentSession;
      session.disposable = false;
      return session;
    }

    const ownerDmConversationId = await this.getOwnerDmOrThrow();
    log.debug(`Owner DM conversation: ${ownerDmConversationId}`);

    this.setStatus('greeting');
    const session = (await this.getOrCreateSession(ownerDmConversationId)) as AcpAgentSession;
    session.disposable = false;
    log.debug(`[${session.correlationId}] Generating greeting for owner...`);

    let greeting: string | undefined;
    try {
      greeting = await collectAgentMessage(session.prompt(this.promptManager.buildGreetingPrompt()));
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      log.error(`[${session.correlationId}] Greeting prompt failed: ${message}`);
      throw new Error(`ACP agent connection test failed: ${message}`);
    }

    if (!greeting || greeting.trim().length === 0) {
      log.error(`[${session.correlationId}] Agent returned empty greeting`);
      throw new Error('ACP agent test failed: agent returned an empty response');
    }

    await this.app.sendMessage(ownerDmConversationId, greeting.trim());
    log.info(`[${session.correlationId}] Greeting sent to owner`);

    return session;
  }

  private async getOwnerDmOrThrow(): Promise<string> {
    const convId = await this.app.getOwnerDmConversationId();
    if (!convId) {
      throw new Error('Could not get owner DM conversation');
    }
    return convId;
  }
}

/** Drain a prompt generator and return concatenated agent_message text. */
async function collectAgentMessage(gen: AsyncGenerator<SessionStreamSegment>): Promise<string | undefined> {
  const parts: string[] = [];
  for await (const segment of gen) {
    if (segment.type === 'agent_message_chunk') {
      parts.push(segment.text);
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
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

function resolveBridgePath(): string {
  return require.resolve('@newio/mcp-server/bridge');
}
