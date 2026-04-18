/**
 * Base agent instance — shared auth, WebSocket, session routing, and lifecycle logic.
 *
 * Uses NewioApp for all Newio interactions. Manages multiple sessions per agent,
 * routing incoming events by type:
 * - Messages: routed by conversationId → newioSessionId
 * - Contact events: routed to the owner DM session
 * - Cron triggers: routed to the session that created the cron job
 *
 * Each session processes its own event queue concurrently.
 * Subclasses implement session creation and greeting logic.
 */
import { ApprovalTimeoutError, NewioApp, NotFoundApiError } from '@newio/sdk';
import type { IncomingMessage, ContactEvent, CronTriggerEvent, ActionOption, ActionRequest } from '@newio/sdk';
import { NewioMcpServer, startUdsServer } from '@newio/mcp-server';
import type { Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentConfigManager } from './agent-config-manager';
import type { AgentRuntimeStatus, AgentConfig } from './types';
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS, resolveCommand } from './types';
import type { AgentInstance, AgentInstanceListener } from './agent-instance';
import type { AgentSessionConfig, ConfigureAgentInput } from './agent-instance';
import type { AgentSession } from './agent-session';
import type { SessionStore } from './session-store';
import { EventQueue } from './event-queue';
import type { AgentEvent } from './event-queue';
import { PromptManager } from './prompt-manager';
import { Logger } from './logger';
import WebSocket from 'ws';

const log = new Logger('base-agent-instance');

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** A running session with its own event queue and processing loop. */
interface SessionRunner {
  readonly session: AgentSession;
  readonly queue: EventQueue;
  lastActivityAt: number;
}

export abstract class BaseAgentInstance implements AgentInstance {
  status: AgentRuntimeStatus = 'stopped';
  error?: string;

  private _app?: NewioApp;
  private _promptManager?: PromptManager;

  /** newioSessionId → running session with its own event queue */
  private readonly runners = new Map<string, SessionRunner>();
  /** newioSessionId → in-flight creation/resume promise (dedup concurrent calls) */
  private readonly pendingSessions = new Map<string, Promise<SessionRunner>>();
  /** Serializes session launches so only one runs at a time (protects latestMcpServer wiring). */
  private launchQueue: Promise<void> = Promise.resolve();
  /** correlationId → conversationId currently being processed */
  private readonly activeConversation = new Map<string, string>();
  private abortController?: AbortController;
  private idleTimer?: ReturnType<typeof setInterval>;
  private cleaningUp = false;
  private udsServer?: Server;
  /** Most recently created MCP server awaiting a sessionId to be wired. */
  private pendingMcpServer?: NewioMcpServer;

  /** Socket path for the MCP UDS server. Set after auth in start(). */
  protected mcpSocketPath?: string;

  constructor(
    protected readonly config: AgentConfig,
    protected readonly configManager: AgentConfigManager,
    protected readonly sessionStore: SessionStore,
    protected readonly listener: AgentInstanceListener,
  ) {}

