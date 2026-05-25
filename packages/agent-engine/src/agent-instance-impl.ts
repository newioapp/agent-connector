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
} from './types';
import type { AgentInfo, PermissionRequestOption, ConversationFlags } from './types';
import type { AgentInstance, AgentInstanceListener } from './agent-instance';
import type { CronStore } from './cron-store';
import type { EngineConfig } from './engine-config';
import { PromptManager } from './prompt-manager';
import { getLogger } from '@newio/agent-sdk';
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

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export abstract class BaseAgentInstance implements AgentInstance {
  status: AgentRuntimeStatus = 'stopped';
  error?: string;

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
  /** Socket path for the MCP UDS server. Set after auth in start(). */
  private _mcpSocketPath?: string;

  /** Per-conversation flags toggled by the owner (e.g. show_tool_call, show_thoughts). */
  private readonly conversationFlags = new Map<string, ConversationFlags>();
  /** Inbound event buffer — events captured synchronously, routed serially. */
  protected readonly inbound: InboundEvent[] = [];
  private draining = false;
  protected abortController = new AbortController();
  private pendingCleanup?: Promise<void>;
  private udsServer?: Server;
  /** Most recently created MCP server awaiting a sessionId to be wired. */
  protected pendingMcpServer?: NewioMcpServerInterface;

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

      this.udsServer = startUdsServer({
        socketPath: mcpSocketPath,
        onConnection: (transport) => {
          log.info(`${this.logTag} MCP client connected via ${mcpSocketPath}`);
          if (this.pendingMcpServer) {
            log.warn(`${this.logTag} New MCP connection arrived before previous one was wired to a session`);
          }
          const mcpServer = this.createMcpServer(app);
          this.pendingMcpServer = mcpServer;
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

      const eventProcessor = new SessionEventProcessorImpl(
        `[${app.identity.username}]`,
        {
          identity: app.identity,
          getConversationFlags: (convId) => this.getConversationFlags(convId),
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

      if (this.config.sessionMode === 'shared') {
        this._sessionManager = new SharedSessionManager(
          `[${app.identity.username}]`,
          eventProcessor,
          (sessionType, externalReferenceId) => this.launchSession(sessionType, externalReferenceId),
          (correlationId) => this.sessionFactory.destroySession(correlationId),
          this._promptManager,
          this.getNewioAppForSession(),
        );
      } else {
        this._sessionManager = new IsolatedSessionManager(
          `[${app.identity.username}]`,
          eventProcessor,
          (sessionType, externalReferenceId) => this.launchSession(sessionType, externalReferenceId),
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

  private getNewioAppForSession(): NewioAppForSession {
    return {
      handlePermissionRequest: (title, options, conversationId) =>
        this.handlePermissionRequest(title, options, conversationId),
      setStatus: (status, conversationId) => this.app.setStatus(status, conversationId),
      getSessionConfig: (convId) => Promise.resolve(this.app.getSessionConfig(convId)),
      loadMemoryForSession: (conversationId) => this.loadMemoryForSession(conversationId),
      getHandoffNote: (conversationId) => this.app.getHandoffNote(conversationId),
      putHandoffNote: (conversationId: string, note: string) => this.app.putHandoffNote(conversationId, note),
      getMemoryScope: (scope, scopeId) => this.app.getMemoryScope(scope, scopeId),
      getConversationMemberIds: (conversationId) => this.app.getConversationMemberIds(conversationId),
      getMemberDisplayInfo: (conversationId, userId) => this.app.getMemberDisplayInfo(conversationId, userId),
      updateAgentMemberConfig: (conversationId, config) => this.app.updateAgentMemberConfig(conversationId, config),
      agentUserId: this.app.identity.userId,
      getOwnerDmConversationId: () => {
        if (!this._ownerDmConversationId) {
          throw new Error('Owner DM conversation ID not yet resolved');
        }
        return this._ownerDmConversationId;
      },
    };
  }

  private async loadMemoryForSession(conversationId?: string) {
    let participantIds: string[] | undefined = undefined;
    if (typeof conversationId === 'string') {
      const meta = this.app.getCachedConversationInfo(conversationId);
      // For DMs, load full memory for the other participant
      if (meta?.type === 'dm') {
        const memberIds = this.app.getConversationMemberIds(conversationId);
        if (memberIds) {
          participantIds = memberIds.filter((id) => id !== this.app.identity.userId);
        }
      } else {
        participantIds = [];
      }
    }

    return this.app.loadSessionMemory(conversationId, participantIds);
  }

  private async launchSession(type: SessionType, externalReferenceId: string): Promise<AgentSession> {
    if (this.abortController.signal.aborted) {
      throw new Error('Agent is stopping — session launch aborted');
    }

    const session = await this.createSessionWithErrorHandling(type, externalReferenceId);

    // Wire MCP sessionId
    if (this.pendingMcpServer) {
      this.pendingMcpServer.setCurrentConversationIdGetter(() => session.currentConversationId);
      this.pendingMcpServer = undefined;
      log.debug(`${this.logTag} Wired externalReferenceId ${type}:${externalReferenceId} to pending MCP server`);
    }

    return session;
  }

  private async createSessionWithErrorHandling(type: SessionType, externalReferenceId: string): Promise<AgentSession> {
    const ownerId = this.app.identity.ownerId;
    if (!ownerId) {
      throw new Error('Cannot create session: ownerId is not set');
    }
    try {
      const session = await this.sessionFactory.createSession({
        type,
        externalReferenceId,
        promptFormatterVersion: this.promptManager.defaultVersion,
        mcpSocketPath: this.mcpSocketPath,
        mcpBridgePath: this.engineConfig.mcpBridgePath,
        skipToken: this.promptManager.skipToken(this.promptManager.defaultVersion),
        updateConfig: async (config) => {
          await this.app.updateAgentMemberConfig(externalReferenceId, {
            acpModel: config.acpModel,
            acpMode: config.acpMode,
          });
        },
        reportContextWindow: async (context) => {
          await this.app.sendContextWindowUpdate(ownerId, type, externalReferenceId, context.size, context.used);
        },
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
    // - showToolCalls/showThoughts → conversation flags
    // - acpModel/acpMode → apply to live session
    // (session.updated is deprecated; acpModel/acpMode now flow through conversation.member_updated)
    app.onConversationMemberUpdated((event) => {
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

    // Drain inbound queue
    this.inbound.length = 0;
    this.conversationFlags.clear();

    await this.sessionManager.terminate();

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
        sessionMode: this.config.sessionMode === 'shared' ? 'shared' : 'isolated',
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
    const ownerIsInConversation = conversationId && this.app.isConversationMember(conversationId, ownerId);
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
    const meta = this.app.getCachedConversationInfo(conversationId);
    if (meta?.type === 'dm') {
      const memberIds = this.app.getConversationMemberIds(conversationId);
      if (memberIds) {
        for (const userId of memberIds) {
          if (userId !== this.app.identity.userId) {
            const info = this.app.getMemberDisplayInfo(conversationId, userId);
            const name = info?.displayName ?? info?.username ?? userId;
            return `Requesting permission for a DM conversation with ${name}`;
          }
        }
      }
      return `Requesting permission for a DM conversation`;
    }
    const label = meta?.name ?? conversationId;
    return `Requesting permission for ${label} conversation`;
  }

  // ---------------------------------------------------------------------------
  // Capability management
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  protected setStatus(status: AgentRuntimeStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.listener.onStatusChanged(status, error);
  }

  /** Get the conversation flags for a conversation (defaults to all off). */
  private getConversationFlags(conversationId: string): ConversationFlags {
    return this.conversationFlags.get(conversationId) ?? { showToolCalls: false, showThoughts: false };
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
      this.config.sessionMode === 'shared' ? 'shared' : 'isolated',
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
      sessionMode: this.config.sessionMode === 'shared' ? 'shared' : 'isolated',
    });
  }
}
