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
import { ApprovalTimeoutError, ConnectionRejectedError, NewioApp, NotFoundApiError } from '@newio/agent-sdk';
import type { IncomingMessage, ContactEvent, CronTriggerEvent, ActionOption, ActionRequest } from '@newio/agent-sdk';
import { NewioMcpServer, startUdsServer } from '@newio/mcp-server';
import type { Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentConfigManager } from './agent-config-manager';
import type { AgentRuntimeStatus, AgentConfig } from './types';
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS, resolveCommand, extractErrorMessage } from './types';
import type { AgentInfo, PermissionRequestOption } from './types';
import type { AgentInstance, AgentInstanceListener } from './agent-instance';
import type { AgentSessionConfig, ConfigureAgentInput } from './agent-instance';
import type { AgentSession } from './agent-session';
import type { SessionStore } from './session-store';
import { EventQueue } from './event-queue';
import type { AgentEvent } from './event-queue';
import { PromptManager } from './prompt-manager';
import { Logger } from './logger';
import WebSocket from 'ws';
import { PromptFormatterImpl } from './prompt-formatter';

const log = new Logger('base-agent-instance');

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** Raw inbound event before routing. */
type InboundEvent =
  | { readonly type: 'message'; readonly msg: IncomingMessage }
  | { readonly type: 'contact'; readonly event: ContactEvent }
  | { readonly type: 'cron'; readonly event: CronTriggerEvent };

/** A session slot — queue is created eagerly, session is attached once ready. */
interface SessionSlot {
  readonly queue: EventQueue;
  session: AgentSession | undefined;
  readonly sessionPromise: Promise<AgentSession>;
  lastActivityAt: number;
}

export abstract class BaseAgentInstance implements AgentInstance {
  status: AgentRuntimeStatus = 'stopped';
  error?: string;

  /** Log prefix including the agent's username when available. */
  protected get logTag(): string {
    const u = this.config.newio?.username;
    return u ? `[${u}]` : '';
  }

  private _app?: NewioApp;
  private _promptManager?: PromptManager;
  private _ownerDmConversationId?: string;

  /** newioSessionId → session slot (queue created eagerly, session attached lazily) */
  private readonly slots = new Map<string, SessionSlot>();
  /** Inbound event buffer — events captured synchronously, routed serially. */
  private readonly inbound: InboundEvent[] = [];
  private draining = false;
  /** Serializes session launches so only one runs at a time (protects latestMcpServer wiring). */
  private launchQueue: Promise<void> = Promise.resolve();
  private abortController = new AbortController();
  private idleTimer?: ReturnType<typeof setInterval>;
  private cleaningUpIdleSessions = false;
  protected pendingCleanup?: Promise<void>;
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
    // Wait for any in-flight cleanup (e.g. from an unexpected process exit) before starting
    if (this.pendingCleanup) {
      await this.pendingCleanup;
    }

    const abortController = new AbortController();
    this.abortController = abortController;
    this.setStatus('starting');
    log.info(`${this.logTag} Starting agent`);