  async start(): Promise<void> {
    const abortController = new AbortController();
    this.abortController = abortController;
    this.setStatus('starting');
    log.info('Starting agent');

    try {
      const storedTokens = this.configManager.getTokens(this.config.id);
      log.debug(storedTokens ? 'Found persisted tokens' : 'No persisted tokens, will run auth flow');

      this._app = await NewioApp.create({
        agentId: this.config.newio?.agentId,
        username: this.config.newio?.username,
        name: this.config.newio?.displayName ?? 'Agent',
        apiBaseUrl: __API_BASE_URL__,
        wsUrl: __WS_BASE_URL__,
        wsFactory: (url) => new WebSocket(url) as never,
        tokens: storedTokens,
        signal: abortController.signal,
        onApprovalUrl: (url) => {
          log.info('Awaiting approval', url);
          this.listener.onApprovalUrl(url);
          this.setStatus('awaiting_approval');
        },
        onPollAttempt: () => {
          this.listener.onPollAttempt();
        },
        onTokens: (tokens) => {
          log.debug('Tokens received, persisting');
          this.configManager.setTokens(this.config.id, tokens);
        },
      });

      const app = this._app;

      // Sync profile to config
      const { userId, username, displayName } = app.identity;
      log.info(`Authenticated as ${username} (${userId})`);
      this.configManager.setNewioIdentity(this.config.id, {
        agentId: userId,
        username,
        displayName,
        avatarUrl: app.identity.avatarUrl,
      });
      this.listener.onConfigUpdated();

      this.setStatus('initializing');
      const mcpSocketPath = join(tmpdir(), `newio-mcp-${username}.sock`);
      this.mcpSocketPath = mcpSocketPath;

      await app.init();

      app.onDisconnect(() => {
        if (!abortController.signal.aborted) {
          log.warn('WebSocket disconnected unexpectedly');
          this.setStatus('error', 'WebSocket disconnected');
        }
      });

      // Wire event handlers
      app.on('message.new', (msg) => {
        if (!msg.isOwnMessage) {
          void this.routeMessage(msg);
        }
      });

      app.on('contact.event', (event) => {
        void this.routeContactEvent(event);
      });

      app.on('cron.triggered', (event) => {
        void this.routeCronEvent(event);
      });

      app.on('cron.scheduled', (def) => {
        this.sessionStore.saveCron(this.config.id, def);
      });

      app.on('cron.cancelled', (cronId) => {
        this.sessionStore.deleteCron(cronId);
      });

      // Reload persisted cron jobs
      const savedCrons = this.sessionStore.listCrons(this.config.id);
      for (const cron of savedCrons) {
        try {
          app.scheduleCron(cron);
          log.info(`Restored cron ${cron.cronId}: "${cron.label}"`);
        } catch (err: unknown) {
          log.warn(`Failed to restore cron ${cron.cronId}`, err);
          this.sessionStore.deleteCron(cron.cronId);
        }
      }

      // Start MCP server on UDS for agent sessions
      this._promptManager = new PromptManager(app);

      this.udsServer = startUdsServer({
        socketPath: mcpSocketPath,
        onConnection: (transport) => {
          log.info(`MCP client connected via ${mcpSocketPath}`);
          if (this.pendingMcpServer) {
            log.warn('New MCP connection arrived before previous one was wired to a session');
          }
          const mcpServer = new NewioMcpServer(app);
          this.pendingMcpServer = mcpServer;
          void mcpServer.connect(transport);
        },
      });
      log.info(`MCP UDS server listening on ${mcpSocketPath}`);

      this.startIdleCleanup();
      await this.onConnected();
      log.info('Agent running');
      this.setStatus('running');
    } catch (err: unknown) {
      this._app?.dispose();
      this._app = undefined;

      if (abortController.signal.aborted) {
        log.info('Start aborted');
        return;
      }

      if (err instanceof ApprovalTimeoutError) {
        log.warn('Approval timed out');
        this.setStatus('error', 'Approval timed out. Please try starting the agent again.');
      } else if (err instanceof NotFoundApiError) {
        const username = this.config.newio?.username;
        log.warn('Agent not found', username);
        this.setStatus('error', `Agent "${username ?? 'unknown'}" not found. Check the Newio Username and try again.`);
      } else if (err instanceof Error && err.message.includes('WebSocket closed before open')) {
        log.warn('WebSocket connection rejected — likely a duplicate session');
        this.setStatus('error', 'Connection rejected. This agent may already be running in another instance.');
      } else if (isErrnoException(err) && err.code === 'ENOENT') {
        const executable = this.config.acp ? resolveCommand(this.config.type, this.config.acp).command : 'unknown';
        log.warn(`Executable not found: ${executable}`);
        this.setStatus(
          'error',
          `"${executable}" not found. Make sure it is installed and available on your system PATH, or set the executable path in the agent config.\n\n${err.stack ?? err.message}`,
        );
      } else {
        const message = err instanceof Error ? (err.stack ?? err.message) : 'Unknown error';
        log.error('Failed to start', message);
        this.setStatus('error', message);
      }
    }
  }

