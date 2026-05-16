/**
 * Single-session agent instance — all events share one ACP session.
 *
 * Uses NewioApp for all Newio interactions. Routes all incoming events
 * (messages, contacts, crons) into a single shared session that processes
 * them serially. Context accumulates across conversations within the session.
 *
 * Best for agents that need cross-conversation awareness (e.g. manager role).
 */
import { ApprovalTimeoutError, ConnectionRejectedError, NewioApp, NotFoundApiError } from '@newio/agent-sdk';
import type { IncomingMessage, ContactEvent, CronTriggerEvent, ActionOption, ActionRequest } from '@newio/agent-sdk';
import { NewioMcpServer, startUdsServer } from './mcp/index.js';
import type { Server } from 'net';
import { hostname, tmpdir } from 'os';
import { join } from 'path';
import type { AgentConfigManager } from './agent-config-manager';
import type { AgentRuntimeStatus, AgentConfig } from './types';
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS, resolveCommand, extractErrorMessage } from './types';
import type { AgentInfo, PermissionRequestOption, ConversationFlags } from './types';
import type { AgentInstance, AgentInstanceListener } from './agent-instance';
import type { AgentSession } from './agent-session';
import type { CronStore } from './cron-store';
import type { EngineConfig } from './engine-config';
import { EventQueue } from './event-queue';
import type { AgentEvent, OwnerOpCallback } from './event-queue';
import { PromptManager } from './prompt-manager';
import { getLogger } from '@newio/agent-sdk';
import type {
  LiveSessionInfoRequest,
  LiveSessionInfoResponse,
  CancelSessionRequest,
  CancelSessionResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  StartSessionRequest,
  StartSessionResponse,
  UpdateMemoryRequest,
  UpdateMemoryResponse,
  RotateSessionRequest,
  RotateSessionResponse,
} from '@newio/agent-sdk';
import WebSocket from 'ws';
import { PromptFormatterImpl } from './prompt-formatter';
import { AcpSessionFactory, SessionFactory } from './acp-session-factory.js';
import { collectAgentMessage } from './utils.js';

const log = getLogger('agent-instance');

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** Raw inbound event before routing. */
type InboundEvent =
  | { readonly type: 'message'; readonly msg: IncomingMessage }
  | { readonly type: 'contact'; readonly event: ContactEvent }
  | { readonly type: 'cron'; readonly event: CronTriggerEvent };

interface SessionSlot {
  readonly queue: EventQueue;
  session: AgentSession | undefined;
  readonly sessionPromise: Promise<AgentSession>;
  lastActivityAt: number;
  /** Non-null while the session loop is processing any event. */
  inFlight: AgentEvent['type'] | null;
}

const SESSION_TYPE = 'conversation';
const EXTERNAL_REFERENCE_ID = 'externalReferenceId';

export class SingleSessionAgentInstance implements AgentInstance {
  status: AgentRuntimeStatus = 'stopped';
  error?: string;

  /** Log prefix including the agent's username when available. */
  private get logTag(): string {
    const u = this.config.newio?.username;
    return u ? `[${u}]` : '';
  }

  private _app?: NewioApp;
  private _promptManager?: PromptManager;
  private _ownerDmConversationId?: string;
  private _sessionFactory?: SessionFactory;
  /** Socket path for the MCP UDS server. Set after auth in start(). */
  private _mcpSocketPath?: string;
  private sharedSessionSlot: SessionSlot | undefined;
  /** Per-conversation flags toggled by the owner (e.g. show_tool_call, show_thoughts). */
  private readonly conversationFlags = new Map<string, ConversationFlags>();
  /** Tracks which conversation scopes have already been injected into the shared session. */
  private readonly injectedConversationIds = new Set<string>();
  /** Tracks which user scopes have already been injected into the shared session. */
  private readonly injectedUserIds = new Set<string>();
  /** Inbound event buffer — events captured synchronously, routed serially. */
  private readonly inbound: InboundEvent[] = [];
  private draining = false;
  /** Serializes session launches so only one runs at a time (protects latestMcpServer wiring). */
  private launchQueue: Promise<void> = Promise.resolve();
  private abortController = new AbortController();
  private idleTimer?: ReturnType<typeof setInterval>;
  private cleaningUpIdleSessions = false;
  private pendingCleanup?: Promise<void>;
  private udsServer?: Server;
  /** Most recently created MCP server awaiting a sessionId to be wired. */
  private pendingMcpServer?: NewioMcpServer;

