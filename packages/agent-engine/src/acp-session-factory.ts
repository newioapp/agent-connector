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
import { AcpAgentSession } from './acp-agent-session';
import type { AgentSession } from './agent-session';
import type { AgentConfig, CreateSessionInput, ResumeSessionInput, SessionFactory } from './types';
import type { AgentInfo } from './types';
import { getLogger } from '@newio/agent-sdk';
import { resolveCommand } from './utils';
import { inheritedBaseEnv } from './env-capture.js';
import { InvalidEnvironmentError, InvalidWorkingDirectoryError } from './errors.js';

const log = getLogger('acp-session-factory');

/**
 * Grace period after asking the ACP child to terminate (stdin EOF + SIGTERM)
 * before escalating to SIGKILL. Well-behaved agents exit within milliseconds of
 * SIGTERM; this only bounds one that ignores it.
 */
const GRACEFUL_EXIT_TIMEOUT_MS = 5000;

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

export class AcpSessionFactory implements acp.Client, SessionFactory {
  private childProcess?: ChildProcess;
  private connection?: ClientSideConnection;
  private abnormalTerminationHandler?: (details: string) => void;

  /**
   * Whether the ACP child has exited. Tracked explicitly because `exitCode` is
   * `null` for a signal-killed child (only `signalCode` is set), and because the
   * `exit` event fires once — re-attaching a listener after the fact never
   * resolves. A foreground Ctrl-C signals the whole process group, so the child
   * often dies a tick before teardown observes it.
   */
  private childExited = false;

  /** Resolves when the ACP child exits. Re-armed on each spawn. */
  private childExitPromise: Promise<void> = Promise.resolve();
  private resolveChildExit: () => void = () => {};

  /** correlationId → live session, for routing acp.Client callbacks. */
  private readonly acpSessions = new Map<string, AcpAgentSession>();

  /** Whether the ACP agent supports session/close. */
  private supportsClose = false;

  /** Buffered session updates received before the session was registered. */
  private readonly pendingUpdates = new Map<string, acp.SessionNotification[]>();

  /** Buffered ext notifications received before the session was registered. */
  private readonly pendingExtNotifications = new Map<string, { method: string; params: Record<string, unknown> }[]>();

  /** Runtime agent info — populated after ACP initialization. */
  private agentInfo?: AgentInfo;

  /** Set to true when stop/kill is intentional — prevents the exit handler from treating it as unexpected. */
  private stopping = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly appDisplayName: string,
    private readonly appVersion: string,
    private readonly logTag: string,
    /**
     * When true, the MCP bridge is self-contained (a SEA binary) and needs no
     * system `node`, so the startup node-availability preflight is skipped.
     */
    private readonly mcpBridgeIsSelfContained: boolean = false,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    log.info(`${this.logTag} ACP agent instance connected, spawning ACP process...`);
    if (!this.config.acp) {
      throw new Error('ACP config missing');
    }