  async stop(): Promise<void> {
    log.info('Stopping agent');
    this.abortController?.abort();

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    // Close all session runners
    for (const [newioSessionId, runner] of this.runners) {
      log.debug(`Disposing session runner: ${newioSessionId}`);
      runner.queue.close();
      await runner.session.dispose();
    }
    this.runners.clear();

    if (this.udsServer) {
      this.udsServer.close();
      this.udsServer = undefined;
      log.debug('MCP UDS server closed');
    }

    if (this._app) {
      try {
        await this._app.auth.revoke();
        log.debug('Tokens revoked');
      } catch {
        log.warn('Token revocation failed (best-effort)');
      }
      this._app.dispose();
      this._app = undefined;
    }

    this.configManager.clearTokens(this.config.id);

    await this.onStopped();
    this.setStatus('stopped');
    log.info('Agent stopped');
  }

  /** Get the NewioApp instance. Throws if not connected. */
  get app(): NewioApp {
    if (!this._app) {
      throw new Error('Agent is not connected — NewioApp is not initialized.');
    }
    return this._app;
  }

  get promptManager(): PromptManager {
    if (!this._promptManager) {
      throw new Error('PromptManager is not created.');
    }
    return this._promptManager;
  }

  // ---------------------------------------------------------------------------
  // Event routing
  // ---------------------------------------------------------------------------

  /** Route an incoming message to the correct session's queue. */
  private async routeMessage(msg: IncomingMessage): Promise<void> {
    try {
      const runner = await this.getOrCreateRunner(msg.conversationId);
      runner.queue.enqueueMessage(msg);
    } catch (err: unknown) {
      log.error(`Failed to route message for ${msg.conversationId}`, err);
    }
  }

  /** Route a contact event to the owner DM session's queue. */
  private async routeContactEvent(event: ContactEvent): Promise<void> {
    try {
      const convId = await this.app.getOwnerDmConversationId();
      if (!convId) {
        log.warn(`Cannot route contact event — no owner DM conversation`);
        return;
      }
      const runner = await this.getOrCreateRunner(convId);
      runner.queue.enqueueContact(event);
    } catch (err: unknown) {
      log.error('Failed to route contact event', err);
    }
  }