  constructor(
    private readonly config: AgentConfig,
    private readonly configManager: AgentConfigManager,
    private readonly cronStore: CronStore,
    private readonly listener: AgentInstanceListener,
    private readonly engineConfig: EngineConfig,
  ) {}

  getAgentInfo(): AgentInfo | undefined {
    return this._sessionFactory?.getAgentInfo();
  }

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
        apiBaseUrl: this.engineConfig.apiBaseUrl,
        wsUrl: this.engineConfig.wsUrl,
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
      const stageInfix = this.engineConfig.stage === 'prod' ? '' : `-${this.engineConfig.stage}`;
      const mcpSocketPath = join(tmpdir(), `newio-connector${stageInfix}-mcp-${username}.sock`);
      this._mcpSocketPath = mcpSocketPath;

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
        this.cronStore.saveCron(this.config.id, def);
      });

      app.on('cron.cancelled', (cronId) => {
        this.cronStore.deleteCron(cronId);
      });

      // React to persisted changes from the owner on this agent's member record:
      // - showToolCalls/showThoughts → conversation flags
      // - acpModel/acpMode → apply to live session
      // (session.updated is deprecated; acpModel/acpMode now flow through conversation.member_updated)
      app.on('conversation.member_updated', (event) => {
        const { conversationId, userId, updatedBy, changes } = event;
        if (userId !== app.identity.userId) {
          return;
        }
        // Ignore self-updates — the agent already applied the change locally
        if (updatedBy === app.identity.userId) {
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
        if (changes.acpModel !== undefined || changes.acpMode !== undefined) {
          void this.applySessionConfigChange(conversationId, {
            acpModel: changes.acpModel,
            acpMode: changes.acpMode,
          });
        }
      });

      // Reload persisted cron jobs
      const savedCrons = this.cronStore.listCrons(this.config.id);
      for (const cron of savedCrons) {
        try {
          app.scheduleCron(cron);
          log.info(`${this.logTag} Restored cron ${cron.cronId}: "${cron.label}"`);
        } catch (err: unknown) {
          log.warn(`${this.logTag} Failed to restore cron ${cron.cronId}`, err);
          this.cronStore.deleteCron(cron.cronId);
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
          const mcpServer = new NewioMcpServer(app, this, 'shared');
          this.pendingMcpServer = mcpServer;
          void mcpServer.connect(transport);
        },
      });
      log.info(`${this.logTag} MCP UDS server listening on ${mcpSocketPath}`);

      this.startIdleCleanup();

      const ownerId = this.app.identity.ownerId;
      if (!ownerId) {
        throw new Error('Cannot create session: ownerId is not set');
      }

      this._sessionFactory = new AcpSessionFactory(
        app.client,
        this.config,
        this.engineConfig,
        app.identity.userId,
        ownerId,
        `[${app.identity.username}]`,
      );
      this._sessionFactory.onAbnormalTermination((message) => {
        this.pendingCleanup = this.cleanup()
          .then(() => this._sessionFactory?.terminate())
          .then(() => {
            this.setStatus('error', message);
          })
          .finally(() => {
            this.pendingCleanup = undefined;
          });
      });

      await this._sessionFactory.init();
      const agentInfo = this._sessionFactory.getAgentInfo();
      if (agentInfo) {
        this.listener.onAgentInfo(agentInfo);
        this.reportAgentInfoToBackend(agentInfo);
      }

      this.wireCapabilityHandlers(app);

      await this.sendGreeting();

      log.info(`${this.logTag} Agent running`);
      this.setStatus('running');
    } catch (err: unknown) {
      const wasAborted = abortController.signal.aborted;
      await this.cleanup();
      await this._sessionFactory?.terminate();

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

  private async sendGreeting() {
    const ownerDmConversationId = await this.getOwnerDmOrThrow();
    this._ownerDmConversationId = ownerDmConversationId;
    log.debug(`${this.logTag} Owner DM conversation: ${ownerDmConversationId}`);

    this.setStatus('greeting');
    const slot = this.getOrCreateSharedSessionSlot();
    const session = await slot.sessionPromise;

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
  }

  async stop(): Promise<void> {
    log.info(`${this.logTag} Stopping agent`);
    this.setStatus('stopping');
    await this.cleanup();
    await this._sessionFactory?.terminate();
    this.setStatus('stopped');
    log.info(`${this.logTag} Agent stopped`);
  }

  /** Shared cleanup — tears down sessions, MCP server, WebSocket, and timers. */
  private async cleanup(): Promise<void> {
    this.abortController.abort();

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    // Drain inbound queue
    this.inbound.length = 0;
    this.conversationFlags.clear();
    this.injectedConversationIds.clear();
    this.injectedUserIds.clear();

    if (this.sharedSessionSlot) {
      log.debug(`${this.logTag} Disposing shared session slot`);
      this.sharedSessionSlot.queue.close();
      if (this.sharedSessionSlot.session) {
        await this.sharedSessionSlot.session.dispose();
      }
      this.sharedSessionSlot = undefined;
    }

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

  get sessionFactory(): SessionFactory {
    if (!this._sessionFactory) {
      throw new Error('Missing sessionFactory.');
    }
    return this._sessionFactory;
  }

  get mcpSocketPath(): string {
    if (typeof this._mcpSocketPath !== 'string') {
      throw new Error('Missing mcpSocketPath.');
    }
    return this._mcpSocketPath;
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
    const slot = this.getOrCreateSharedSessionSlot();
    switch (event.type) {
      case 'message': {
        slot.queue.enqueueMessage(event.msg);
        break;
      }
      case 'contact': {
        slot.queue.enqueueContact(event.event);
        break;
      }
      case 'cron': {
        slot.queue.enqueueCron(event.event);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Session slot management
  // ---------------------------------------------------------------------------

  /** Get or create the single shared session slot used for all events. */
  private getOrCreateSharedSessionSlot(): SessionSlot {
    if (this.sharedSessionSlot) {
      this.sharedSessionSlot.lastActivityAt = Date.now();
      return this.sharedSessionSlot;
    }
    const slot = this.createSlot();
    this.sharedSessionSlot = slot;
    return slot;
  }

  /** Create a new session slot — shared logic for all slot types. */
  private createSlot(): SessionSlot {
    const queue = new EventQueue(SESSION_TYPE, EXTERNAL_REFERENCE_ID);
    const sessionPromise = this.enqueueLaunch();

    const slot: SessionSlot = {
      queue,
      session: undefined,
      sessionPromise,
      lastActivityAt: Date.now(),
      inFlight: null,
    };

    void sessionPromise.then(
      (session) => {
        slot.session = session;
        void this.runSessionLoop(slot);
      },
      (err: unknown) => {
        log.error(`${this.logTag} Shared session creation failed, closing slot`, err);
        queue.close();
        this.sharedSessionSlot = undefined;
      },
    );

    return slot;
  }

  /**
   * Enqueue a session launch so only one runs at a time.
   * This ensures the MCP bridge that connects during launch is correctly
   * wired to the right session via `latestMcpServer`.
   */
  private enqueueLaunch(handoffNote?: string): Promise<AgentSession> {
    const launch = this.launchQueue.then(() => this.launchSession(handoffNote));
    this.launchQueue = launch.then(
      () => {},
      (err: unknown) => {
        log.error(`${this.logTag} Shared session launch failed`, err);
      },
    );
    return launch;
  }

  /** Launch a session — always creates a fresh session, wire MCP and status hooks. */
  private async launchSession(handoffNote?: string): Promise<AgentSession> {
    if (this.abortController.signal.aborted) {
      throw new Error('Agent is stopping — session launch aborted');
    }

    const session = await this.createSessionWithErrorHandling();

    // Wire MCP sessionId
    if (this.pendingMcpServer) {
      this.pendingMcpServer.setCurrentConversationIdGetter(() => session.currentConversationId);
      this.pendingMcpServer = undefined;
      log.debug(`${this.logTag} Wired session to pending MCP server`);
    }

    await this.provideContext(session, handoffNote);

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

    // Wire context pressure — triggers session rotation
    session.onContextPressure(() => {
      void this.rotateSession();
    });

    log.info(`${this.logTag} Shared Session ready`);

    // Apply persisted acpModel/acpMode from the backend (conversation sessions only)
    void this.applyPersistedSessionConfig(session);

    return session;
  }

  private async createSessionWithErrorHandling(): Promise<AgentSession> {
    try {
      const session = await this.sessionFactory.createSession({
        type: SESSION_TYPE,
        externalReferenceId: EXTERNAL_REFERENCE_ID,
        promptFormatterVersion: this.promptManager.defaultVersion,
        mcpSocketPath: this.mcpSocketPath,
        skipToken: this.promptManager.skipToken(this.promptManager.defaultVersion),
      });
      return session;
    } catch (err) {
      if (this.pendingMcpServer) {
        log.debug(`${this.logTag} Clearing pending MCP server after session creation failure`);
        this.pendingMcpServer = undefined;
      }
      throw err;
    }
  }

  private async provideContext(session: AgentSession, handoffNote?: string): Promise<void> {
    log.info(`${this.logTag} Preparing memory`);
    const instruction = this.promptManager.buildNewioInstruction(session.promptFormatterVersion);

    // Load memory for conversation sessions
    const memory = await this.loadMemoryForSession();
    // Use provided handoff note (in-memory from rotation) or fetch from backend
    let resolvedHandoff: string | null = handoffNote ?? null;
    if (!resolvedHandoff && session.type === 'conversation') {
      resolvedHandoff = await this.loadHandoffNote(session.externalReferenceId);
    }

    const memoryContext = this.promptManager.formatMemoryContext(
      instruction.version,
      memory,
      resolvedHandoff ?? undefined,
    );
    const fullInstruction = memoryContext ? `${instruction.prompt}\n\n${memoryContext}` : instruction.prompt;

    await collectAgentMessage(session.prompt(fullInstruction));
  }

  private async loadMemoryForSession(conversationId?: string) {
    const agentId = this.app.identity.userId;

    let participantIds: string[] | undefined = undefined;
    if (typeof conversationId === 'string') {
      const conv = this.app.store.getConversation(conversationId);
      const members = this.app.store.getMembers(conversationId);
      // For DMs, load full memory for the other participant
      participantIds = [];
      if (conv?.type === 'dm' && members) {
        for (const [userId] of members) {
          if (userId !== agentId) {
            participantIds.push(userId);
          }
        }
      }
    }

    return this.app.client.loadSessionMemory({ agentId, conversationId, participantIds });
  }

  /** Load the handoff note for a conversation (graceful fallback if endpoint doesn't exist). */
  private async loadHandoffNote(conversationId: string): Promise<string | null> {
    try {
      const result = await this.app.client.getHandoffNote({
        agentId: this.app.identity.userId,
        conversationId,
      });
      return result.text;
    } catch {
      // Endpoint may not exist yet — graceful fallback
      return null;
    }
  }

  private reportAgentInfoToBackend(agentInfo: AgentInfo): void {
    this.app.client
      .reportAgentInfo({
        agentProtocol: agentInfo.protocol,
        agentVendor: agentInfo.agentName ?? this.config.type,
        agentVendorVersion: agentInfo.agentVersion,
        host: {
          hostname: hostname(),
          workingDirectory: this.config.acp?.cwd,
        },
      })
      .then(() => log.info(`${this.logTag} Agent info reported`))
      .catch((err: unknown) => log.warn(`${this.logTag} Failed to report agent info`, err));
  }

  // ---------------------------------------------------------------------------
  // Session config — apply persisted acpModel/acpMode from conversation member
  // ---------------------------------------------------------------------------

  /** Read persisted acpModel/acpMode from the conversation member and apply on session launch. */
  private async applyPersistedSessionConfig(_session: AgentSession): Promise<void> {
    // todo
  }

  /** Apply acpModel/acpMode changes from conversation.member_updated to the live session. */
  private async applySessionConfigChange(
    conversationId: string,
    changes: { acpModel?: string | null; acpMode?: string | null },
  ): Promise<void> {
    const slot = this.sharedSessionSlot;
    if (!slot?.session) {
      log.debug(`${this.logTag} acpModel/acpMode change for ${conversationId} — shared session not active, ignoring`);
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
  private async runSessionLoop(slot: SessionSlot): Promise<void> {
    for await (const event of slot.queue.events()) {
      const session = slot.session;
      if (!session) {
        log.warn(`${this.logTag} Session loop has no session, skipping event`);
        continue;
      }
      slot.lastActivityAt = Date.now();
      slot.inFlight = event.type;
      try {
        await this.processEvent(event, session);
      } finally {
        slot.inFlight = null;
      }
    }
    log.debug(`${this.logTag} Session loop ended`);
  }

  // ---------------------------------------------------------------------------
  // Lazy memory injection — inject per-conversation and per-user context on first encounter
  // ---------------------------------------------------------------------------

  /**
   * Inject conversation and participant memory into the shared session the first time
   * we process messages for a given conversation. Subsequent messages for the same
   * conversation (and already-seen participants) skip fetching.
   */
  private async injectConversationContextIfNeeded(conversationId: string, session: AgentSession): Promise<void> {
    const agentId = this.app.identity.userId;
    const sections: string[] = [];

    // Per-conversation memory
    if (!this.injectedConversationIds.has(conversationId)) {
      this.injectedConversationIds.add(conversationId);
      try {
        const { data } = await this.app.client.getMemory({ agentId, scope: 'conversation', scopeId: conversationId });
        const parts: string[] = [];
        if (data.summary) {
          parts.push(`Summary: ${data.summary.text}`);
        }
        for (const fact of data.facts) {
          parts.push(`- ${fact.text}`);
        }
        if (parts.length > 0) {
          sections.push(`## Memory about conversation ${conversationId}\n${parts.join('\n')}`);
        }
      } catch {
        // Graceful — memory may not exist yet
      }
    }

    // Per-user memory for unseen participants
    const members = this.app.store.getMembers(conversationId);
    if (members) {
      for (const [userId] of members) {
        if (userId === agentId || this.injectedUserIds.has(userId)) {
          continue;
        }
        this.injectedUserIds.add(userId);
        try {
          const { data } = await this.app.client.getMemory({ agentId, scope: 'user', scopeId: userId });
          const parts: string[] = [];
          if (data.summary) {
            parts.push(`Summary: ${data.summary.text}`);
          }
          for (const fact of data.facts) {
            parts.push(`- ${fact.text}`);
          }
          if (parts.length > 0) {
            const member = members.get(userId);
            const label = member?.displayName ?? member?.username ?? userId;
            sections.push(`## Memory about ${label} (${userId})\n${parts.join('\n')}`);
          }
        } catch {
          // Graceful
        }
      }
    }

    if (sections.length > 0) {
      const contextPrompt = `# Additional context loaded for this conversation\n\n${sections.join('\n\n')}`;
      await collectAgentMessage(session.prompt(contextPrompt, conversationId));
      log.debug(
        `${this.logTag} Injected memory context for conversation ${conversationId} (${sections.length} sections)`,
      );
    }
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
      case 'compact_session':
        await this.processSessionCompaction(session, event.callbacks);
        break;
      case 'rotate_session':
        await this.processSessionRotation(event.callbacks);
        break;
      case 'update_memory':
        await this.processSessionMemoryUpdate(session, event.callbacks);
        break;
    }
  }

  private async processMessageBatch(
    conversationId: string,
    session: AgentSession,
    messages: readonly IncomingMessage[],
  ): Promise<void> {
    await this.injectConversationContextIfNeeded(conversationId, session);
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
      log.error(`${this.logTag} Prompt/send failed for ${conversationId}`, err);
    } finally {
      this.app.setStatus('idle', conversationId);
    }
  }

  private async processContactBatch(session: AgentSession, events: readonly ContactEvent[]): Promise<void> {
    const userText = this.promptManager.formatContactPrompt(session.promptFormatterVersion, events);
    log.debug(`${this.logTag} Processing ${String(events.length)} contact event(s)`);

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
      log.error(`${this.logTag} Contact event processing failed`, err);
    }
  }

  private async processCronTrigger(session: AgentSession, job: CronTriggerEvent): Promise<void> {
    const userText = this.promptManager.formatCronPrompt(session.promptFormatterVersion, job);
    log.debug(`${this.logTag} Processing cron ${job.cronId} ("${job.label}")`);

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
      log.error(`${this.logTag} Cron processing failed for ${job.cronId}`, err);
    }
  }

  private async processSessionCompaction(session: AgentSession, callbacks: readonly OwnerOpCallback[]): Promise<void> {
    try {
      const result = await session.handleCompactSession();
      callbacks.forEach((callback) => callback.resolve(result));
    } catch (err: unknown) {
      callbacks.forEach((callback) => callback.reject(err));
    }
  }

  private async processSessionRotation(callbacks: readonly OwnerOpCallback[]): Promise<void> {
    try {
      await this.rotateSession();
      callbacks.forEach((callback) => callback.resolve({ success: true }));
    } catch (err: unknown) {
      callbacks.forEach((callback) => callback.reject(err));
    }
  }

  private async processSessionMemoryUpdate(
    session: AgentSession,
    callbacks: readonly OwnerOpCallback[],
  ): Promise<void> {
    try {
      await collectAgentMessage(
        session.prompt(this.promptManager.buildMemoryUpdatePrompt(session.promptFormatterVersion)),
      );
      callbacks.forEach((callback) => callback.resolve({ success: true }));
    } catch (err: unknown) {
      callbacks.forEach((callback) => callback.reject(err));
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
    app.onUpdateMemory((request) => this.handleUpdateMemory(request));
    app.onRotateSession((request) => this.handleRotateSession(request));
  }

  /** Get live session info for a session. */
  private getLiveSessionInfo(request: LiveSessionInfoRequest): LiveSessionInfoResponse {
    const slot = this.sharedSessionSlot;
    if (!slot?.session) {
      return {
        sessionType: request.sessionType,
        externalReferenceId: request.externalReferenceId,
        isLive: false,
        availableModels: [],
        availableModes: [],
        canCancel: false,
        canCompact: false,
      };
    }
    return slot.session.getLiveSessionInfo();
  }

  /** Handle cancel session signal. */
  private async handleCancelSession(_request: CancelSessionRequest): Promise<CancelSessionResponse> {
    const slot = this.sharedSessionSlot;
    if (!slot?.session) {
      return { success: false, errorCode: 'session_not_live', error: 'Session not found or not active' };
    }
    const result = await slot.session.handleCancelSession();
    slot.queue.reset();
    return result;
  }

  /** Handle compact session signal. */
  private async handleCompactSession(_request: CompactSessionRequest): Promise<CompactSessionResponse> {
    const slot = this.sharedSessionSlot;
    if (!slot?.session) {
      return { success: false, errorCode: 'session_not_live', error: 'Session not found or not active' };
    }
    if (slot.inFlight) {
      return { success: false, errorCode: 'session_busy', error: 'Session is processing a message' };
    }
    try {
      return await new Promise<CompactSessionResponse>((resolve, reject) => {
        slot.queue.enqueueOwnerOp('compact_session', { resolve, reject });
      });
    } catch {
      return { success: false, error: 'Operation cancelled' };
    }
  }

  /** Handle start session signal. Launches the session if not already running. */
  private async handleStartSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    if (request.sessionType !== 'conversation') {
      return { success: false, error: 'Can only start conversation session ondemand' };
    }
    const slot = this.getOrCreateSharedSessionSlot();
    try {
      await slot.sessionPromise;
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Session launch failed' };
    }
    if (!slot.session) {
      return { success: false, error: 'Session launch failed' };
    }
    const info = slot.session.getLiveSessionInfo();
    return { success: true, info };
  }

  /** Handle update_memory signal — run the mid-session memory-update prompt. */
  private async handleUpdateMemory(_request: UpdateMemoryRequest): Promise<UpdateMemoryResponse> {
    const slot = this.sharedSessionSlot;
    if (!slot?.session) {
      return { success: false, errorCode: 'session_not_live', error: 'Session not found or not active' };
    }
    if (slot.inFlight) {
      return { success: false, errorCode: 'session_busy', error: 'Session is processing a message' };
    }
    try {
      return await new Promise<UpdateMemoryResponse>((resolve, reject) => {
        slot.queue.enqueueOwnerOp('update_memory', { resolve, reject });
      });
    } catch {
      return { success: false, error: 'Operation cancelled' };
    }
  }

  /** Handle rotate_session signal — end current session (with handoff note), next event starts fresh. */
  private async handleRotateSession(request: RotateSessionRequest): Promise<RotateSessionResponse> {
    if (request.sessionType !== 'conversation') {
      return { success: false, errorCode: 'invalid_session_type', error: 'Can only rotate conversation sessions' };
    }
    const slot = this.sharedSessionSlot;
    if (!slot?.session) {
      return { success: false, errorCode: 'session_not_live', error: 'Session not found or not active' };
    }
    if (slot.inFlight) {
      return { success: false, errorCode: 'session_busy', error: 'Session is processing a message' };
    }
    try {
      return await new Promise<RotateSessionResponse>((resolve, reject) => {
        slot.queue.enqueueOwnerOp('rotate_session', { resolve, reject });
      });
    } catch {
      return { success: false, error: 'Operation cancelled' };
    }
  }

  initiateConversation(_conversationId: string, _context: string): void {
    throw new Error('Shared session does not support initiating conversation');
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

      // Shared session slot
      if (
        this.sharedSessionSlot?.session &&
        now - this.sharedSessionSlot.lastActivityAt > timeout &&
        !this.sharedSessionSlot.inFlight
      ) {
        log.info(`${this.logTag} Idle session cleanup: shared session`);
        await this.endSession(this.sharedSessionSlot);
      }
    } finally {
      this.cleaningUpIdleSessions = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Session rotation & memory update
  // ---------------------------------------------------------------------------

  /** Rotate a session in-place: run session-end prompt, end old session, launch new, assign to slot. */
  private async rotateSession(): Promise<void> {
    log.info(`${this.logTag} Rotating shared session in-place`);
    const slot = this.sharedSessionSlot;
    if (!slot?.session) {
      return;
    }

    const oldSession = slot.session;
    let handoffNote: string | undefined;

    try {
      const fullOutput = await collectAgentMessage(
        oldSession.prompt(this.promptManager.buildSessionEndPrompt(oldSession.promptFormatterVersion)),
      );
      const handoffMatch = fullOutput?.match(/HANDOFF:\s*([\s\S]+)/i);
      if (handoffMatch && handoffMatch[1]) {
        handoffNote = handoffMatch[1].trim();
        log.info(`${this.logTag} Captured handoff for shared session (${handoffNote.length} chars)`);
      }
    } catch (err: unknown) {
      log.warn(`${this.logTag} Session-end prompt failed for shared session`, err);
    }

    // End old session
    slot.session = undefined;
    await this.sessionFactory.endSession(oldSession.correlationId);
    this.injectedConversationIds.clear();
    this.injectedUserIds.clear();

    // Launch new session (serialized through launch queue) and assign to slot
    try {
      const newSession = await this.enqueueLaunch(handoffNote);
      slot.session = newSession;
      log.info(`${this.logTag} Rotated shared session: → ${newSession.correlationId}`);
    } catch (err: unknown) {
      log.error(`${this.logTag} Failed to launch replacement shared session`, err);
      // Persist handoff so the self-recovery path can load it from backend
      if (handoffNote) {
        this.app.client
          .putHandoffNote({
            agentId: this.app.identity.userId,
            conversationId: EXTERNAL_REFERENCE_ID,
            text: handoffNote,
          })
          .catch((e: unknown) => log.warn(`${this.logTag} Failed to persist handoff note`, e));
      }
      slot.queue.close();
      this.sharedSessionSlot = undefined;
    }
  }

  /**
   * End a session: inject session-end prompt (for conversation sessions),
   * close queue, dispose if possible, remove from collection.
   */
  private async endSession(slot: SessionSlot): Promise<void> {
    const session = slot.session;
    if (!session) {
      slot.queue.close();
      this.sharedSessionSlot = undefined;
      return;
    }

    try {
      const fullOutput = await collectAgentMessage(
        session.prompt(this.promptManager.buildSessionEndPrompt(session.promptFormatterVersion)),
      );

      const handoffMatch = fullOutput?.match(/HANDOFF:\s*([\s\S]+)/i);
      if (handoffMatch && handoffMatch[1]) {
        const summary = handoffMatch[1].trim();
        await this.app.client.putHandoffNote({
          agentId: this.app.identity.userId,
          conversationId: EXTERNAL_REFERENCE_ID,
          text: summary,
        });
        log.info(`${this.logTag} Captured handoff shared session (${summary.length} chars)`);
      }
    } catch (err: unknown) {
      log.warn(`${this.logTag} Session-end prompt failed for shared session`, err);
    }

    slot.queue.close();
    await this.sessionFactory.endSession(session.correlationId);
    this.sharedSessionSlot = undefined;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private setStatus(status: AgentRuntimeStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.listener.onStatusChanged(status, error);
  }

  /** Get the conversation flags for a conversation (defaults to all off). */
  private getConversationFlags(conversationId: string): ConversationFlags {
    return this.conversationFlags.get(conversationId) ?? { showToolCalls: false, showThoughts: false };
  }
}
