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
import type { AgentSession } from './agent-session';
import type { AgentSessionConfig, ConfigureAgentInput } from './agent-instance';
import type { SessionStreamSegment } from './types';
import { resolveCommand, extractErrorMessage } from './types';
import type { AgentInfo } from './types';
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

  /** Buffered session updates received before the session was registered. */
  private readonly pendingUpdates = new Map<string, acp.SessionNotification[]>();

  /** Runtime agent info — populated after ACP initialization. */
  private agentInfo?: AgentInfo;

  /** Set to true when stop/kill is intentional — prevents the exit handler from treating it as unexpected. */
  private stopping = false;

  /** Cached model/mode config — copied from the greeting session, updated on config changes. */
  private cachedModels?: AgentSessionConfig;
  private cachedModes?: AgentSessionConfig;

  /** Runtime-selected model — applied to new sessions. */
  private selectedModel?: string;

  /** Runtime-selected mode — applied to new sessions. */
  private selectedMode?: string;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected async onConnected(ownerDmConversationId: string): Promise<void> {
    log.info(`${this.logTag} ACP agent instance connected, spawning ACP process...`);
    if (!this.config.acp) {
      throw new Error('ACP config missing');
    }

    await assertNodeAvailable(this.config.envVars);
    await this.spawnAndInit();
    await this.sendGreeting(ownerDmConversationId);
  }

  protected async onStopped(): Promise<void> {
    log.info(`${this.logTag} ACP agent instance stopping...`);
    this.stopping = true;
    this.cachedModels = undefined;
    this.cachedModes = undefined;
    this.selectedModel = undefined;
    this.selectedMode = undefined;
    this.acpSessions.clear();
    this.pendingUpdates.clear();
    this.connection = undefined;
    await this.killProcess();
  }

  protected onSessionDisposed(correlationId: string): void {
    this.acpSessions.delete(correlationId);
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

    log.info(`${this.logTag} Spawning: ${command} ${args.join(' ')}`);

    const child = await spawnAsync(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...this.config.envVars, TERM: 'dumb' },
      ...(cwd ? { cwd } : {}),
    });

    const stderrChunks: string[] = [];
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trimEnd();
      log.debug(`${this.logTag} [acp stderr] ${text}`);
      stderrChunks.push(text);
      // Keep only the last 20 lines to bound memory
      if (stderrChunks.length > 20) {
        stderrChunks.shift();
      }
    });

    child.on('error', (err) => {
      log.error(`${this.logTag} ACP agent process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      log.info(`${this.logTag} ACP agent exited (code=${String(code)}, signal=${String(signal)})`);
      if (!this.stopping) {
        this.childProcess = undefined;
        this.connection = undefined;
        const stderr = stderrChunks.join('\n').trim();
        const detail = stderr || `code=${String(code)}, signal=${String(signal)}`;
        this.pendingCleanup = this.cleanup()
          .then(() => this.onStopped())
          .then(() => {
            this.setStatus('error', `Agent process exited unexpectedly.\n\n${detail}`);
          })
          .finally(() => {
            this.pendingCleanup = undefined;
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
    log.info(`${this.logTag} ACP initialized (protocol v${String(initResult.protocolVersion)})`);

    // Validate loadSession capability
    if (!initResult.agentCapabilities?.loadSession) {
      await this.killProcess();
      throw new Error(
        `ACP agent "${initResult.agentInfo?.name ?? 'unknown'}" does not support loadSession. ` +
          'The Agent Connector requires loadSession capability to route conversations.',
      );
    }

    this.supportsClose = initResult.agentCapabilities.sessionCapabilities?.close != null;
    log.info(`${this.logTag} ACP session/close supported: ${String(this.supportsClose)}`);
    log.debug(`${this.logTag} ACP init result`, JSON.stringify(initResult));

    this.agentInfo = buildAgentInfo(initResult);
    this.listener.onAgentInfo(this.agentInfo);
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

    // Wait for graceful exit via stdin EOF, then force kill
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
      log.warn(`${this.logTag} Child process did not exit within 5s, sending SIGKILL`);
      child.kill('SIGKILL');
    }

    log.info(`${this.logTag} ACP process terminated`);
  }

  private getConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error('ACP connection not initialized');
    }
    return this.connection;
  }

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
      log.warn(`${this.logTag} Failed to apply session config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getAgentInfo(): AgentInfo | undefined {
    return this.agentInfo;
  }

  listModels(): AgentSessionConfig | undefined {
    return this.cachedModels;
  }

  listModes(): AgentSessionConfig | undefined {
    return this.cachedModes;
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
    log.info(
      `${this.logTag} Configured ${String(targets.length)} session(s): model=${input.model ?? '-'}, mode=${input.mode ?? '-'}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Session factory
  // ---------------------------------------------------------------------------

  protected async createSession(newioSessionId: string): Promise<AgentSession> {
    const config = this.config.acp;
    if (!config) {
      throw new Error('ACP config missing');
    }

    log.info(`${this.logTag} Creating new ACP session...`);
    const conn = this.getConnection();

    const result = await conn.newSession({
      cwd: config.cwd,
      mcpServers: buildMcpServers(this.mcpSocketPath),
    });

    const instruction = this.promptManager.buildNewioInstruction();
    const session = new AcpAgentSession({
      sessionId: newioSessionId,
      promptFormatterVersion: instruction.version,
      correlationId: result.sessionId,
      connection: conn,
      sessionResponse: result,
      disposable: this.supportsClose,
      username: this.config.newio?.username,
    });
    this.registerSession(result.sessionId, session);
    log.info(`${this.logTag} Session created: ${result.sessionId}`);

    await this.applySessionConfig(session);

    // Send Newio instruction as the first prompt so the session has context
    log.debug(`${this.logTag} [${result.sessionId}] Sending Newio instruction to new session`);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of session.prompt(instruction.prompt)) {
      // discard
    }
    log.debug(`${this.logTag} [${result.sessionId}] Newio instruction delivered`);

    return session;
  }

  protected async resumeSession(
    newioSessionId: string,
    correlationId: string,
    promptFormatterVersion: string,
  ): Promise<AgentSession> {
    const config = this.config.acp;
    if (!config) {
      throw new Error('ACP config missing');
    }

    log.info(`${this.logTag} Resuming ACP session: ${correlationId}`);
    const conn = this.getConnection();

    const loadResult = await conn.loadSession({
      sessionId: correlationId,
      cwd: config.cwd,
      mcpServers: buildMcpServers(this.mcpSocketPath),
    });

    const session = new AcpAgentSession({
      sessionId: newioSessionId,
      promptFormatterVersion: promptFormatterVersion,
      correlationId,
      connection: conn,
      sessionResponse: loadResult,
      disposable: this.supportsClose,
      username: this.config.newio?.username,
    });
    this.registerSession(correlationId, session);
    log.info(`${this.logTag} Session resumed: ${correlationId}`);

    await this.applySessionConfig(session);

    return session;
  }

  /** Register a session and replay any buffered updates received during initialization. */
  private registerSession(correlationId: string, session: AcpAgentSession): void {
    this.acpSessions.set(correlationId, session);
    const buffered = this.pendingUpdates.get(correlationId);
    if (buffered) {
      this.pendingUpdates.delete(correlationId);
      // for (const update of buffered) {
      //   session.handleSessionUpdate(update);
      // }
      log.debug(`${this.logTag} Replayed ${String(buffered.length)} buffered update(s) for ${correlationId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // acp.Client — routed to the correct session
  // ---------------------------------------------------------------------------

  sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const session = this.acpSessions.get(params.sessionId);
    if (session) {
      session.handleSessionUpdate(params);
    } else {
      // Session still initializing — buffer for replay after registration
      let buffered = this.pendingUpdates.get(params.sessionId);
      if (!buffered) {
        buffered = [];
        this.pendingUpdates.set(params.sessionId, buffered);
      }
      buffered.push(params);
      log.debug(`${this.logTag} Buffered sessionUpdate for pending session: ${params.sessionId}`);
    }
    return Promise.resolve();
  }

  requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const session = this.acpSessions.get(params.sessionId);
    if (session) {
      return session.handleRequestPermission(params);
    }
    log.warn(`${this.logTag} requestPermission for unknown session: ${params.sessionId}`);
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
    log.debug(`${this.logTag} ext method: ${method}`);
    return Promise.resolve({});
  }

  extNotification(method: string, _params: Record<string, unknown>): Promise<void> {
    log.debug(`${this.logTag} ext notification: ${method}`);
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Greeting
  // ---------------------------------------------------------------------------

  private async sendGreeting(ownerDmConversationId: string): Promise<void> {
    log.debug(`${this.logTag} Owner DM conversation: ${ownerDmConversationId}`);

    this.setStatus('greeting');
    const session = await this.getOrCreateSession(ownerDmConversationId);
    log.debug(`${this.logTag} [${session.correlationId}] Generating greeting for owner...`);

    let greeting: string | undefined;
    try {
      greeting = await collectAgentMessage(
        session.prompt(this.promptManager.buildGreetingPrompt(session.promptFormatterVersion), ownerDmConversationId),
      );
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      log.error(`${this.logTag} [${session.correlationId}] Greeting prompt failed: ${message}`);
      throw new Error(`ACP agent connection test failed: ${message}`);
    }

    if (!greeting || greeting.trim().length === 0) {
      log.error(`${this.logTag} [${session.correlationId}] Agent returned empty greeting`);
      throw new Error('ACP agent test failed: agent returned an empty response');
    }

    await this.app.sendMessage(ownerDmConversationId, greeting.trim());
    log.info(`${this.logTag} [${session.correlationId}] Greeting sent to owner`);

    // Cache initial models/modes and listen for config changes from the ACP agent
    this.cachedModels = session.listModels();
    this.cachedModes = session.listModes();
    session.onConfigChanged(() => {
      this.cachedModels = session.listModels();
      this.cachedModes = session.listModes();
      if (this.cachedModels?.selectedId) {
        this.selectedModel = this.cachedModels.selectedId;
      }
      if (this.cachedModes?.selectedId) {
        this.selectedMode = this.cachedModes.selectedId;
      }
      this.listener.onAgentSessionConfigUpdated(session.correlationId, this.cachedModels, this.cachedModes);
    });
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
  const bridgePath = require.resolve('@newio/mcp-server/bridge');
  log.debug(`MCP bridge path: ${bridgePath}`);
  return [
    {
      name: 'newio',
      command: 'node',
      args: [bridgePath, mcpSocketPath],
      env: [],
    },
  ];
}

/** Verify that `node` is available on the system PATH (required for the Newio MCP bridge). */
async function assertNodeAvailable(env?: Record<string, string>): Promise<void> {
  const { execFile } = await import('child_process');
  await new Promise<void>((resolve, reject) => {
    execFile('node', ['--version'], { env: { ...env, TERM: 'dumb' } }, (err) => {
      if (err) {
        reject(
          new Error(
            '"node" is not available on your system PATH. Node.js is required to run the Newio MCP server.\n\n' +
              'Ensure Node.js is installed and available on your system PATH. (Check the Environment Variables tab.)',
          ),
        );
      } else {
        resolve();
      }
    });
  });
}

/** Build a protocol-agnostic AgentInfo from an ACP InitializeResponse. */
function buildAgentInfo(res: acp.InitializeResponse): AgentInfo {
  const caps = res.agentCapabilities;
  return {
    protocol: 'acp',
    protocolVersion: String(res.protocolVersion),
    agentName: res.agentInfo?.name,
    agentVersion: res.agentInfo?.version,
    agentTitle: res.agentInfo?.title ?? undefined,
    capabilities: [
      { name: 'loadSession', enabled: caps?.loadSession === true },
      { name: 'listSessions', enabled: caps?.sessionCapabilities?.list !== undefined },
      { name: 'closeSessions', enabled: caps?.sessionCapabilities?.close !== undefined },
      { name: 'audio', enabled: caps?.promptCapabilities?.audio === true },
      { name: 'image', enabled: caps?.promptCapabilities?.image === true },
      { name: 'embeddedContext', enabled: caps?.promptCapabilities?.embeddedContext === true },
      { name: 'mcp:http', enabled: caps?.mcpCapabilities?.http === true },
      { name: 'mcp:sse', enabled: caps?.mcpCapabilities?.sse === true },
    ],
    authMethods: res.authMethods?.map((m) => ({
      id: m.id,
      name: m.name,
      type: 'type' in m ? (m.type as string) : 'agent',
      description: m.description ?? undefined,
    })),
  };
}
