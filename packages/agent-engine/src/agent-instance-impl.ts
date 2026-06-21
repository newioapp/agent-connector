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
import { ApprovalTimeoutError, ConnectionRejectedError, NotFoundApiError, SHARED_SESSION_ID } from '@newio/agent-sdk';
import { NewioApp } from './app/index.js';
import type { ActionOption, ActionRequest } from '@newio/agent-sdk';
import { NewioMcpServer, startUdsServer } from './mcp/index.js';
import type { Server } from 'net';
import { hostname, tmpdir } from 'os';
import { join } from 'path';
import type { AgentConfigManager } from './agent-config-manager';
import type {
  AgentRuntimeStatus,
  AgentConfig,
  NewioAppForAgent,
  InboundEvent,
  SessionManager,
  SessionFactory,
  NewioAppForSession,
  SessionType,
  CreateSessionInput,
  SharedInjectionState,
} from './types';
import { resolveSessionMode } from './types';
import { ChatSharedSessionManager } from './chat-shared-session-manager.js';
import type { AgentInfo, AgentErrorCode, PermissionRequestOption } from './types';
import { InvalidEnvironmentError } from './errors.js';
import type { AgentInstance, AgentInstanceListener } from './agent-instance';
import type { CronStore } from './cron-store';
import type { SessionStore } from './session-store';
import { sessionStoreKey } from './session-store';
import { JsonSessionStore } from './json-session-store.js';
import type { EngineConfig } from './engine-config';
import { PromptManager } from './prompt-manager';
import { getLogger } from '@newio/agent-sdk';
import type { WsConnectionStatus } from '@newio/agent-sdk';
import WebSocket from 'ws';
import { PromptFormatterImpl } from './prompt-formatter';
import { AcpSessionFactory } from './acp-session-factory.js';
import { collectAgentMessage, resolveCommand, extractErrorMessage } from './utils.js';
import { SharedSessionManager } from './shared-session-manager.js';
import { IsolatedSessionManager } from './isolated-session-manager.js';
import { SessionEventProcessorImpl } from './session-event-processor-impl.js';
import { AgentSession } from './agent-session.js';
import { NewioAppForMcp, NewioMcpServerInterface } from './mcp/types.js';

const log = getLogger('agent-instance-impl');

/**
 * Max time a session launch waits for the agent's MCP bridge to connect to the
 * UDS socket before proceeding unwired. Some agents (kiro/claude) connect during
 * `newSession`; others (codex-acp) connect shortly after it returns. This bounds
 * the wait so a misbehaving agent that never connects can't wedge the launch queue.
 */
const MCP_CONNECT_TIMEOUT_MS = 10_000;

/**
 * After a failed `loadSession`, wait this long before arming the fallback
 * create's MCP waiter. The MCP socket path is shared, so a bridge spawned by the
 * rejected `loadSession` could connect late; during this drain `pendingMcpWiring`
 * is undefined, so that stale bridge hits the no-waiter path instead of stealing
 * the fallback create's waiter. Best-effort (the fallback path is already rare).
 */
const RESUME_FALLBACK_MCP_DRAIN_MS = 250;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rendezvous between a session launch and the MCP bridge connection it triggers. */
interface McpWiringWaiter {
  readonly promise: Promise<NewioMcpServerInterface>;
  readonly resolve: (server: NewioMcpServerInterface) => void;
}

export abstract class BaseAgentInstance implements AgentInstance {
  status: AgentRuntimeStatus = 'stopped';
  error?: string;
  errorCode?: AgentErrorCode;

  /** Log prefix including the agent's username when available. */
  protected get logTag(): string {
    const u = this.config.newio?.username;
    return u ? `[${u}]` : '';
  }