    // A self-contained (SEA) bridge re-invokes our own binary and needs no
    // system `node`; only verify node when the bridge launches via `node`.
    if (!this.mcpBridgeIsSelfContained) {
      await assertNodeAvailable(this.config.envVars);
    }
    await this.spawnAndInit();
  }

  /**
   * Flag an intentional stop before the session manager teardown causes the ACP
   * child to exit. The `exit` handler checks this flag to decide whether the exit
   * was expected — set it early so a normal shutdown isn't treated as abnormal.
   */
  markStopping(): void {
    this.stopping = true;
  }

  async terminate(): Promise<void> {
    log.info(`${this.logTag} ACP agent instance stopping...`);
    this.stopping = true;
    this.acpSessions.clear();
    this.pendingUpdates.clear();
    this.pendingExtNotifications.clear();
    this.connection = undefined;
    await this.killProcess();
  }

  onAbnormalTermination(abnormalTerminationHandler: (details: string) => void): void {
    this.abnormalTerminationHandler = abnormalTerminationHandler;
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
    this.childExited = false;
    this.childExitPromise = new Promise<void>((resolve) => {
      this.resolveChildExit = resolve;
    });

    const { cwd } = config;
    const { command, args } = resolveCommand(this.config.type, config);

    // Validate the working directory before spawn: a missing/invalid cwd makes
    // `spawn` fail with an ENOENT that's indistinguishable from a missing
    // executable, which otherwise gets misreported as "node not in PATH" (#277).
    // An empty cwd means "inherit" (matches the spawn options below), so skip it.
    if (cwd) {
      await assertWorkingDirectory(cwd);
    }

    log.info(`${this.logTag} Spawning: ${command} ${args.join(' ')}`);

    const child = await spawnAsync(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Allowlisted identity vars from the host (USER/HOME/…), then the agent's
      // configured env overlaid on top. The base is just a safety net so identity
      // vars (which Claude Code keys its Keychain credential by) survive even if a
      // config omits them; for `basic`/`all` the configured env already has them
      // and wins here.
      env: { ...inheritedBaseEnv(), ...this.config.envVars, TERM: 'dumb' },
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
      this.childExited = true;
      this.resolveChildExit();
      log.info(`${this.logTag} ACP agent exited (code=${String(code)}, signal=${String(signal)})`);
      if (!this.stopping) {
        this.childProcess = undefined;
        this.connection = undefined;
        const stderr = stderrChunks.join('\n').trim();
        const detail = stderr || `code=${String(code)}, signal=${String(signal)}`;
        if (this.abnormalTerminationHandler) {
          this.abnormalTerminationHandler(`Agent process exited unexpectedly.\n\n${detail}`);
        }
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
      clientInfo: { name: this.appDisplayName, version: this.appVersion },
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
  }

  private async killProcess(): Promise<void> {
    const child = this.childProcess;
    if (!child) {
      return;
    }

    this.stopping = true;
    this.childProcess = undefined;

    // Already gone? Don't wait. A foreground Ctrl-C signals the whole process
    // group, so the child is usually dead well before we get here. Note a
    // signal-killed child has exitCode === null and signalCode set, so the old
    // `exitCode !== null` check (and a freshly-attached `exit` listener that
    // never fires again) would wait the full 5s before a pointless SIGKILL.
    if (this.hasChildExited(child)) {
      log.info(`${this.logTag} ACP process already exited`);
      return;
    }

    // Arm the exit waiter BEFORE signalling, so a fast exit can't slip between
    // the kill and the listener attach. (Safe today — there's no await between
    // them — but this keeps the ordering mechanically correct against future
    // edits. The synchronous hasChildExited check covers an exit that already
    // happened before this point.)
    const exitedPromise = new Promise<boolean>((resolve) => {
      child.once('exit', () => resolve(true));
      if (this.hasChildExited(child)) {
        resolve(true);
      }
    });

    // Ask the child to shut down. Close stdin (the ACP agent sees EOF on its
    // client connection) AND send SIGTERM — closing stdin alone isn't enough:
    // some ACP agents don't exit on EOF and would otherwise sit until the
    // SIGKILL timeout. (Under a foreground Ctrl-C the child already got SIGINT
    // and we returned above, so SIGTERM is only ever sent in daemon mode.)
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.end();
    }
    child.kill('SIGTERM');

    // Wait for graceful exit, then force kill. Capture the timer so the exit
    // branch winning the race clears it — otherwise a clean stop leaves a live
    // 5s handle that keeps the event loop alive (masked by process.exit in the
    // daemon path, but stalls embedded AgentRuntimeManager.stop() and leaks an
    // open handle in tests).
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      exitedPromise,
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), GRACEFUL_EXIT_TIMEOUT_MS);
      }),
    ]);
    if (graceTimer) {
      clearTimeout(graceTimer);
    }

    if (!exited) {
      log.warn(
        `${this.logTag} Child process did not exit within ${GRACEFUL_EXIT_TIMEOUT_MS / 1000}s of SIGTERM, sending SIGKILL`,
      );
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

  getAgentInfo(): AgentInfo | undefined {
    return this.agentInfo;
  }

  // ---------------------------------------------------------------------------
  // Session factory
  // ---------------------------------------------------------------------------
  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    const config = this.config.acp;
    if (!config) {
      throw new Error('ACP config missing');
    }

    log.info(`${this.logTag} Creating new ACP session...`);
    const conn = this.getConnection();

    const result = await conn.newSession({
      cwd: config.cwd,
      mcpServers: buildMcpServers(input.mcpSocketPath, input.mcpBridgeCommand, input.mcpBridgeArgsPrefix),
    });

    const session = new AcpAgentSession({
      type: input.type,
      externalReferenceId: input.externalReferenceId,
      promptFormatterVersion: input.promptFormatterVersion,
      correlationId: result.sessionId,
      connection: conn,
      sessionResponse: result,
      disposable: this.supportsClose,
      resumed: false,
      username: this.config.newio?.username,
      skipToken: input.skipToken,
      updateConfig: input.updateConfig,
      reportContextWindow: input.reportContextWindow,
    });
    this.registerSession(result.sessionId, session);
    log.info(`${this.logTag} Session created: ${result.sessionId}`);

    return session;
  }

  async resumeSession(input: ResumeSessionInput): Promise<AgentSession> {
    const config = this.config.acp;
    if (!config) {
      throw new Error('ACP config missing');
    }

    log.info(`${this.logTag} Resuming ACP session: ${input.correlationId}`);
    const conn = this.getConnection();

    const loadResult = await conn.loadSession({
      sessionId: input.correlationId,
      cwd: config.cwd,
      mcpServers: buildMcpServers(input.mcpSocketPath, input.mcpBridgeCommand, input.mcpBridgeArgsPrefix),
    });

    const session = new AcpAgentSession({
      type: input.type,
      externalReferenceId: input.externalReferenceId,
      promptFormatterVersion: input.promptFormatterVersion,
      correlationId: input.correlationId,
      connection: conn,
      sessionResponse: loadResult,
      disposable: this.supportsClose,
      resumed: true,
      username: this.config.newio?.username,
      skipToken: input.skipToken,
      updateConfig: input.updateConfig,
      reportContextWindow: input.reportContextWindow,
    });
    this.registerSession(input.correlationId, session);
    log.info(`${this.logTag} Session resumed: ${input.correlationId}`);

    return session;
  }

  /** Register a session and replay any buffered updates received during initialization. */
  private registerSession(correlationId: string, session: AcpAgentSession): void {
    this.acpSessions.set(correlationId, session);
    const buffered = this.pendingUpdates.get(correlationId);
    if (buffered) {
      this.pendingUpdates.delete(correlationId);
      // Only replay available-commands updates — skip historical content (tool calls, messages, etc.).
      // Mode/config-option state is established via the setSessionConfigOption flow (seeded from the
      // session response, reconciled by reportConfig), so replaying buffered copies only risks
      // surfacing stale/duplicate state.
      const replayable = new Set(['available_commands_update']);
      for (const update of buffered) {
        if (replayable.has(update.update.sessionUpdate)) {
          session.handleSessionUpdate(update);
        }
      }
      log.debug(`${this.logTag} Replayed buffered update(s) for ${correlationId}`);
    }
    const bufferedExt = this.pendingExtNotifications.get(correlationId);
    if (bufferedExt) {
      this.pendingExtNotifications.delete(correlationId);
      for (const { method, params } of bufferedExt) {
        if (method === '_kiro.dev/commands/available') {
          session.handleExtNotification(method, params);
        }
      }
      log.debug(`${this.logTag} Replayed buffered extNotification(s) for ${correlationId}`);
    }
  }

  async destroySession(correlationId: string): Promise<void> {
    const session = this.acpSessions.get(correlationId);
    this.acpSessions.delete(correlationId);
    if (!session || !session.disposable) {
      return;
    }
    // A foreground Ctrl-C delivers SIGINT to the whole process group, so the ACP
    // child can already be dead by the time we tear sessions down. Issuing the
    // graceful session/close RPC against a dead process blocks waiting for a
    // response that never arrives — skip it when the child is already gone.
    if (this.hasChildExited(this.childProcess)) {
      log.debug(`${this.logTag} ACP process already exited — skipping session/close for ${correlationId}`);
      return;
    }
    // The child may die mid-dispose: the exit event lags the SIGINT by a tick,
    // so it can still look alive above yet expire while session/close is in
    // flight. Race the close against the child exiting so a doomed RPC can't
    // stall teardown for the full close timeout.
    await Promise.race([session.dispose(), this.childExitPromise]);
  }

  /**
   * Whether the ACP child has exited. True if the explicit flag is set, the
   * child reference is gone, or the process reports an exit code/signal.
   */
  private hasChildExited(child: ChildProcess | undefined): boolean {
    return this.childExited || !child || child.exitCode !== null || child.signalCode !== null;
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

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (/error|failure/i.test(method)) {
      log.warn(`${this.logTag} ext notification: ${method}`, JSON.stringify(params));
    } else {
      log.debug(`${this.logTag} ext notification: ${method}`);
    }

    // Route to session if sessionId is present
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    if (sessionId) {
      const session = this.acpSessions.get(sessionId);
      if (session) {
        session.handleExtNotification(method, params);
      } else {
        // Session still initializing — buffer for replay after registration
        let buffered = this.pendingExtNotifications.get(sessionId);
        if (!buffered) {
          buffered = [];
          this.pendingExtNotifications.set(sessionId, buffered);
        }
        buffered.push({ method, params });
        log.debug(`${this.logTag} Buffered extNotification for pending session: ${sessionId}`);
      }
    }

    return Promise.resolve();
  }
}