    try {
      const storedTokens = this.configManager.getTokens(this.config.id);
      log.debug(
        storedTokens
          ? `${this.logTag} Found persisted tokens`
          : `${this.logTag} No persisted tokens, will run auth flow`,
      );

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
          log.info(`${this.logTag} Awaiting approval`, url);
          this.listener.onApprovalUrl(url);
          this.setStatus('awaiting_approval');
        },
        onPollAttempt: () => {
          this.listener.onPollAttempt();
        },
        onTokens: (tokens) => {
          log.debug(`${this.logTag} Tokens received, persisting`);
          this.configManager.setTokens(this.config.id, tokens);
        },
      });

      const app = this._app;

      // Sync profile to config
      const { userId, username, displayName } = app.identity;
      log.info(`${this.logTag} Authenticated as ${username} (${userId})`);
      this.configManager.setNewioIdentity(this.config.id, {
        agentId: userId,
        username,
        displayName,
        avatarUrl: app.identity.avatarUrl,
      });
      this.listener.onConfigUpdated();

      this.setStatus('initializing');
      const stageInfix = __NEWIO_STAGE__ === 'prod' ? '' : `-${__NEWIO_STAGE__}`;
      const mcpSocketPath = join(tmpdir(), `newio-connector${stageInfix}-mcp-${username}.sock`);
      this.mcpSocketPath = mcpSocketPath;

      await app.init();

      app.onDisconnect(() => {
        if (!abortController.signal.aborted) {
          log.warn(`${this.logTag} WebSocket disconnected unexpectedly`);
        }
      });

      // Wire event handlers — capture synchronously into inbound queue
      app.on('message.new', (msg) => {
        if (!msg.isOwnMessage && !abortController.signal.aborted) {
          this.inbound.push({ type: 'message', msg });
          void this.drainInbound();
        }
      });

      app.on('contact.event', (event) => {
        if (!abortController.signal.aborted) {
          this.inbound.push({ type: 'contact', event });
          void this.drainInbound();
        }
      });

      app.on('cron.triggered', (event) => {
        if (!abortController.signal.aborted) {
          this.inbound.push({ type: 'cron', event });
          void this.drainInbound();
        }
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
          log.info(`${this.logTag} Restored cron ${cron.cronId}: "${cron.label}"`);
        } catch (err: unknown) {
          log.warn(`${this.logTag} Failed to restore cron ${cron.cronId}`, err);
          this.sessionStore.deleteCron(cron.cronId);
        }
      }

      // Start MCP server on UDS for agent sessions
      const defaultPromptFormatter = new PromptFormatterImpl(app);
      this._promptManager = new PromptManager([defaultPromptFormatter], defaultPromptFormatter);

      this.udsServer = startUdsServer({
        socketPath: mcpSocketPath,
        onConnection: (transport) => {
          log.info(`${this.logTag} MCP client connected via ${mcpSocketPath}`);
          if (this.pendingMcpServer) {
            log.warn(`${this.logTag} New MCP connection arrived before previous one was wired to a session`);
          }
          const mcpServer = new NewioMcpServer(app);
          this.pendingMcpServer = mcpServer;
          void mcpServer.connect(transport);
        },
      });
      log.info(`${this.logTag} MCP UDS server listening on ${mcpSocketPath}`);

      this.startIdleCleanup();

      const ownerDmConversationId = await this.getOwnerDmOrThrow();
      this._ownerDmConversationId = ownerDmConversationId;
      await this.onConnected(ownerDmConversationId);
      log.info(`${this.logTag} Agent running`);
      this.setStatus('running');
    } catch (err: unknown) {
      const wasAborted = abortController.signal.aborted;
      await this.cleanup();
      await this.onStopped();

      if (wasAborted) {
        log.info(`${this.logTag} Start aborted`);
        return;
      }

      if (err instanceof ApprovalTimeoutError) {
        log.warn(`${this.logTag} Approval timed out`);
        this.setStatus('error', 'Approval timed out. Please try starting the agent again.');
      } else if (err instanceof NotFoundApiError) {
        const username = this.config.newio?.username;
        log.warn(`${this.logTag} Agent not found`, username);
        this.setStatus('error', `Agent "${username ?? 'unknown'}" not found. Check the Newio Username and try again.`);
      } else if (err instanceof ConnectionRejectedError) {
        log.warn(`${this.logTag} WebSocket connection rejected — likely a duplicate session`);
        this.setStatus('error', 'Connection rejected. This agent may already be running in another instance.');
      } else if (isErrnoException(err) && err.code === 'ENOENT') {
        const executable = this.config.acp ? resolveCommand(this.config.type, this.config.acp).command : 'unknown';
        log.warn(`${this.logTag} Executable not found: ${executable}`);
        this.setStatus(
          'error',
          `"${executable}" not found. Make sure it is installed and available on your system PATH, or set the executable path in the agent config.\n\n${err.stack ?? err.message}`,
        );
      } else {
        const message = extractErrorMessage(err);
        log.error(`${this.logTag} Failed to start`, err instanceof Error ? (err.stack ?? message) : message);
        this.setStatus('error', message);
      }
    }
  }

  async stop(): Promise<void> {
    log.info(`${this.logTag} Stopping agent`);
    this.setStatus('stopping');
    await this.cleanup();
    await this.onStopped();
    this.setStatus('stopped');
    log.info(`${this.logTag} Agent stopped`);
  }

  /** Shared cleanup — tears down sessions, MCP server, WebSocket, and timers. */
  protected async cleanup(): Promise<void> {
    this.abortController.abort();

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    // Drain inbound queue
    this.inbound.length = 0;

    // Close all session slots
    for (const [newioSessionId, slot] of this.slots) {
      log.debug(`${this.logTag} Disposing session slot: ${newioSessionId}`);
      slot.queue.close();
      if (slot.session) {
        await slot.session.dispose();
      }
    }
    this.slots.clear();

    if (this.udsServer) {
      this.udsServer.close();
      this.udsServer = undefined;
      log.debug(`${this.logTag} MCP UDS server closed`);
    }

    if (this._app) {
      this._app.dispose();
      this._app = undefined;
    }
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

  get ownerDmConversationId(): string {
    if (typeof this._ownerDmConversationId !== 'string') {
      throw new Error('Missing dmOwnerConversationId.');
    }
    return this._ownerDmConversationId;
  }

  // ---------------------------------------------------------------------------
  // Inbound queue — serial drain ensures arrival-order routing
  // ---------------------------------------------------------------------------

  /** Drain the inbound queue serially. Events are routed one at a time to preserve order. */
  private async drainInbound(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.inbound.length > 0 && !this.abortController.signal.aborted) {
        const event = this.inbound.shift();
        if (!event) {
          break;
        }
        try {
          await this.routeInboundEvent(event);
        } catch (err: unknown) {
          log.error(`${this.logTag} Failed to route inbound event`, err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Resolve session and enqueue to the per-session EventQueue (created eagerly). */
  private async routeInboundEvent(event: InboundEvent): Promise<void> {
    switch (event.type) {
      case 'message': {
        const slot = await this.getOrCreateSlot(event.msg.conversationId);
        slot.queue.enqueueMessage(event.msg);
        break;
      }
      case 'contact': {
        const convId = await this.app.getOwnerDmConversationId();
        if (!convId) {
          log.warn(`${this.logTag} Cannot route contact event — no owner DM conversation`);
          return;
        }
        const slot = await this.getOrCreateSlot(convId);
        slot.queue.enqueueContact(event.event);
        break;
      }
      case 'cron': {
        const slot = this.getOrCreateSlotBySessionId(event.event.newioSessionId);
        slot.queue.enqueueCron(event.event);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Session slot management
  // ---------------------------------------------------------------------------

  /**
   * Get or create a SessionSlot for a conversation.
   * Resolves conversationId → newioSessionId, then delegates to getOrCreateSlotBySessionId.
   */
  private async getOrCreateSlot(conversationId: string): Promise<SessionSlot> {
    const newioSessionId = await this.app.resolveSessionId(conversationId);
    return this.getOrCreateSlotBySessionId(newioSessionId);
  }

  /**
   * Get or create a SessionSlot by newioSessionId.
   * The queue is created eagerly. Session creation happens in the background.
   */
  private getOrCreateSlotBySessionId(newioSessionId: string): SessionSlot {
    const existing = this.slots.get(newioSessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const queue = new EventQueue();
    const sessionPromise = this.enqueueLaunch(newioSessionId);

    const slot: SessionSlot = {
      queue,
      session: undefined,
      sessionPromise,
      lastActivityAt: Date.now(),
    };
    this.slots.set(newioSessionId, slot);

    // Start the processing loop once the session is ready
    void sessionPromise.then(
      (session) => {
        slot.session = session;
        void this.runSessionLoop(newioSessionId, slot);
      },
      (err: unknown) => {
        log.error(`${this.logTag} Session creation failed for ${newioSessionId}, closing slot`, err);
        queue.close();
        this.slots.delete(newioSessionId);
      },
    );

    return slot;
  }

  /**
   * Enqueue a session launch so only one runs at a time.
   * This ensures the MCP bridge that connects during launch is correctly
   * wired to the right newioSessionId via `latestMcpServer`.
   */
  private enqueueLaunch(newioSessionId: string): Promise<AgentSession> {
    const launch = this.launchQueue.then(() => this.launchSession(newioSessionId));
    this.launchQueue = launch.then(
      () => {},
      (err: unknown) => {
        log.error(`${this.logTag} Session launch failed for ${newioSessionId}`, err);
      },
    );
    return launch;
  }

  /** Launch a session — create or resume, wire MCP and status hooks. */
  private async launchSession(newioSessionId: string): Promise<AgentSession> {
    if (this.abortController.signal.aborted) {
      throw new Error('Agent is stopping — session launch aborted');
    }

    const existingSessionMetadata = this.sessionStore.get(newioSessionId);

    const session = existingSessionMetadata
      ? await this.resumeOrCreateSession(
          newioSessionId,
          existingSessionMetadata.correlationId,
          existingSessionMetadata.promptFormatterVersion,
        )
      : await this.createAndStoreSession(newioSessionId);

    // Wire MCP sessionId
    if (this.pendingMcpServer) {
      this.pendingMcpServer.setSessionIdGetter(() => session.sessionId);
      this.pendingMcpServer.setCurrentConversationIdGetter(() => session.currentConversationId);
      this.pendingMcpServer = undefined;
      log.debug(`${this.logTag} Wired sessionId ${newioSessionId} to pending MCP server`);
    }

    // Wire status listener
    session.onStatus((status, conversationId) => {
      if (conversationId) {
        this.app.setStatus(status, conversationId);
      } else {
        log.info(
          `${this.logTag} Status '${status}' from session ${session.correlationId} dropped — no active conversation mapped.`,
        );
      }
    });

    session.onPermissionRequest((title, options, conversationId) =>
      this.handlePermissionRequest(title, options, conversationId),
    );

    log.info(`${this.logTag} Session ready: newio=${newioSessionId} → correlation=${session.correlationId}`);
    return session;
  }

  /** Resume an existing session, falling back to a new session on failure. */
  private async resumeOrCreateSession(
    newioSessionId: string,
    correlationId: string,
    promptFormatterVersion: string,
  ): Promise<AgentSession> {
    log.info(`${this.logTag} Resuming session: correlation=${correlationId}`);
    try {
      // If this throws, session resume will fail and a new session will be created.
      this.promptManager.assertPromptFormatterVersion(promptFormatterVersion);
      return await this.resumeSession(newioSessionId, correlationId, promptFormatterVersion);
    } catch (err) {
      log.warn(`${this.logTag} Failed to resume session ${correlationId}, falling back to new session`, err);
      if (this.pendingMcpServer) {
        log.debug(`${this.logTag} Clearing pending MCP server after session resume failure`);
        this.pendingMcpServer = undefined;
      }
      return this.createAndStoreSession(newioSessionId);
    }
  }

  /** Create a new session and persist its correlation ID. */
  private async createAndStoreSession(newioSessionId: string): Promise<AgentSession> {
    try {
      const session = await this.createSession(newioSessionId);
      this.sessionStore.set(newioSessionId, session.correlationId, session.promptFormatterVersion);
      return session;
    } catch (err) {
      if (this.pendingMcpServer) {
        log.debug(`${this.logTag} Clearing pending MCP server after session creation failure`);
        this.pendingMcpServer = undefined;
      }
      throw err;
    }
  }

  /** Get a live session by its correlation ID, if running. */
  protected getLiveSession(correlationId: string): AgentSession | undefined {
    for (const slot of this.slots.values()) {
      if (slot.session?.correlationId === correlationId) {
        return slot.session;
      }
    }
    return undefined;
  }

  /** Get or create a session for a conversation. Used by subclasses (e.g., greeting). */
  protected async getOrCreateSession(conversationId: string): Promise<AgentSession> {
    const newioSessionId = await this.app.resolveSessionId(conversationId);
    const slot = this.getOrCreateSlotBySessionId(newioSessionId);
    return slot.sessionPromise;
  }

  // ---------------------------------------------------------------------------
  // Abstract — subclass hooks
  // ---------------------------------------------------------------------------

  /** Create a new agent-type-specific session. */
  protected abstract createSession(newioSessionId: string): Promise<AgentSession>;

  /** Resume a previously idle-killed session by its correlation ID. */
  protected abstract resumeSession(
    newioSessionId: string,
    correlationId: string,
    promptFormatterVersion: string,
  ): Promise<AgentSession>;

  /** Runtime agent info — available after initialization. */
  abstract getAgentInfo(): AgentInfo | undefined;

  /** Called after NewioApp is ready. Subclasses add agent-specific behavior (e.g., greeting). */
  protected abstract onConnected(ownerDmConversationId: string): Promise<void> | void;

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
  private async handlePermissionRequest(
    title: string,
    options: ReadonlyArray<PermissionRequestOption>,
    conversationId?: string,
  ): Promise<string> {
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
    const ownerId = this.app.identity.ownerId;
    if (!ownerId) {
      throw new Error('Cannot route permission request — agent has no owner');
    }
    const convId = conversationId ?? this.ownerDmConversationId;
    log.info(`${this.logTag} Sending permission request ${requestId} to ${convId}`);
    const response = await this.app.sendActionRequest(convId, action, [ownerId]);
    return response.selectedOptionId;
  }

  private async getOwnerDmOrThrow(): Promise<string> {
    const convId = await this.app.getOwnerDmConversationId();
    if (!convId) {
      throw new Error('Could not get owner DM conversation');
    }
    return convId;
  }

  // ---------------------------------------------------------------------------
  // Per-session processing loop
  // ---------------------------------------------------------------------------

  /** Process events for a single session. Runs until the queue is closed. */
  private async runSessionLoop(newioSessionId: string, slot: SessionSlot): Promise<void> {
    const session = slot.session;
    if (!session) {
      return;
    }
    for await (const event of slot.queue.events()) {
      slot.lastActivityAt = Date.now();
      await this.processEvent(event, session);
    }
    log.debug(`${this.logTag} Session loop ended: ${newioSessionId}`);
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
    const userText = this.promptManager.formatMessagePrompt(session.promptFormatterVersion, messages);
    try {
      for await (const segment of session.prompt(userText, conversationId)) {
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
      log.error(`${this.logTag} Prompt/send failed for ${conversationId}: ${errMsg}`);
    } finally {
      this.app.setStatus('idle', conversationId);
    }
  }

  private async processContactBatch(session: AgentSession, events: readonly ContactEvent[]): Promise<void> {
    const userText = this.promptManager.formatContactPrompt(session.promptFormatterVersion, events);
    log.debug(`${this.logTag} Processing ${String(events.length)} contact event(s) in session ${session.sessionId}`);

    try {
      for await (const segment of session.prompt(userText)) {
        const text = segment.text.trim();
        if (segment.type === 'agent_message_chunk' && text && text.toLowerCase() !== '_skip') {
          log.debug(`${this.logTag} Contact event response (discarded): ${text.substring(0, 100)}`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`${this.logTag} Contact event processing failed: ${errMsg}`);
    }
  }

  private async processCronTrigger(session: AgentSession, job: CronTriggerEvent): Promise<void> {
    const userText = this.promptManager.formatCronPrompt(session.promptFormatterVersion, job);
    log.debug(`${this.logTag} Processing cron ${job.cronId} ("${job.label}") in session ${session.sessionId}`);

    try {
      for await (const segment of session.prompt(userText)) {
        const text = segment.text.trim();
        if (segment.type === 'agent_message_chunk' && text && text.toLowerCase() !== '_skip') {
          log.debug(`${this.logTag} Cron response (discarded): ${text.substring(0, 100)}`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`${this.logTag} Cron processing failed for ${job.cronId}: ${errMsg}`);
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
    if (this.cleaningUpIdleSessions) {
      return;
    }
    this.cleaningUpIdleSessions = true;
    try {
      const timeout = this.config.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
      const now = Date.now();

      for (const [newioSessionId, slot] of this.slots) {
        if (!slot.session?.disposable) {
          continue;
        }
        if (now - slot.lastActivityAt > timeout) {
          log.info(
            `${this.logTag} Idle session cleanup: ${newioSessionId} (idle ${Math.round((now - slot.lastActivityAt) / 1000)}s)`,
          );
          slot.queue.close();
          await slot.session.dispose();
          this.onSessionDisposed(slot.session.correlationId);
          this.slots.delete(newioSessionId);
        }
      }
    } finally {
      this.cleaningUpIdleSessions = false;
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