  private _app?: NewioAppForAgent;
  private _promptManager?: PromptManager;
  private _ownerDmConversationId?: string;
  private _sessionFactory?: SessionFactory;
  private _sessionManager?: SessionManager;
  /**
   * Maps `sessionType/externalReferenceId` → the correlationId of the session
   * that last served it, so the next event can resume (`session/load`) instead
   * of creating fresh. Persisted to disk; survives idle teardown and restarts.
   */
  private _sessionStore?: SessionStore;
  /** Socket path for the MCP UDS server. Set after auth in start(). */
  private _mcpSocketPath?: string;

  /** Inbound event buffer — events captured synchronously, routed serially. */
  protected readonly inbound: InboundEvent[] = [];
  private draining = false;
  protected abortController = new AbortController();
  private pendingCleanup?: Promise<void>;
  private udsServer?: Server;
  /**
   * Set while a session launch is awaiting its MCP bridge connection. The UDS
   * `onConnection` handler resolves this when the bridge connects, regardless of
   * whether that happens during `newSession` (kiro/claude) or after it returns
   * (codex-acp). Launches are serialized by the session manager's launch queue,
   * so at most one waiter is outstanding at a time.
   */
  private pendingMcpWiring?: McpWiringWaiter;

  constructor(
    protected readonly config: AgentConfig,
    protected readonly configManager: AgentConfigManager,
    protected readonly cronStore: CronStore,
    protected readonly listener: AgentInstanceListener,
    protected readonly engineConfig: EngineConfig,
  ) {}

  abstract createNewioApp(): Promise<NewioAppForAgent & NewioAppForMcp>;

  abstract createPromptManager(): Promise<PromptManager>;

  abstract createMcpServer(app: NewioAppForMcp): NewioMcpServerInterface;

  /**
   * Open the per-agent session store used to RESUME a prior ACP session instead
   * of always creating a fresh one. Override to substitute storage — e.g. an
   * in-memory, non-persisted store for evals, which should start each run clean
   * and never resume a stale session from a previous run. Default: a JSON file
   * beside the cron store.
   */
  protected createSessionStore(): SessionStore {
    return new JsonSessionStore(join(this.engineConfig.dataDir, 'agents', this.config.id, 'sessions.json'));
  }

  getAgentInfo(): AgentInfo | undefined {
    return this._sessionFactory?.getAgentInfo();
  }

