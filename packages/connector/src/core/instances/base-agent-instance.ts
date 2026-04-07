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
import { ApprovalTimeoutError, NewioApp, NEWIO_API_BASE_URL, NEWIO_WS_URL } from '@newio/sdk';
import type { IncomingMessage, ContactEvent, CronTriggerEvent } from '@newio/sdk';
import { NewioMcpServer, startUdsServer } from '@newio/mcp-server';
import type { Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentConfigManager } from '../agent-config-manager';
import type { AgentRuntimeStatus, AgentConfig } from '../types';
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS } from '../types';
import type { AgentInstance, AgentInstanceListener } from './agent-instance';
import type { AgentSession } from '../agent-session';
import type { SessionStore } from '../session-store';
import { EventQueue } from './event-queue';
import type { AgentEvent } from './event-queue';
import { PromptManager } from './prompt-manager';
import { Logger } from '../logger';
import WebSocket from 'ws';

const log = new Logger('base-agent-instance');

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
        agentId: this.config.newioAgentId,
        username: this.config.newioUsername,
        name: this.config.name,
        apiBaseUrl: NEWIO_API_BASE_URL,
        wsUrl: NEWIO_WS_URL,
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
        newioAgentId: userId,
        newioUsername: username,
        newioDisplayName: displayName,
        newioAvatarUrl: app.identity.avatarUrl,
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
      runner.session.dispose();
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
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Failed to route message for ${msg.conversationId}: ${errMsg}`);
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
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Failed to route contact event: ${errMsg}`);
    }
  }

  /** Route a cron trigger to the session that created the cron job. Restarts idle sessions. */
  private async routeCronEvent(event: CronTriggerEvent): Promise<void> {
    try {
      const runner = await this.getOrCreateRunnerBySessionId(event.newioSessionId);
      runner.queue.enqueueCron(event);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Failed to route cron event ${event.cronId}: ${errMsg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Session routing
  // ---------------------------------------------------------------------------

  /**
   * Get or create a SessionRunner for a conversation.
   * 1. Resolves conversationId → newioSessionId via NewioApp
   * 2. Returns existing runner if live
   * 3. Otherwise launches a new session (serialized) and starts its processing loop
   */
  private async getOrCreateRunner(conversationId: string): Promise<SessionRunner> {
    const newioSessionId = await this.app.resolveSessionId(conversationId);

    // Check if already running
    const existing = this.runners.get(newioSessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    // Deduplicate concurrent launches for the same session
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
   * Get or create a SessionRunner by newioSessionId directly.
   * Used for cron events where we already know the target session.
   * Restarts idle-killed sessions the same way getOrCreateRunner does.
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
        log.error(`Session launch failed for ${newioSessionId}: ${err instanceof Error ? err.message : String(err)}`);
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
        log.warn(
          `Failed to resume session ${existingCorrelationId}, falling back to new session: ${err instanceof Error ? err.message : String(err)}`,
        );
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
      this.cleanupIdleSessions();
    }, checkInterval);
  }

  private cleanupIdleSessions(): void {
    const timeout = this.config.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    const now = Date.now();

    for (const [newioSessionId, runner] of this.runners) {
      if (now - runner.lastActivityAt > timeout) {
        log.info(`Idle session cleanup: ${newioSessionId} (idle ${Math.round((now - runner.lastActivityAt) / 1000)}s)`);
        runner.queue.close();
        runner.session.dispose();
        this.runners.delete(newioSessionId);
      }
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