  /** Route a cron trigger to the session that created the cron job. Restarts idle sessions. */
  private async routeCronEvent(event: CronTriggerEvent): Promise<void> {
    try {
      const runner = await this.getOrCreateRunnerBySessionId(event.newioSessionId);
      runner.queue.enqueueCron(event);
    } catch (err: unknown) {
      log.error(`Failed to route cron event ${event.cronId}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Session routing
  // ---------------------------------------------------------------------------

  /**
   * Get or create a SessionRunner for a conversation.
   * Resolves conversationId → newioSessionId, then delegates to getOrCreateRunnerBySessionId.
   */
  private async getOrCreateRunner(conversationId: string): Promise<SessionRunner> {
    const newioSessionId = await this.app.resolveSessionId(conversationId);
    return this.getOrCreateRunnerBySessionId(newioSessionId);
  }

  /**
   * Get or create a SessionRunner by newioSessionId directly.
   * Returns existing runner if live, otherwise launches a new session (serialized).
   */
  private async getOrCreateRunnerBySessionId(newioSessionId: string): Promise<SessionRunner> {
    const existing = this.runners.get(newioSessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const pending = this.pendingSessions.get(newioSessionId);
    if (pending) {
      return pending;
    }

    const promise = this.enqueueLaunch(newioSessionId);
    this.pendingSessions.set(newioSessionId, promise);
    try {
      return await promise;
    } finally {
      this.pendingSessions.delete(newioSessionId);
    }
  }

  /**
   * Enqueue a session launch so only one runs at a time.
   * This ensures the MCP bridge that connects during launch is correctly
   * wired to the right newioSessionId via `latestMcpServer`.
   */
  private enqueueLaunch(newioSessionId: string): Promise<SessionRunner> {
    const launch = this.launchQueue.then(() => this.launchRunner(newioSessionId));
    this.launchQueue = launch.then(
      () => {},
      (err: unknown) => {
        log.error(`Session launch failed for ${newioSessionId}`, err);
      },
    );
    return launch;
  }

  /** Launch a session runner — create or resume the session, wire MCP, start its processing loop. */
  private async launchRunner(newioSessionId: string): Promise<SessionRunner> {
    if (this.abortController?.signal.aborted) {
      throw new Error('Agent is stopping — session launch aborted');
    }

    const existingCorrelationId = this.sessionStore.get(newioSessionId);
    let session: AgentSession;

    if (existingCorrelationId) {
      log.info(`Resuming session: correlation=${existingCorrelationId}`);
      try {
        session = await this.resumeSession(existingCorrelationId);
      } catch (err) {
        log.warn(`Failed to resume session ${existingCorrelationId}, falling back to new session`, err);
        session = await this.createSession();
        this.sessionStore.set(newioSessionId, session.correlationId);
      }
    } else {
      session = await this.createSession();
      this.sessionStore.set(newioSessionId, session.correlationId);
    }

    // Wire MCP sessionId
    if (this.pendingMcpServer) {
      this.pendingMcpServer.setSessionId(newioSessionId);
      this.pendingMcpServer = undefined;
      log.debug(`Wired sessionId ${newioSessionId} to pending MCP server`);
    }

    // Wire status listener
    session.onStatus((status) => {
      const convId = this.activeConversation.get(session.correlationId);
      if (convId) {
        this.app.setStatus(status, convId);
      } else {
        log.warn(`Status '${status}' from session ${session.correlationId} dropped — no active conversation mapped.`);
      }
    });

    const runner: SessionRunner = {
      session,
      queue: new EventQueue(),
      lastActivityAt: Date.now(),
    };
    this.runners.set(newioSessionId, runner);
    log.info(`New runner: newio=${newioSessionId} → correlation=${session.correlationId}`);

    // Start the per-session processing loop (runs concurrently)
    void this.runSessionLoop(newioSessionId, runner);

    return runner;
  }

  /** Get a live session by its correlation ID, if running. */
  protected getLiveSession(correlationId: string): AgentSession | undefined {
    for (const runner of this.runners.values()) {
      if (runner.session.correlationId === correlationId) {
        return runner.session;
      }
    }
    return undefined;
  }

  /** Get or create a session for a conversation. Used by subclasses (e.g., greeting). */
  protected async getOrCreateSession(conversationId: string): Promise<AgentSession> {
    const runner = await this.getOrCreateRunner(conversationId);
    return runner.session;
  }

  // ---------------------------------------------------------------------------
  // Abstract — subclass hooks
  // ---------------------------------------------------------------------------

  /** Create a new agent-type-specific session. */
  protected abstract createSession(): Promise<AgentSession>;

  /** Resume a previously idle-killed session by its correlation ID. */
  protected abstract resumeSession(correlationId: string): Promise<AgentSession>;

  /** Called after NewioApp is ready. Subclasses add agent-specific behavior (e.g., greeting). */
  protected abstract onConnected(): Promise<void> | void;

  /** Called during stop. Subclasses clean up agent-specific resources. */
  protected abstract onStopped(): Promise<void> | void;

  /** Called when a session is disposed (idle cleanup). Subclasses clean up session-specific resources. */
  protected onSessionDisposed(_correlationId: string): void {
    // Default no-op — subclasses override as needed
  }

  /** List available models from the representative session. */
  abstract listModels(): AgentSessionConfig | undefined;

  /** List available modes from the representative session. */
  abstract listModes(): AgentSessionConfig | undefined;

  /** Configure model/mode on one or all sessions. */
  abstract configureAgent(input: ConfigureAgentInput): Promise<void>;

  // ---------------------------------------------------------------------------
  // Permission handling — routes ACP permission requests to owner via Newio
  // ---------------------------------------------------------------------------

  /**
   * Handle an ACP permission request by sending an action message to the owner.
   * Routes to the active conversation if the session is processing a message,
   * otherwise falls back to the owner DM.
   */
  protected async handlePermissionRequest(
    correlationId: string,
    options: ReadonlyArray<{ readonly kind: string; readonly name: string; readonly optionId: string }>,
    title: string,
  ): Promise<string> {
    const conversationId = this.activeConversation.get(correlationId) ?? (await this.app.getOwnerDmConversationId());
    if (!conversationId) {
      throw new Error('Cannot route permission request — no active conversation and no owner DM');
    }

    const ownerId = this.app.identity.ownerId;
    if (!ownerId) {
      throw new Error('Cannot route permission request — agent has no owner');
    }

    const requestId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const actionOptions: ActionOption[] = options.map((o) => ({
      optionId: o.optionId,
      label: o.name,
    }));

    const action: ActionRequest = {
      requestId,
      type: 'permission',
      title,
      options: actionOptions,
      expiresAt,
    };

    log.info(`Sending permission request ${requestId} to ${conversationId}`);
    const response = await this.app.sendActionRequest(conversationId, action, [ownerId]);
    return response.selectedOptionId;
  }

  // ---------------------------------------------------------------------------
  // Per-session processing loop
  // ---------------------------------------------------------------------------

  /** Process events for a single session. Runs until the queue is closed. */
  private async runSessionLoop(newioSessionId: string, runner: SessionRunner): Promise<void> {
    for await (const event of runner.queue.events()) {
      runner.lastActivityAt = Date.now();
      await this.processEvent(event, runner.session);
    }
    log.debug(`Session loop ended: ${newioSessionId}`);
  }

  /** Dispatch an event to the appropriate handler. */
  private async processEvent(event: AgentEvent, session: AgentSession): Promise<void> {
    switch (event.type) {
      case 'messages':
        await this.processMessageBatch(event.conversationId, session, event.messages);
        break;
      case 'contact':
        await this.processContactBatch(session, event.events);
        break;
      case 'cron':
        await this.processCronTrigger(session, event.job);
        break;
    }
  }

  private async processMessageBatch(
    conversationId: string,
    session: AgentSession,
    messages: readonly IncomingMessage[],
  ): Promise<void> {
    const userText = this.promptManager.formatMessagePrompt(messages);
    this.activeConversation.set(session.correlationId, conversationId);

    try {
      for await (const segment of session.prompt(userText)) {
        if (
          segment.type === 'agent_message_chunk' &&
          segment.text.trim() &&
          segment.text.trim().toLowerCase() !== '_skip'
        ) {
          await this.app.sendMessage(conversationId, segment.text.trim());
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Prompt/send failed for ${conversationId}: ${errMsg}`);
    } finally {
      this.activeConversation.delete(session.correlationId);
      this.app.setStatus('idle', conversationId);
    }
  }