  getWsStatus(): WsConnectionStatus | undefined {
    return this._app?.getConnectionStatus();
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
      const app = await this.createNewioApp();

      this._app = app;

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

      this._promptManager = await this.createPromptManager();

      // Open the per-agent session store (mirrors the cron store location) so
      // launches can resume the prior ACP session instead of always creating new.
      this._sessionStore = this.createSessionStore();

      this.udsServer = startUdsServer({
        socketPath: mcpSocketPath,
        onConnection: (transport) => {
          log.info(`${this.logTag} MCP client connected via ${mcpSocketPath}`);
          const mcpServer = this.createMcpServer(app);
          const waiter = this.pendingMcpWiring;
          if (waiter) {
            // Hand the server to the launch awaiting it. The launch wires the
            // conversation-id getter once its session exists, in either arrival order.
            this.pendingMcpWiring = undefined;
            waiter.resolve(mcpServer);
          } else {
            // No launch is waiting — e.g. the connection arrived after a launch
            // timed out, or a stray reconnect. There is no session to bind it to,
            // so it stays unwired (conversation-scoped tools will report no active
            // conversation). This should not happen in normal serialized operation.
            log.warn(
              `${this.logTag} MCP connection arrived with no session launch awaiting it — leaving conversation-id getter unwired`,
            );
          }
          void mcpServer.connect(transport);
        },
      });
      log.info(`${this.logTag} MCP UDS server listening on ${mcpSocketPath}`);

      const ownerId = this.app.identity.ownerId;
      if (!ownerId) {
        throw new Error('Cannot create session: ownerId is not set');
      }

      this._sessionFactory = new AcpSessionFactory(
        this.config,
        this.engineConfig.appDisplayName,
        this.engineConfig.appVersion,
        `[${app.identity.username}]`,
        this.engineConfig.mcpBridgeIsSelfContained ?? false,
      );
      this._sessionFactory.onAbnormalTermination((message) => {
        // Ignore if a cleanup is already running (e.g. an intentional stop in
        // progress) — re-entering cleanup races the in-flight teardown.
        if (this.pendingCleanup) {
          return;
        }
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

      const eventProcessor = new SessionEventProcessorImpl(
        `[${app.identity.username}]`,
        {
          identity: app.identity,
          getConversationControls: (convId) => app.getConversationControls(convId),
          isConversationMember: (conversationId: string, userId: string) =>
            this.app.isConversationMember(conversationId, userId),
          sendMessage: (conversationId, text, opts) => this.app.sendMessage(conversationId, text, opts),
          setStatus: (status, conversationId) => this.app.setStatus(status, conversationId),
          rotateSession: async (sessionType, externalReferenceId) => {
            if (this._sessionManager) {
              return await this._sessionManager.rotateSession(sessionType, externalReferenceId);
            }
          },
        },
        this._promptManager,
      );

      const sessionMode = resolveSessionMode(this.config.sessionMode);
      if (sessionMode === 'shared') {
        const ownerDmConversationId = await app.getOrCreateOwnerDmConversationId();
        this._ownerDmConversationId = ownerDmConversationId;
        this._sessionManager = new SharedSessionManager(
          `[${app.identity.username}]`,
          eventProcessor,
          (sessionType, externalReferenceId, resume) => this.launchSession(sessionType, externalReferenceId, resume),
          (correlationId) => this.sessionFactory.destroySession(correlationId),
          this._promptManager,
          this.getNewioAppForSession(),
          ownerDmConversationId,
        );
      } else if (sessionMode === 'chat-shared') {
        const ownerDmConversationId = await app.getOrCreateOwnerDmConversationId();
        this._ownerDmConversationId = ownerDmConversationId;
        this._sessionManager = new ChatSharedSessionManager(
          `[${app.identity.username}]`,
          eventProcessor,
          (sessionType, externalReferenceId, resume) => this.launchSession(sessionType, externalReferenceId, resume),
          (correlationId) => this.sessionFactory.destroySession(correlationId),
          this._promptManager,
          this.getNewioAppForSession(),
          ownerDmConversationId,
        );
      } else {
        this._sessionManager = new IsolatedSessionManager(
          `[${app.identity.username}]`,
          eventProcessor,
          (sessionType, externalReferenceId, resume) => this.launchSession(sessionType, externalReferenceId, resume),
          (correlationId) => this.sessionFactory.destroySession(correlationId),
          this._promptManager,
          this.getNewioAppForSession(),
        );
      }
      this._sessionManager.startIdleCleanup();

      this.wireEventHandlers(app, this._sessionManager);

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

      await this.sendGreeting();

      log.info(`${this.logTag} Agent running`);
      this.setStatus('running');
    } catch (err: unknown) {
      const wasAborted = abortController.signal.aborted;
      // Same ordered teardown as stop(): mark stopping BEFORE cleanup, so a
      // session created earlier in start() (e.g. before sendGreeting() failed)
      // doesn't trip the abnormal-termination re-entry when cleanup closes it.
      await this.teardown();

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
      } else if (err instanceof InvalidEnvironmentError) {
        log.warn(`${this.logTag} Invalid environment`, err.message);
        this.setStatus('error', err.message, err.errorCode);
      } else if (isErrnoException(err) && err.code === 'ENOENT') {
        const executable = this.config.acp ? resolveCommand(this.config.type, this.config.acp).command : 'unknown';
        log.warn(`${this.logTag} Executable not found: ${executable}`);
        this.setStatus(
          'error',
          `"${executable}" not found. Make sure it is installed and available on the agent's PATH, or set the executable path in the agent config.\n\n${err.stack ?? err.message}`,
          'invalid_environment',
        );
      } else {
        const message = extractErrorMessage(err);
        log.error(`${this.logTag} Failed to start`, err instanceof Error ? (err.stack ?? message) : message);
        this.setStatus('error', message);
      }
    }
  }

