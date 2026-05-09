/**
 * Base agent instance — shared auth, WebSocket, session routing, and lifecycle logic.
 *
 * Uses NewioApp for all Newio interactions. Manages multiple sessions per agent,
 * routing incoming events by type:
 * - Messages: routed by conversationId (one session per conversation)
 * - Contact events: routed to a dedicated contact session
 * - Cron triggers: routed by cronId (one session per cron job)
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
import type { AgentInfo, PermissionRequestOption, ConversationFlags } from './types';
import type { AgentInstance, AgentInstanceListener } from './agent-instance';
import type { AgentSession } from './agent-session';
import type { SessionStore } from './session-store';
import { EventQueue } from './event-queue';
import type { AgentEvent } from './event-queue';
import { PromptManager } from './prompt-manager';
import { Logger } from './logger';
import type {
  LiveSessionInfoRequest,
  LiveSessionInfoResponse,
  CancelSessionRequest,
  CancelSessionResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  StartSessionRequest,
  StartSessionResponse,
} from '@newio/agent-sdk';
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

  /** conversationId → session slot for conversation sessions. */
  private readonly conversationSlots = new Map<string, SessionSlot>();
  /** Dedicated session slot for contact events. */
  private contactSlot: SessionSlot | undefined;
  /** cronId → session slot for cron job sessions. */
  private readonly cronSlots = new Map<string, SessionSlot>();
  /** Per-conversation flags toggled by the owner (e.g. show_tool_call, show_thoughts). */
  private readonly conversationFlags = new Map<string, ConversationFlags>();
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
          this.drainInbound();
        }
      });

      app.on('contact.event', (event) => {
        if (!abortController.signal.aborted) {
          this.inbound.push({ type: 'contact', event });
          this.drainInbound();
        }
      });

      app.on('cron.triggered', (event) => {
        if (!abortController.signal.aborted) {
          this.inbound.push({ type: 'cron', event });
          this.drainInbound();
        }
      });

      app.on('cron.scheduled', (def) => {
        this.sessionStore.saveCron(this.config.id, def);
      });

      app.on('cron.cancelled', (cronId) => {
        this.sessionStore.deleteCron(cronId);
      });

      // React to persisted showToolCalls/showThoughts changes from the owner
      app.on('conversation.member_updated', (event) => {
        const { conversationId, userId, changes } = event;
        if (userId !== app.identity.userId) {
          return;
        }
        if (changes.showToolCalls !== undefined || changes.showThoughts !== undefined) {
          const prev = this.conversationFlags.get(conversationId) ?? { showToolCalls: false, showThoughts: false };
          this.conversationFlags.set(conversationId, {
            showToolCalls: changes.showToolCalls ?? prev.showToolCalls,
            showThoughts: changes.showThoughts ?? prev.showThoughts,
          });
          log.info(
            `${this.logTag} Updated conversation flags for ${conversationId}: showToolCalls=${changes.showToolCalls ?? prev.showToolCalls}, showThoughts=${changes.showThoughts ?? prev.showThoughts}`,
          );
        }
      });

      // React to persisted acpModel/acpMode changes from the owner
      app.on('session.updated', (event) => {
        const { sessionId, agentId, updatedBy, changes } = event;
        // Ignore events not meant for this agent or triggered by self
        if (agentId !== app.identity.userId || updatedBy === app.identity.userId) {
          return;
        }
        void this.applySessionConfigChange(sessionId, changes);
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
      this.wireCapabilityHandlers(app);
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
    this.conversationFlags.clear();

    // Close all session slots
    for (const [id, slot] of this.conversationSlots) {
      log.debug(`${this.logTag} Disposing conversation slot: ${id}`);
      slot.queue.close();
      if (slot.session) {
        await slot.session.dispose();
      }
    }
    this.conversationSlots.clear();

    if (this.contactSlot) {
      log.debug(`${this.logTag} Disposing contact slot`);
      this.contactSlot.queue.close();
      if (this.contactSlot.session) {
        await this.contactSlot.session.dispose();
      }
      this.contactSlot = undefined;
    }

    for (const [id, slot] of this.cronSlots) {
      log.debug(`${this.logTag} Disposing cron slot: ${id}`);
      slot.queue.close();
      if (slot.session) {
        await slot.session.dispose();
      }
    }
    this.cronSlots.clear();

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
  private drainInbound(): void {
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
          this.routeInboundEvent(event);
        } catch (err: unknown) {
          log.error(`${this.logTag} Failed to route inbound event`, err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Resolve session and enqueue to the per-session EventQueue (created eagerly). */
  private routeInboundEvent(event: InboundEvent): void {
    switch (event.type) {
      case 'message': {
        const slot = this.getOrCreateConversationSlot(event.msg.conversationId);
        slot.queue.enqueueMessage(event.msg);
        break;
      }
      case 'contact': {
        const slot = this.getOrCreateContactSlot();
        slot.queue.enqueueContact(event.event);
        break;
      }
      case 'cron': {
        const slot = this.getOrCreateCronSlot(event.event.cronId);
        slot.queue.enqueueCron(event.event);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Session slot management
  // ---------------------------------------------------------------------------

  /** Get or create a SessionSlot for a conversation. */
  private getOrCreateConversationSlot(conversationId: string): SessionSlot {
    const existing = this.conversationSlots.get(conversationId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const queue = new EventQueue();
    const sessionPromise = this.enqueueLaunch(conversationId);

    const slot: SessionSlot = {
      queue,
      session: undefined,
      sessionPromise,
      lastActivityAt: Date.now(),
    };
    this.conversationSlots.set(conversationId, slot);

    void sessionPromise.then(
      (session) => {
        slot.session = session;
        void this.runSessionLoop(conversationId, slot);
      },
      (err: unknown) => {
        log.error(`${this.logTag} Session creation failed for conversation ${conversationId}, closing slot`, err);
        queue.close();
        this.conversationSlots.delete(conversationId);
      },
    );

    return slot;
  }

  /** Get or create the dedicated contact event session slot. */
  private getOrCreateContactSlot(): SessionSlot {
    if (this.contactSlot) {
      this.contactSlot.lastActivityAt = Date.now();
      return this.contactSlot;
    }

    const queue = new EventQueue();
    const sessionPromise = this.enqueueLaunch('__contact__');

    const slot: SessionSlot = {
      queue,
      session: undefined,
      sessionPromise,
      lastActivityAt: Date.now(),
    };
    this.contactSlot = slot;

    void sessionPromise.then(
      (session) => {
        slot.session = session;
        void this.runSessionLoop('__contact__', slot);
      },
      (err: unknown) => {
        log.error(`${this.logTag} Contact session creation failed, closing slot`, err);
        queue.close();
        this.contactSlot = undefined;
      },
    );

    return slot;
  }

  /** Get or create a SessionSlot for a cron job. */
  private getOrCreateCronSlot(cronId: string): SessionSlot {
    const existing = this.cronSlots.get(cronId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const queue = new EventQueue();
    const sessionPromise = this.enqueueLaunch(`__cron__:${cronId}`);

    const slot: SessionSlot = {
      queue,
      session: undefined,
      sessionPromise,
      lastActivityAt: Date.now(),
    };
    this.cronSlots.set(cronId, slot);

    void sessionPromise.then(
      (session) => {
        slot.session = session;
        void this.runSessionLoop(`cron:${cronId}`, slot);
      },
      (err: unknown) => {
        log.error(`${this.logTag} Cron session creation failed for ${cronId}, closing slot`, err);
        queue.close();
        this.cronSlots.delete(cronId);
      },
    );

    return slot;
  }

  /**
   * Enqueue a session launch so only one runs at a time.
   * This ensures the MCP bridge that connects during launch is correctly
   * wired to the right session via `latestMcpServer`.
   */
  private enqueueLaunch(sessionKey: string): Promise<AgentSession> {
    const launch = this.launchQueue.then(() => this.launchSession(sessionKey));
    this.launchQueue = launch.then(
      () => {},
      (err: unknown) => {
        log.error(`${this.logTag} Session launch failed for ${sessionKey}`, err);
      },
    );
    return launch;
  }

  /** Launch a session — always creates a fresh session, wire MCP and status hooks. */
  private async launchSession(sessionKey: string): Promise<AgentSession> {
    if (this.abortController.signal.aborted) {
      throw new Error('Agent is stopping — session launch aborted');
    }

    const existingSessionMetadata = this.sessionStore.get(sessionKey);

    const session = existingSessionMetadata
      ? await this.resumeOrCreateSession(
          sessionKey,
          existingSessionMetadata.correlationId,
          existingSessionMetadata.promptFormatterVersion,
        )
      : await this.createAndStoreSession(sessionKey);

    // Wire MCP sessionId
    if (this.pendingMcpServer) {
      this.pendingMcpServer.setSessionIdGetter(() => session.sessionId);
      this.pendingMcpServer.setCurrentConversationIdGetter(() => session.currentConversationId);
      this.pendingMcpServer = undefined;
      log.debug(`${this.logTag} Wired sessionId ${sessionKey} to pending MCP server`);
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

    // Wire context pressure — triggers session rotation (conversation sessions only)
    if (!sessionKey.startsWith('__')) {
      session.onContextPressure(() => {
        void this.rotateConversationSession(sessionKey, session);
      });
    }

    log.info(`${this.logTag} Session ready: key=${sessionKey} → correlation=${session.correlationId}`);

    // Apply persisted acpModel/acpMode from the backend
    void this.applyPersistedSessionConfig(sessionKey, session);

    return session;
  }

  /** Resume an existing session, falling back to a new session on failure. */
  private async resumeOrCreateSession(
    sessionKey: string,
    correlationId: string,
    promptFormatterVersion: string,
  ): Promise<AgentSession> {
    log.info(`${this.logTag} Resuming session: correlation=${correlationId}`);
    try {
      // If this throws, session resume will fail and a new session will be created.
      this.promptManager.assertPromptFormatterVersion(promptFormatterVersion);
      return await this.resumeSession(sessionKey, correlationId, promptFormatterVersion);
    } catch (err) {
      log.warn(`${this.logTag} Failed to resume session ${correlationId}, falling back to new session`, err);
      if (this.pendingMcpServer) {
        log.debug(`${this.logTag} Clearing pending MCP server after session resume failure`);
        this.pendingMcpServer = undefined;
      }
      return this.createAndStoreSession(sessionKey);
    }
  }

  /** Create a new session and persist its correlation ID. */
  private async createAndStoreSession(sessionKey: string): Promise<AgentSession> {
    try {
      const session = await this.createSession(sessionKey);
      this.sessionStore.set(sessionKey, session.correlationId, session.promptFormatterVersion);
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
    for (const slot of this.conversationSlots.values()) {
      if (slot.session?.correlationId === correlationId) {
        return slot.session;
      }
    }
    if (this.contactSlot?.session?.correlationId === correlationId) {
      return this.contactSlot.session;
    }
    for (const slot of this.cronSlots.values()) {
      if (slot.session?.correlationId === correlationId) {
        return slot.session;
      }
    }
    return undefined;
  }

  /** Get or create a session for a conversation. Used by subclasses (e.g., greeting). */
  protected async getOrCreateSession(conversationId: string): Promise<AgentSession> {
    const slot = this.getOrCreateConversationSlot(conversationId);
    return slot.sessionPromise;
  }

  // ---------------------------------------------------------------------------
  // Abstract — subclass hooks
  // ---------------------------------------------------------------------------

  /** Create a new agent-type-specific session. */
  protected abstract createSession(sessionKey: string): Promise<AgentSession>;

  /** Resume a previously idle-killed session by its correlation ID. */
  protected abstract resumeSession(
    sessionKey: string,
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

  // ---------------------------------------------------------------------------
  // Session config — apply persisted acpModel/acpMode from session.updated events
  // ---------------------------------------------------------------------------

  /** Read persisted acpModel/acpMode from the backend and apply on session launch. */
  /** Read persisted acpModel/acpMode from the backend and apply on session launch. */
  private async applyPersistedSessionConfig(sessionKey: string, session: AgentSession): Promise<void> {
    // Only conversation sessions have backend-persisted config
    if (sessionKey.startsWith('__')) {
      return;
    }
    try {
      const { session: record } = await this.app.client.getSession({ sessionId: sessionKey });
      await session.applySessionConfig(record);
    } catch (err: unknown) {
      log.warn(`${this.logTag} Failed to apply persisted session config for ${sessionKey}`, err);
    }
  }

  /** Apply model/mode changes from a session.updated event to the live session. */
  private async applySessionConfigChange(
    newioSessionId: string,
    changes: { acpModel?: string | null; acpMode?: string | null },
  ): Promise<void> {
    // Search conversation slots for a matching session (sessionId from backend = newioSessionId)
    const slot = this.conversationSlots.get(newioSessionId);
    if (!slot?.session) {
      log.debug(`${this.logTag} session.updated for ${newioSessionId} — session not active, ignoring`);
      return;
    }
    await slot.session.applySessionConfig(changes);
  }

  // ---------------------------------------------------------------------------
  // Permission handling — routes ACP permission requests to owner via Newio
  // ---------------------------------------------------------------------------

  /**
   * Handle an ACP permission request by sending an action message to the owner.
   * Routes to the active conversation if the owner is a member, otherwise
   * falls back to the owner DM.
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
    const ownerIsInConversation = conversationId && this.isOwnerInConversation(conversationId, ownerId);
    const convId = ownerIsInConversation ? conversationId : this.ownerDmConversationId;

    // When rerouting to the owner DM, include context about the source conversation
    let text: string | undefined;
    if (conversationId && !ownerIsInConversation) {
      text = this.buildPermissionContextText(conversationId);
    }

    log.info(`${this.logTag} Sending permission request ${requestId} to ${convId}`);
    const response = await this.app.sendActionRequest(convId, action, text, [ownerId]);
    return response.selectedOptionId;
  }

  /** Build a human-readable context message for a rerouted permission request. */
  private buildPermissionContextText(conversationId: string): string {
    const conv = this.app.store.getConversation(conversationId);
    if (conv?.type === 'dm') {
      const members = this.app.store.getMembers(conversationId);
      if (members) {
        for (const [userId, member] of members) {
          if (userId !== this.app.identity.userId) {
            const name = member.displayName ?? member.username ?? userId;
            return `Requesting permission for a DM conversation with ${name}`;
          }
        }
      }
      return `Requesting permission for a DM conversation`;
    }
    const label = conv?.name ?? conversationId;
    return `Requesting permission for ${label} conversation`;
  }

  /** Check if the owner is a member of the given conversation (in-memory lookup). */
  private isOwnerInConversation(conversationId: string, ownerId: string): boolean {
    const members = this.app.store.getMembers(conversationId);
    return members?.has(ownerId) ?? false;
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
  private async runSessionLoop(sessionKey: string, slot: SessionSlot): Promise<void> {
    const session = slot.session;
    if (!session) {
      return;
    }
    for await (const event of slot.queue.events()) {
      slot.lastActivityAt = Date.now();
      await this.processEvent(event, session);
    }
    log.debug(`${this.logTag} Session loop ended: ${sessionKey}`);
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
    const flags = this.getConversationFlags(conversationId);
    const ownerId = this.app.identity.ownerId;
    const ownerVisible = ownerId && this.isOwnerInConversation(conversationId, ownerId);
    try {
      for await (const segment of session.prompt(userText, conversationId)) {
        const text = segment.text.trim();
        if (
          segment.type === 'agent_message_chunk' &&
          text &&
          !this.promptManager.isSkip(session.promptFormatterVersion, segment.text)
        ) {
          await this.app.sendMessage(conversationId, text);
        } else if (segment.type === 'agent_thought_chunk' && flags.showThoughts && text && ownerVisible) {
          await this.app.client.sendMessage({
            conversationId,
            content: { text: text, metadata: { type: 'agent_thought' } },
            visibleTo: [ownerId],
          });
        } else if (segment.type === 'tool_call' && flags.showToolCalls && text && ownerVisible) {
          await this.app.client.sendMessage({
            conversationId,
            content: {
              text,
              metadata: { type: 'tool_call', toolCallId: segment.toolCallId, status: segment.toolCallStatus },
            },
            visibleTo: [ownerId],
          });
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
        if (
          segment.type === 'agent_message_chunk' &&
          text &&
          !this.promptManager.isSkip(session.promptFormatterVersion, text)
        ) {
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
        if (
          segment.type === 'agent_message_chunk' &&
          text &&
          !this.promptManager.isSkip(session.promptFormatterVersion, text)
        ) {
          log.debug(`${this.logTag} Cron response (discarded): ${text.substring(0, 100)}`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`${this.logTag} Cron processing failed for ${job.cronId}: ${errMsg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Capability management
  // ---------------------------------------------------------------------------

  /** Wire signal handlers and register them with the app. */
  private wireCapabilityHandlers(app: NewioApp): void {
    app.onLiveSessionInfo((request) => this.getLiveSessionInfo(request));
    app.onCancelSession((request) => this.handleCancelSession(request));
    app.onCompactSession((request) => this.handleCompactSession(request));
    app.onStartSession((request) => this.handleStartSession(request));
  }

  /** Get live session info for a session. */
  private getLiveSessionInfo(request: LiveSessionInfoRequest): LiveSessionInfoResponse {
    const session = this.findSlotSession(request.sessionId);
    if (!session) {
      return {
        sessionId: request.sessionId,
        isLive: false,
        availableModels: [],
        availableModes: [],
        canCancel: false,
        canCompact: false,
      };
    }
    return session.getLiveSessionInfo(request);
  }

  /** Handle cancel session signal. */
  private async handleCancelSession(request: CancelSessionRequest): Promise<CancelSessionResponse> {
    const session = this.findSlotSession(request.sessionId);
    if (!session) {
      return { success: false, errorCode: 'session_not_live', error: 'Session not found or not active' };
    }
    return session.handleCancelSession(request);
  }

  /** Handle compact session signal. */
  private async handleCompactSession(request: CompactSessionRequest): Promise<CompactSessionResponse> {
    const session = this.findSlotSession(request.sessionId);
    if (!session) {
      return { success: false, errorCode: 'session_not_live', error: 'Session not found or not active' };
    }
    return session.handleCompactSession(request);
  }

  /** Handle start session signal. Launches the session if not already running. */
  private async handleStartSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const slot = this.getOrCreateConversationSlot(request.sessionId);
    try {
      await slot.sessionPromise;
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Session launch failed' };
    }
    if (!slot.session) {
      return { success: false, error: 'Session launch failed' };
    }
    const info = slot.session.getLiveSessionInfo({ sessionId: request.sessionId });
    return { success: true, info };
  }

  /** Find a live session across all slot types by its sessionId (used by signal handlers). */
  private findSlotSession(sessionId: string): AgentSession | undefined {
    const convSlot = this.conversationSlots.get(sessionId);
    if (convSlot?.session) {
      return convSlot.session;
    }
    // Also check by correlationId for backward compat with signals
    for (const slot of this.conversationSlots.values()) {
      if (slot.session?.correlationId === sessionId) {
        return slot.session;
      }
    }
    return undefined;
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

      // Conversation slots
      for (const [conversationId, slot] of this.conversationSlots) {
        if (!slot.session?.disposable) {
          continue;
        }
        if (now - slot.lastActivityAt > timeout) {
          log.info(
            `${this.logTag} Idle session cleanup: conversation ${conversationId} (idle ${Math.round((now - slot.lastActivityAt) / 1000)}s)`,
          );
          await this.endSession(slot, conversationId);
          this.conversationSlots.delete(conversationId);
        }
      }

      // Contact slot
      if (this.contactSlot?.session?.disposable) {
        if (now - this.contactSlot.lastActivityAt > timeout) {
          log.info(`${this.logTag} Idle session cleanup: contact session`);
          this.contactSlot.queue.close();
          await this.contactSlot.session.dispose();
          this.onSessionDisposed(this.contactSlot.session.correlationId);
          this.contactSlot = undefined;
        }
      }

      // Cron slots
      for (const [cronId, slot] of this.cronSlots) {
        if (!slot.session?.disposable) {
          continue;
        }
        if (now - slot.lastActivityAt > timeout) {
          log.info(`${this.logTag} Idle session cleanup: cron ${cronId}`);
          slot.queue.close();
          await slot.session.dispose();
          this.onSessionDisposed(slot.session.correlationId);
          this.cronSlots.delete(cronId);
        }
      }
    } finally {
      this.cleaningUpIdleSessions = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Session rotation & memory update
  // ---------------------------------------------------------------------------

  /**
   * Rotate a conversation session: trigger session-end prompt, capture handoff,
   * dispose old session, remove slot. Next message creates a fresh session.
   */
  private async rotateConversationSession(conversationId: string, _session: AgentSession): Promise<void> {
    log.info(`${this.logTag} Rotating session for conversation ${conversationId} due to context pressure`);
    const slot = this.conversationSlots.get(conversationId);
    if (slot) {
      await this.endSession(slot, conversationId);
      this.conversationSlots.delete(conversationId);
    }
  }

  /**
   * End a conversation session: inject session-end prompt, capture handoff summary,
   * close queue, dispose session.
   */
  private async endSession(slot: SessionSlot, conversationId: string): Promise<void> {
    if (!slot.session) {
      return;
    }
    // Inject session-end prompt (memory update + handoff generation)
    const prompt = this.promptManager.buildSessionEndPrompt(slot.session.promptFormatterVersion);
    try {
      const parts: string[] = [];
      for await (const segment of slot.session.prompt(prompt)) {
        if (segment.type === 'agent_message_chunk') {
          parts.push(segment.text);
        }
      }
      // Extract handoff summary
      const fullOutput = parts.join('');
      const handoffMatch = fullOutput.match(/HANDOFF:\s*([\s\S]+)/i);
      if (handoffMatch) {
        const summary = handoffMatch[1].trim();
        this.onHandoffGenerated(conversationId, summary);
        log.info(`${this.logTag} Captured handoff for ${conversationId} (${summary.length} chars)`);
      }
    } catch (err: unknown) {
      log.warn(`${this.logTag} Session-end prompt failed for ${conversationId}`, err);
    }

    slot.queue.close();
    await slot.session.dispose();
    this.onSessionDisposed(slot.session.correlationId);
  }

  /** Called when a handoff note is generated for a conversation. Subclasses persist it. */
  protected onHandoffGenerated(_conversationId: string, _summary: string): void {
    // Default no-op — AcpAgentInstance overrides to persist via SDK
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  protected setStatus(status: AgentRuntimeStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.listener.onStatusChanged(status, error);
  }

  /** Get the conversation flags for a conversation (defaults to all off). */
  protected getConversationFlags(conversationId: string): ConversationFlags {
    return this.conversationFlags.get(conversationId) ?? { showToolCalls: false, showThoughts: false };
  }
}