function buildMcpServers(
  mcpSocketPath: string,
  mcpBridgeCommand: string,
  mcpBridgeArgsPrefix: readonly string[],
): AcpMcpServer[] {
  const args = [...mcpBridgeArgsPrefix, mcpSocketPath];
  log.debug(`MCP bridge: ${mcpBridgeCommand} ${args.join(' ')}`);
  return [
    {
      name: 'newio',
      command: mcpBridgeCommand,
      args,
      env: [],
    },
  ];
}

/** Verify the agent's configured working directory exists and is a directory. */
export async function assertWorkingDirectory(cwd: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(cwd);
  } catch {
    throw new InvalidWorkingDirectoryError(`The agent's working directory does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new InvalidWorkingDirectoryError(`The agent's working directory is not a directory: ${cwd}`);
  }
}

/** Verify that `node` is available on the system PATH (required for the Newio MCP bridge). */
async function assertNodeAvailable(env?: Record<string, string>): Promise<void> {
  const { execFile } = await import('child_process');
  await new Promise<void>((resolve, reject) => {
    // Mirror the agent spawn env (allowlisted base + configured overlay) so the
    // check validates the same PATH the agent process will actually run with.
    execFile('node', ['--version'], { env: { ...inheritedBaseEnv(), ...env, TERM: 'dumb' } }, (err) => {
      if (err) {
        reject(
          new InvalidEnvironmentError(
            '"node" is not available on the agent\'s PATH. Node.js is required to run the Newio MCP server. ' +
              "Ensure Node.js is installed and that the agent's PATH points to it.",
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