  private getNewioAppForSession(): NewioAppForSession {
    return {
      handlePermissionRequest: (title, options, conversationId) =>
        this.handlePermissionRequest(title, options, conversationId),
      setStatus: (status, conversationId) => this.app.setStatus(status, conversationId),
      getConversationControls: (convId) => this.app.getConversationControls(convId),
      getConversationInfo: (convId) => this.app.getConversationInfo(convId),
      loadMemoryForSession: (conversationId) => this.loadMemoryForSession(conversationId),
      getHandoffNote: (conversationId) => this.app.getHandoffNote(conversationId),
      putHandoffNote: (conversationId: string, note: string) => this.app.putHandoffNote(conversationId, note),
      getMemoryScope: (scope, scopeId) => this.app.getMemoryScope(scope, scopeId),
      getConversationMemberIds: (conversationId) => this.app.getConversationMemberIds(conversationId),
      getMemberInfo: (conversationId, userId) => this.app.getMemberInfo(conversationId, userId),
      agentUserId: this.app.identity.userId,
      loadSharedInjectionState: () => this.loadSharedInjectionState(),
      persistSharedInjectionState: (conversationIds, userIds) =>
        this.persistSharedInjectionState(conversationIds, userIds),
    };
  }

  /** Store key for the single shared session (shared mode only). */
  private get sharedSessionKey(): string {
    return sessionStoreKey('conversation', SHARED_SESSION_ID);
  }

  private loadSharedInjectionState(): SharedInjectionState {
    const stored = this._sessionStore?.get(this.sharedSessionKey);
    return {
      conversationIds: stored?.injectedConversationIds ?? [],
      userIds: stored?.injectedUserIds ?? [],
    };
  }

  private persistSharedInjectionState(conversationIds: readonly string[], userIds: readonly string[]): void {
    this._sessionStore?.setInjectionState(this.sharedSessionKey, conversationIds, userIds);
  }

  private async loadMemoryForSession(conversationId?: string) {
    let participantIds: string[] | undefined = undefined;
    if (typeof conversationId === 'string') {
      const meta = await this.app.getConversationInfo(conversationId);
      // For DMs, load full memory for the other participant
      if (meta.type === 'dm') {
        const memberIds = await this.app.getConversationMemberIds(conversationId);
        participantIds = memberIds.filter((id) => id !== this.app.identity.userId);
      } else {
        participantIds = [];
      }
    }

    return this.app.loadSessionMemory(conversationId, participantIds);
  }

  private async launchSession(type: SessionType, externalReferenceId: string, resume: boolean): Promise<AgentSession> {
    if (this.abortController.signal.aborted) {
      throw new Error('Agent is stopping — session launch aborted');
    }
    return this.createOrResumeSession(type, externalReferenceId, resume);
  }

  /**
   * Run a single ACP session op (`produce`) with its own MCP bridge rendezvous,
   * then wire the conversation-id getter once the bridge connects. The waiter is
   * scoped to ONE op and cleared in `finally`, so a failed resume's bridge can't
   * be mistaken for the create-fallback's bridge.
   */
  private async launchWithMcpWiring(
    type: SessionType,
    externalReferenceId: string,
    produce: () => Promise<AgentSession>,
  ): Promise<AgentSession> {
    // Arm the rendezvous BEFORE the op so we capture the MCP bridge connection
    // whether it arrives during the op (kiro/claude) or after it returns (codex-acp).
    let resolveMcp!: (server: NewioMcpServerInterface) => void;
    const mcpServerPromise = new Promise<NewioMcpServerInterface>((resolve) => {
      resolveMcp = resolve;
    });
    this.pendingMcpWiring = { promise: mcpServerPromise, resolve: resolveMcp };

    try {
      const session = await produce();

      // The getter reads the session's live `currentConversationId` (set per-prompt),
      // so conversation-scoped tools resolve the active conversation.
      const mcpServer = await this.awaitMcpConnection(mcpServerPromise, type, externalReferenceId);
      if (mcpServer) {
        mcpServer.setCurrentConversationIdGetter(() => session.currentConversationId);
        log.info(`${this.logTag} Wired externalReferenceId ${type}:${externalReferenceId} to MCP server`);
      }

      return session;
    } finally {
      this.pendingMcpWiring = undefined;
    }
  }