  private async processContactBatch(session: AgentSession, events: readonly ContactEvent[]): Promise<void> {
    const userText = this.promptManager.formatContactPrompt(events);
    log.debug(`Processing ${String(events.length)} contact event(s) in session ${session.correlationId}`);

    try {
      for await (const segment of session.prompt(userText)) {
        const text = segment.text.trim();
        if (segment.type === 'agent_message_chunk' && text && text.toLowerCase() !== '_skip') {
          log.debug(`Contact event response (discarded): ${text.substring(0, 100)}`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Contact event processing failed: ${errMsg}`);
    }
  }

  private async processCronTrigger(session: AgentSession, job: CronTriggerEvent): Promise<void> {
    const userText = this.promptManager.formatCronPrompt(job);
    log.debug(`Processing cron ${job.cronId} ("${job.label}") in session ${session.correlationId}`);

    try {
      for await (const segment of session.prompt(userText)) {
        const text = segment.text.trim();
        if (segment.type === 'agent_message_chunk' && text && text.toLowerCase() !== '_skip') {
          log.debug(`Cron response (discarded): ${text.substring(0, 100)}`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Cron processing failed for ${job.cronId}: ${errMsg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Idle cleanup
  // ---------------------------------------------------------------------------

  private startIdleCleanup(): void {
    const checkInterval = 60_000; // check every minute
    this.idleTimer = setInterval(() => {
      void this.cleanupIdleSessions();
    }, checkInterval);
  }

  private async cleanupIdleSessions(): Promise<void> {
    if (this.cleaningUp) {
      return;
    }
    this.cleaningUp = true;
    try {
      const timeout = this.config.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
      const now = Date.now();

      for (const [newioSessionId, runner] of this.runners) {
        if (!runner.session.disposable) {
          continue;
        }
        if (now - runner.lastActivityAt > timeout) {
          log.info(
            `Idle session cleanup: ${newioSessionId} (idle ${Math.round((now - runner.lastActivityAt) / 1000)}s)`,
          );
          runner.queue.close();
          await runner.session.dispose();
          this.onSessionDisposed(runner.session.correlationId);
          this.runners.delete(newioSessionId);
        }
      }
    } finally {
      this.cleaningUp = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  protected setStatus(status: AgentRuntimeStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.listener.onStatusChanged(status, error);
  }
}