  /**
   * Wait (bounded) for the MCP bridge connection belonging to the in-flight
   * launch. Returns the server once connected, or `undefined` if it never
   * connects within {@link MCP_CONNECT_TIMEOUT_MS} — in which case the session
   * still runs, but conversation-scoped tools will report no active conversation.
   */
  private async awaitMcpConnection(
    serverPromise: Promise<NewioMcpServerInterface>,
    type: SessionType,
    externalReferenceId: string,
  ): Promise<NewioMcpServerInterface | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), MCP_CONNECT_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([serverPromise, timeout]);
      if (!result) {
        log.error(
          `${this.logTag} MCP bridge did not connect within ${MCP_CONNECT_TIMEOUT_MS}ms for ${type}:${externalReferenceId} — conversation-scoped tools will be unwired`,
        );
      }
      return result;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Build the CreateSessionInput for both paths. `promptFormatterVersion` is
   * passed in so the version and its `skipToken` come from the same formatter —
   * resume uses the persisted version, create uses the default.
   */
  private buildSessionInput(
    type: SessionType,
    externalReferenceId: string,
    promptFormatterVersion: string,
  ): CreateSessionInput {
    const ownerId = this.app.identity.ownerId;
    if (!ownerId) {
      throw new Error('Cannot create session: ownerId is not set');
    }
    return {
      type,
      externalReferenceId,
      promptFormatterVersion,
      mcpSocketPath: this.mcpSocketPath,
      mcpBridgeCommand: this.engineConfig.mcpBridgeCommand,
      mcpBridgeArgsPrefix: this.engineConfig.mcpBridgeArgsPrefix,
      skipToken: this.promptManager.skipToken(promptFormatterVersion),
      updateConfig: async (config) => {
        // SHARED_SESSION_ID (the shared singleton in the experimental shared mode) is a
        // connector-internal id, NOT a backend Conversation — writing member config to it 404s. It
        // reads its config from the owner DM member record, so that record is the canonical home:
        // route the write there instead. Every other slot (isolated conversations, and chat-shared
        // mode's chat slot — now keyed by the owner DM — plus its work/cron slots) owns a real
        // conversation and writes to itself.
        const configConversationId =
          externalReferenceId === SHARED_SESSION_ID ? this._ownerDmConversationId : externalReferenceId;
        if (!configConversationId) {
          log.warn(
            `${this.logTag} Cannot persist session config for ${externalReferenceId}: owner DM conversation not resolved yet`,
          );
          return;
        }
        await this.app.updateAgentMemberConfig(configConversationId, {
          acpModel: config.acpModel,
          acpMode: config.acpMode,
        });
      },
      reportContextWindow: async (context, activeConversationId) => {
        // The chat-shared chat slot's externalReferenceId is the owner DM, but one slot serves many
        // conversations — pass the in-flight turn's conversation separately so clients can attribute
        // usage to the conversation actually being viewed (it's undefined for sessions without a
        // per-turn conversation, e.g. cron).
        await this.app.sendContextWindowUpdate(
          ownerId,
          type,
          externalReferenceId,
          context.size,
          context.used,
          activeConversationId,
        );
      },
    };
  }

  /**
   * Resume the prior session for this key (via `session/load`) when `resume` is
   * set and a mapping exists; otherwise — or if resume fails — create a fresh
   * session whose correlationId is persisted for next time. The returned
   * session's `resumed` flag tells the caller whether context injection is needed.
   */
  private async createOrResumeSession(
    type: SessionType,
    externalReferenceId: string,
    resume: boolean,
  ): Promise<AgentSession> {
    const key = sessionStoreKey(type, externalReferenceId);
    const stored = resume ? this._sessionStore?.get(key) : undefined;

    let resumeFailed = false;
    if (stored) {
      try {
        // A formatter version we can no longer satisfy means a stale instruction.
        this.promptManager.assertPromptFormatterVersion(stored.promptFormatterVersion);
        const resumeInput = this.buildSessionInput(type, externalReferenceId, stored.promptFormatterVersion);
        const session = await this.launchWithMcpWiring(type, externalReferenceId, () =>
          this.sessionFactory.resumeSession({ ...resumeInput, correlationId: stored.correlationId }),
        );
        log.info(`${this.logTag} Resumed session ${type}:${externalReferenceId} → ${stored.correlationId}`);
        return session;
      } catch (err: unknown) {
        log.warn(
          `${this.logTag} Failed to resume session ${type}:${externalReferenceId} (${stored.correlationId}) — falling back to new session`,
          err,
        );
        resumeFailed = true;
      }
    }

    if (resumeFailed) {
      // Let any stale MCP bridge from the rejected loadSession land on the
      // no-waiter path before we arm the fallback create's waiter.
      await delay(RESUME_FALLBACK_MCP_DRAIN_MS);
    }

    const createInput = this.buildSessionInput(type, externalReferenceId, this.promptManager.defaultVersion);
    const session = await this.launchWithMcpWiring(type, externalReferenceId, () =>
      this.sessionFactory.createSession(createInput),
    );
    this._sessionStore?.set(key, session.correlationId, createInput.promptFormatterVersion);
    return session;
  }

  private wireEventHandlers(app: NewioAppForAgent, sessionManager: SessionManager) {
    app.onDisconnect(() => {
      if (!this.abortController.signal.aborted) {
        log.warn(`${this.logTag} WebSocket disconnected unexpectedly`);
      }
    });

    // Wire event handlers — capture synchronously into inbound queue
    app.onMessageNew((msg) => {
      if (!msg.isOwnMessage && !this.abortController.signal.aborted) {
        this.inbound.push({ type: 'message', msg });
        this.drainInbound();
      }
    });

    app.onContactEvent((event) => {
      if (!this.abortController.signal.aborted) {
        this.inbound.push({ type: 'contact', event });
        this.drainInbound();
      }
    });

    app.onCronTriggered((event) => {
      if (!this.abortController.signal.aborted) {
        this.inbound.push({ type: 'cron', event });
        this.drainInbound();
      }
    });

    app.onCronScheduled((def) => {
      this.cronStore.saveCron(this.config.id, def);
    });

    app.onCronCancelled((cronId) => {
      this.cronStore.deleteCron(cronId);
    });

    // React to persisted changes from the owner on this agent's member record:
    // - acpModel/acpMode → apply to live session
    // (session.updated is deprecated; acpModel/acpMode now flow through conversation.member_updated)
    // (showToolCalls/showThoughts are handled by the SDK's internal cache)
    app.onConversationMemberUpdated((event) => {
      const { conversationId, userId, updatedBy, changes } = event;
      if (userId !== app.identity.userId) {
        return;
      }
      // Ignore self-updates — the agent already applied the change locally
      if (updatedBy === app.identity.userId) {
        return;
      }
      if (changes.acpModel !== undefined || changes.acpMode !== undefined) {
        void sessionManager.applySessionConfigUpdate({
          sessionType: 'conversation',
          externalReferenceId: conversationId,
          updates: {
            acpModel: changes.acpModel,
            acpMode: changes.acpMode,
          },
        });
      }
    });

    // Wire capability signal handlers
    app.onLiveSessionInfo((request) => sessionManager.getLiveSessionInfo(request));
    app.onCancelSession((request) => sessionManager.handleCancelSession(request));
    app.onCompactSession((request) => sessionManager.handleCompactSession(request));
    app.onStartSession((request) => sessionManager.handleStartSession(request));
    app.onUpdateMemory((request) => sessionManager.handleUpdateMemory(request));
    app.onRotateSession((request) => sessionManager.handleRotateSession(request));
  }

  private async sendGreeting() {
    const ownerDmConversationId = await this.app.getOrCreateOwnerDmConversationId();
    this._ownerDmConversationId = ownerDmConversationId;
    log.debug(`${this.logTag} Owner DM conversation: ${ownerDmConversationId}`);

    this.setStatus('greeting');
    const session = await this.sessionManager.getDmSession(ownerDmConversationId);

    log.debug(`${this.logTag} [${session.correlationId}] Generating greeting for owner...`);

    // The greeting doubles as a connection test: it exercises a full prompt
    // round-trip so configuration problems (bad model, broken auth, etc.) surface
    // at launch rather than silently on the first real message. Failures here are
    // intentionally fatal. By this point the persisted session config has already
    // been applied (only advertised/valid model+mode values are set), so a valid
    // model is in effect before this prompt runs.
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
    await this.teardown();
    this.setStatus('stopped');
    log.info(`${this.logTag} Agent stopped`);
  }

  /**
   * Ordered teardown shared by all intentional stop paths (`stop()` and the
   * `start()` failure path). Order matters: mark the factory as stopping BEFORE
   * `cleanup()` tears down the session manager and induces the ACP child to
   * exit — otherwise that exit is misclassified as abnormal and fires a
   * re-entrant cleanup that deadlocks. Not used by `onAbnormalTermination`,
   * which reacts to an already-exited process.
   */
  private async teardown(): Promise<void> {
    this._sessionFactory?.markStopping();
    await this.cleanup();
    await this._sessionFactory?.terminate();
  }

  /** Shared cleanup — tears down sessions, MCP server, WebSocket, and timers. */
  private async cleanup(): Promise<void> {
    log.info(`${this.logTag} Running cleanup`);
    this.abortController.abort();

    // Drain inbound queue
    this.inbound.length = 0;

    await this._sessionManager?.terminate();

    if (this.udsServer) {
      this.udsServer.close();
      this.udsServer = undefined;
      log.debug(`${this.logTag} MCP UDS server closed`);
    }

    if (this._app) {
      this._app.dispose();
      this._app = undefined;
    }

    if (this._sessionStore) {
      this._sessionStore.close();
      this._sessionStore = undefined;
    }
  }

  /** Get the NewioApp instance. Throws if not connected. */
  protected get app(): NewioAppForAgent {
    if (!this._app) {
      throw new Error('Agent is not connected — NewioApp is not initialized.');
    }
    return this._app;
  }

  protected get promptManager(): PromptManager {
    if (!this._promptManager) {
      throw new Error('PromptManager is not created.');
    }
    return this._promptManager;
  }

  protected get ownerDmConversationId(): string {
    if (typeof this._ownerDmConversationId !== 'string') {
      throw new Error('Missing dmOwnerConversationId.');
    }
    return this._ownerDmConversationId;
  }

  protected get sessionFactory(): SessionFactory {
    if (!this._sessionFactory) {
      throw new Error('Missing sessionFactory.');
    }
    return this._sessionFactory;
  }

  protected get mcpSocketPath(): string {
    if (typeof this._mcpSocketPath !== 'string') {
      throw new Error('Missing mcpSocketPath.');
    }
    return this._mcpSocketPath;
  }

  protected get sessionManager(): SessionManager {
    if (!this._sessionManager) {
      throw new Error('Missing sessionManager.');
    }
    return this._sessionManager;
  }

  // ---------------------------------------------------------------------------
  // Inbound queue — serial drain ensures arrival-order routing
  // ---------------------------------------------------------------------------

  /** Drain the inbound queue serially. Events are routed one at a time to preserve order. */
  protected drainInbound(): void {
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
          this.sessionManager.routeInboundEvent(event);
        } catch (err: unknown) {
          log.error(`${this.logTag} Failed to route inbound event`, err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private reportAgentInfoToBackend(agentInfo: AgentInfo): void {
    this.app
      .reportAgentInfo({
        agentProtocol: agentInfo.protocol,
        agentVendor: agentInfo.agentName ?? this.config.type,
        agentVendorVersion: agentInfo.agentVersion,
        sessionMode: resolveSessionMode(this.config.sessionMode),
        host: {
          hostname: hostname(),
          workingDirectory: this.config.acp?.cwd,
        },
      })
      .then(() => log.info(`${this.logTag} Agent info reported`))
      .catch((err: unknown) => log.warn(`${this.logTag} Failed to report agent info`, err));
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
    const ownerIsInConversation = conversationId && (await this.app.isConversationMember(conversationId, ownerId));
    const convId = ownerIsInConversation ? conversationId : this.ownerDmConversationId;

    // When rerouting to the owner DM, include context about the source conversation
    let text: string | undefined;
    if (conversationId && !ownerIsInConversation) {
      text = await this.buildPermissionContextText(conversationId);
    }

    log.info(`${this.logTag} Sending permission request ${requestId} to ${convId}`);
    const response = await this.app.sendActionRequest(convId, action, text, [ownerId]);
    return response.selectedOptionId;
  }

  /** Build a human-readable context message for a rerouted permission request. */
  private async buildPermissionContextText(conversationId: string): Promise<string> {
    const meta = await this.app.getConversationInfo(conversationId);
    if (meta.type === 'dm') {
      const memberIds = await this.app.getConversationMemberIds(conversationId);
      for (const userId of memberIds) {
        if (userId !== this.app.identity.userId) {
          const info = await this.app.getMemberInfo(conversationId, userId);
          const name = info?.displayName ?? info?.username ?? userId;
          return `Requesting permission for a DM conversation with ${name}`;
        }
      }
      return `Requesting permission for a DM conversation`;
    }
    const label = meta.name ?? conversationId;
    return `Requesting permission for ${label} conversation`;
  }

  // ---------------------------------------------------------------------------
  // Capability management
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  protected setStatus(status: AgentRuntimeStatus, error?: string, errorCode?: AgentErrorCode): void {
    this.status = status;
    this.error = error;
    this.errorCode = errorCode;
    this.listener.onStatusChanged(status, error, errorCode);
  }
}

export class AgentInstanceImpl extends BaseAgentInstance {
  async createNewioApp(): Promise<NewioAppForAgent & NewioAppForMcp> {
    return await NewioApp.create({
      agentId: this.config.newio?.agentId,
      username: this.config.newio?.username,
      name: this.config.newio?.displayName ?? 'Agent',
      apiBaseUrl: this.engineConfig.apiBaseUrl,
      wsUrl: this.engineConfig.wsUrl,
      wsFactory: (url) => new WebSocket(url) as never,
      proactiveReconnectMs: this.engineConfig.wsProactiveReconnectMs,
      downloadDir: this.engineConfig.downloadsDir,
      tokens: this.configManager.getTokens(this.config.id),
      signal: this.abortController.signal,
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
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createPromptManager(): Promise<PromptManager> {
    const defaultPromptFormatter = new PromptFormatterImpl(
      this.app.identity,
      this.app.getOwnerInfo(),
      resolveSessionMode(this.config.sessionMode),
    );
    return new PromptManager([defaultPromptFormatter], defaultPromptFormatter);
  }

  createMcpServer(app: NewioAppForMcp): NewioMcpServerInterface {
    return new NewioMcpServer({
      app: app,
      initiateConversation: (convId, context) => {
        if (!this.abortController.signal.aborted) {
          this.inbound.push({ type: 'initiate_conversation', conversationId: convId, context: context });
          this.drainInbound();
        }
      },
      shareContext: (convId, context) => {
        if (!this.abortController.signal.aborted) {
          this.inbound.push({ type: 'share_context', conversationId: convId, context: context });
          this.drainInbound();
        }
      },
      sessionMode: resolveSessionMode(this.config.sessionMode),
    });
  }
}
