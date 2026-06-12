/**
 * ChatSharedSessionManager — the 'chat-shared' session strategy.
 *
 * A standalone {@link SessionManager} (deliberately NOT composed from the shared/isolated managers,
 * so those can be deprecated independently). It runs three kinds of sessions:
 *
 * - `chatSlot`          — ONE singleton session for all DMs, group chats, and contact events
 *                         (prompt role 'chat'). Carries context across those conversations and
 *                         injects per-conversation/per-user memory incrementally on first encounter.
 * - `conversationSlots` — one session per work session (temp_group) conversation (prompt role
 *                         'focused'), isolated from the chat session.
 * - `cronSlots`         — one session per cron job (prompt role 'focused').
 *
 * `share_context` (surfaced to the agent as the MCP tool of that name) flows in as an
 * `initiate_conversation` inbound event and is routed to the target conversation's session.
 */
import {
  CancelSessionRequest,
  CancelSessionResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  getLogger,
  LiveSessionInfoRequest,
  LiveSessionInfoResponse,
  RotateSessionRequest,
  RotateSessionResponse,
  SHARED_SESSION_ID,
  StartSessionRequest,
  StartSessionResponse,
  UpdateMemoryRequest,
  UpdateMemoryResponse,
} from '@newio/agent-sdk';
import { AgentEvent, EventQueue } from './event-queue';
import { AgentSession } from './agent-session';
import { PromptManager } from './prompt-manager';
import { SessionPromptRole } from './prompt-formatter';
import { collectAgentMessage } from './utils';
import {
  ApplySessionConfigUpdateRequest,
  SessionEventProcessor,
  InboundEvent,
  NewioAppForSession,
  SessionManager,
  SessionType,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
} from './types';

const log = getLogger('chat-shared-session-manager');

interface SessionSlot {
  readonly type: SessionType;
  /** ConversationId, SHARED_SESSION_ID (chat slot), or cron id. */
  readonly externalReferenceId: string;
  /** Prompt role this slot's sessions are launched with. */
  readonly role: SessionPromptRole;
  readonly queue: EventQueue;
  session: AgentSession | undefined;
  readonly sessionPromise: Promise<AgentSession>;
  lastActivityAt: number;
  /** Non-null while the session loop is processing any event. */
  inFlight: AgentEvent['type'] | null;
}

export class ChatSharedSessionManager implements SessionManager {
  /** The single chat session handling DMs, group chats, and contact events. */
  private chatSlot: SessionSlot | undefined;
  /** conversationId → slot for work-session (temp_group) conversations. */
  private readonly conversationSlots = new Map<string, SessionSlot>();
  /** cronId → slot for cron job sessions. */
  private readonly cronSlots = new Map<string, SessionSlot>();

  /** Conversation scopes already memory-injected into the chat session. */
  private readonly injectedConversationIds = new Set<string>();
  /** User scopes already memory-injected into the chat session. */
  private readonly injectedUserIds = new Set<string>();

  /** Serializes session launches so only one runs at a time (keeps MCP bridge wiring unambiguous). */
  private launchQueue: Promise<void> = Promise.resolve();
  private idleTimer?: ReturnType<typeof setInterval>;
  private cleaningUpIdleSessions = false;
  private terminated = false;

  constructor(
    private readonly logTag: string,
    private readonly eventProcessor: SessionEventProcessor,
    private readonly newSession: (
      sessionType: SessionType,
      externalReferenceId: string,
      resume: boolean,
    ) => Promise<AgentSession>,
    private readonly endSession: (correlationId: string) => Promise<void>,
    private readonly promptManager: PromptManager,
    private readonly app: NewioAppForSession,
    private readonly ownerDmConversationId: string,
  ) {}

  getDmSession(_convId: string): Promise<AgentSession> {
    // All DMs (including the owner DM) are served by the chat session.
    return this.getOrCreateChatSlot().sessionPromise;
  }

  routeInboundEvent(event: InboundEvent): void {
    switch (event.type) {
      case 'message': {
        const slot =
          event.msg.conversationType === 'temp_group'
            ? this.getOrCreateConversationSlot(event.msg.conversationId)
            : this.getOrCreateChatSlot();
        slot.queue.enqueueMessage(event.msg);
        break;
      }
      case 'contact': {
        this.getOrCreateChatSlot().queue.enqueueContact(event.event);
        break;
      }
      case 'cron': {
        this.getOrCreateCronSlot(event.event.cronId).queue.enqueueCron(event.event);
        break;
      }
      case 'initiate_conversation': {
        // share_context — the target is a conversationId only, so resolve its type, then route.
        // TODO(share_context): `share_context` is the generic same-agent cross-session context
        // channel; replace isolated mode's `initiate_conversation` tool with it and rename the
        // internal InboundEvent/AgentEvent `initiate_conversation` plumbing to `share_context`.
        void this.routeShareContext(event.conversationId, event.context);
        break;
      }
    }
  }

  /** Resolve the target conversation's type, then enqueue the shared context onto the right session. */
  private async routeShareContext(conversationId: string, context: string): Promise<void> {
    try {
      const info = await this.app.getConversationInfo(conversationId);
      if (this.terminated) {
        return;
      }
      const slot =
        info.type === 'temp_group' ? this.getOrCreateConversationSlot(conversationId) : this.getOrCreateChatSlot();
      // TODO(share_context): rename EventQueue.enqueueInitiatingConversation → enqueueSharingContext.
      slot.queue.enqueueInitiatingConversation(conversationId, context);
    } catch (err: unknown) {
      log.error(`${this.logTag} share_context routing failed for ${conversationId}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Slot management
  // ---------------------------------------------------------------------------

  private getOrCreateChatSlot(): SessionSlot {
    if (this.chatSlot) {
      this.chatSlot.lastActivityAt = Date.now();
      return this.chatSlot;
    }
    const slot = this.createSlot('conversation', SHARED_SESSION_ID, 'chat');
    this.chatSlot = slot;
    return slot;
  }

  private getOrCreateConversationSlot(conversationId: string): SessionSlot {
    const existing = this.conversationSlots.get(conversationId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }
    const slot = this.createSlot('conversation', conversationId, 'focused');
    this.conversationSlots.set(conversationId, slot);
    return slot;
  }

  private getOrCreateCronSlot(cronId: string): SessionSlot {
    const existing = this.cronSlots.get(cronId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }
    const slot = this.createSlot('cron', cronId, 'focused');
    this.cronSlots.set(cronId, slot);
    return slot;
  }

  /** Look up an existing slot by (type, externalReferenceId). */
  private getSlot(type: SessionType, externalReferenceId: string): SessionSlot | undefined {
    if (type === 'cron') {
      return this.cronSlots.get(externalReferenceId);
    }
    if (type === 'contact') {
      return this.chatSlot;
    }
    // conversation: a known work-session slot wins; otherwise it's the chat slot
    // (covers SHARED_SESSION_ID and any dm/group conversationId).
    if (externalReferenceId !== SHARED_SESSION_ID && this.conversationSlots.has(externalReferenceId)) {
      return this.conversationSlots.get(externalReferenceId);
    }
    return this.chatSlot;
  }

  /** Remove a slot from whichever collection owns it. */
  private removeSlot(slot: SessionSlot): void {
    if (slot === this.chatSlot) {
      this.chatSlot = undefined;
      return;
    }
    if (slot.type === 'cron') {
      this.cronSlots.delete(slot.externalReferenceId);
      return;
    }
    this.conversationSlots.delete(slot.externalReferenceId);
  }

  /** Create a new session slot — shared logic for all slot types. */
  private createSlot(type: SessionType, externalReferenceId: string, role: SessionPromptRole): SessionSlot {
    const queue = new EventQueue(type, externalReferenceId);
    const sessionPromise = this.enqueueLaunch(type, externalReferenceId, role);

    const slot: SessionSlot = {
      type,
      externalReferenceId,
      role,
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
        log.error(`${this.logTag} Session creation failed for ${type}:${externalReferenceId}, closing slot`, err);
        queue.close();
        this.removeSlot(slot);
      },
    );

    return slot;
  }

  private async runSessionLoop(slot: SessionSlot): Promise<void> {
    for await (const event of slot.queue.events()) {
      const session = slot.session;
      if (!session) {
        log.warn(
          `${this.logTag} Session loop has no session for ${slot.type}:${slot.externalReferenceId}, skipping event`,
        );
        continue;
      }
      slot.lastActivityAt = Date.now();
      slot.inFlight = event.type;
      try {
        // Incremental injection (and its injectedConversationIds/injectedUserIds bookkeeping +
        // shared-injection-state persistence) is the CHAT session's mechanism for carrying memory
        // across the many conversations it serves. Focused slots load their single conversation's
        // memory once at launch (like isolated mode), so they must NOT run injection — sharing the
        // injected-* sets would let a work session mark a user as "injected" and make the chat
        // session later skip injecting that same user's memory.
        if (slot.role === 'chat' && event.type === 'messages') {
          await this.injectConversationContextIfNeeded(event.conversationId, session);
        }
        await this.eventProcessor.processEvent(event, session);
      } finally {
        slot.inFlight = null;
      }
    }
    log.debug(`${this.logTag} Session loop ended: ${slot.type}:${slot.externalReferenceId}`);
  }

  // ---------------------------------------------------------------------------
  // Launch + context
  // ---------------------------------------------------------------------------

  private enqueueLaunch(
    type: SessionType,
    externalReferenceId: string,
    role: SessionPromptRole,
    opts: { resume?: boolean; handoffNote?: string } = {},
  ): Promise<AgentSession> {
    const launch = this.launchQueue.then(() => this.launchSession(type, externalReferenceId, role, opts));
    this.launchQueue = launch.then(
      () => {},
      (err: unknown) => {
        log.error(`${this.logTag} Session launch failed for ${type} ${externalReferenceId}`, err);
      },
    );
    return launch;
  }

  private async launchSession(
    type: SessionType,
    externalReferenceId: string,
    role: SessionPromptRole,
    opts: { resume?: boolean; handoffNote?: string } = {},
  ): Promise<AgentSession> {
    const session = await this.newSession(type, externalReferenceId, opts.resume ?? true);

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
      this.app.handlePermissionRequest(title, options, conversationId),
    );

    session.onContextPressure(() => {
      void this.rotateSession(type, externalReferenceId);
    });

    log.info(
      `${this.logTag} Session ready: key=${type}/${externalReferenceId} role=${role} → ${session.correlationId}`,
    );

    // Apply persisted acpModel/acpMode BEFORE providing context (the first prompt must run with
    // the configured model/mode in effect). The chat slot reads config from the owner DM member
    // record; a focused conversation reads it from its own conversation.
    await this.applyPersistedSessionConfig(
      slotConfigSource(type, externalReferenceId, role, this.ownerDmConversationId),
      session,
    );

    if (session.resumed) {
      if (role === 'chat') {
        const state = this.app.loadSharedInjectionState();
        state.conversationIds.forEach((id) => this.injectedConversationIds.add(id));
        state.userIds.forEach((id) => this.injectedUserIds.add(id));
      }
      log.info(`${this.logTag} Resumed session ${type}/${externalReferenceId} — skipping context injection`);
    } else {
      await this.provideContext(session, role, opts.handoffNote);
    }

    return session;
  }

  /** Load and apply persisted acpModel/acpMode from the given conversation, if any. */
  private async applyPersistedSessionConfig(
    configConversationId: string | undefined,
    session: AgentSession,
  ): Promise<void> {
    if (!configConversationId) {
      return;
    }
    try {
      const config = await this.app.getConversationControls(configConversationId);
      if (config) {
        await session.applySessionConfig({ acpModel: config.acpModel, acpMode: config.acpMode });
      }
    } catch (err: unknown) {
      log.warn(`${this.logTag} Failed to apply persisted session config from ${configConversationId}`, err);
    }
  }

  private async provideContext(session: AgentSession, role: SessionPromptRole, handoffNote?: string): Promise<void> {
    log.info(`${this.logTag} Preparing memory (role=${role})`);
    const instruction = this.promptManager.buildNewioInstruction(session.promptFormatterVersion, role);

    // A focused conversation session loads its own conversation's memory; the chat session and
    // cron sessions load global + top-K only (conversationId undefined).
    const memoryConversationId =
      session.type === 'conversation' && session.externalReferenceId !== SHARED_SESSION_ID
        ? session.externalReferenceId
        : undefined;
    const memory = await this.app.loadMemoryForSession(memoryConversationId);

    // Resolve handoff: in-memory note from rotation, else fetch from backend for conversation
    // sessions (the chat slot uses SHARED_SESSION_ID; cron sessions have none).
    let resolvedHandoff: string | null = handoffNote ?? null;
    if (!resolvedHandoff && session.type === 'conversation') {
      resolvedHandoff = await this.app.getHandoffNote(session.externalReferenceId);
    }

    const memoryContext = this.promptManager.formatMemoryContext(
      instruction.version,
      memory,
      resolvedHandoff ?? undefined,
    );
    const fullInstruction = memoryContext ? `${instruction.prompt}\n\n${memoryContext}` : instruction.prompt;

    await collectAgentMessage(session.prompt(fullInstruction));
  }

  /**
   * Inject conversation and participant memory into the chat session the first time we process
   * messages for a given conversation (copied from the shared-session strategy).
   */
  private async injectConversationContextIfNeeded(conversationId: string, session: AgentSession): Promise<void> {
    const agentId = this.app.agentUserId;
    const sections: string[] = [];
    let changed = false;

    if (!this.injectedConversationIds.has(conversationId)) {
      this.injectedConversationIds.add(conversationId);
      changed = true;
      try {
        const data = await this.app.getMemoryScope('conversation', conversationId);
        const parts: string[] = [];
        if (data.summary) {
          parts.push(`Summary: ${(data.summary as { text: string }).text}`);
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

    const memberIds = await this.app.getConversationMemberIds(conversationId);
    for (const userId of memberIds) {
      if (userId === agentId || this.injectedUserIds.has(userId)) {
        continue;
      }
      this.injectedUserIds.add(userId);
      changed = true;
      try {
        const data = await this.app.getMemoryScope('user', userId);
        const parts: string[] = [];
        if (data.summary) {
          parts.push(`Summary: ${(data.summary as { text: string }).text}`);
        }
        for (const fact of data.facts) {
          parts.push(`- ${fact.text}`);
        }
        if (parts.length > 0) {
          const info = await this.app.getMemberInfo(conversationId, userId);
          const label = info?.displayName ?? info?.username ?? userId;
          sections.push(`## Memory about ${label} (${userId})\n${parts.join('\n')}`);
        }
      } catch {
        // Graceful
      }
    }

    if (sections.length > 0) {
      const contextPrompt = `# Additional context loaded for this conversation\n\n${sections.join('\n\n')}`;
      await collectAgentMessage(session.prompt(contextPrompt, conversationId));
      log.debug(
        `${this.logTag} Injected memory context for conversation ${conversationId} (${sections.length} sections)`,
      );
    }

    if (changed) {
      this.app.persistSharedInjectionState([...this.injectedConversationIds], [...this.injectedUserIds]);
    }
  }

  // ---------------------------------------------------------------------------
  // Rotation
  // ---------------------------------------------------------------------------

  async rotateSession(type: SessionType, externalReferenceId: string): Promise<void> {
    const slot = this.getSlot(type, externalReferenceId);
    if (!slot?.session) {
      return;
    }
    log.info(`${this.logTag} Rotating session in-place for ${slot.type}:${slot.externalReferenceId}`);

    const oldSession = slot.session;
    let handoffNote: string | undefined;

    // Conversation-bearing sessions (chat + focused work sessions) produce a handoff on rotation.
    if (slot.type === 'conversation') {
      try {
        const fullOutput = await collectAgentMessage(
          oldSession.prompt(this.promptManager.buildSessionEndPrompt(oldSession.promptFormatterVersion)),
        );
        handoffNote = fullOutput
          ? this.promptManager.extractHandoff(oldSession.promptFormatterVersion, fullOutput)
          : undefined;
        if (handoffNote) {
          log.info(
            `${this.logTag} Captured handoff for ${slot.type}:${slot.externalReferenceId} (${handoffNote.length} chars)`,
          );
        }
      } catch (err: unknown) {
        log.warn(`${this.logTag} Session-end prompt failed for ${slot.type}:${slot.externalReferenceId}`, err);
      }
    }

    slot.session = undefined;
    await this.endSession(oldSession.correlationId);
    if (slot.role === 'chat') {
      this.injectedConversationIds.clear();
      this.injectedUserIds.clear();
    }

    // Rotation needs a fresh context window — disable resume; the create path overwrites the mapping.
    try {
      const newSession = await this.enqueueLaunch(slot.type, slot.externalReferenceId, slot.role, {
        resume: false,
        handoffNote,
      });
      slot.session = newSession;
      log.info(
        `${this.logTag} Session rotated: ${slot.type}:${slot.externalReferenceId} → ${newSession.correlationId}`,
      );
    } catch (err: unknown) {
      log.error(
        `${this.logTag} Failed to launch replacement session for ${slot.type}:${slot.externalReferenceId}`,
        err,
      );
      if (handoffNote) {
        this.app
          .putHandoffNote(slot.externalReferenceId, handoffNote)
          .catch((e: unknown) => log.warn(`${this.logTag} Failed to persist handoff note`, e));
      }
      slot.queue.close();
      this.removeSlot(slot);
    }
  }

  // ---------------------------------------------------------------------------
  // Owner-initiated operations
  // ---------------------------------------------------------------------------

  async handleStartSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    if (request.sessionType !== 'conversation') {
      return { success: false, error: 'Can only start conversation session ondemand' };
    }
    const slot =
      request.externalReferenceId === SHARED_SESSION_ID
        ? this.getOrCreateChatSlot()
        : this.getOrCreateConversationSlot(request.externalReferenceId);
    try {
      await slot.sessionPromise;
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Session launch failed' };
    }
    if (!slot.session) {
      return { success: false, error: 'Session launch failed' };
    }
    return { success: true, info: slot.session.getLiveSessionInfo() };
  }

  async handleUpdateMemory(request: UpdateMemoryRequest): Promise<UpdateMemoryResponse> {
    const slot = this.getSlot(request.sessionType, request.externalReferenceId);
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

  async handleRotateSession(request: RotateSessionRequest): Promise<RotateSessionResponse> {
    if (request.sessionType !== 'conversation') {
      return { success: false, errorCode: 'invalid_session_type', error: 'Can only rotate conversation sessions' };
    }
    const slot = this.getSlot(request.sessionType, request.externalReferenceId);
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

  getLiveSessionInfo(request: LiveSessionInfoRequest): LiveSessionInfoResponse {
    const slot = this.getSlot(request.sessionType, request.externalReferenceId);
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

  async handleCancelSession(request: CancelSessionRequest): Promise<CancelSessionResponse> {
    const slot = this.getSlot(request.sessionType, request.externalReferenceId);
    if (!slot?.session) {
      return { success: false, errorCode: 'session_not_live', error: 'Session not found or not active' };
    }
    // The chat slot serves many conversations — only cancel if it's actively processing the target.
    if (slot === this.chatSlot) {
      if (!slot.inFlight) {
        return {
          success: false,
          errorCode: 'not_active_for_conversation',
          error: 'Session is idle — not processing any conversation',
        };
      }
      if (slot.session.currentConversationId !== request.externalReferenceId) {
        return {
          success: false,
          errorCode: 'not_active_for_conversation',
          error: 'Session is processing a different conversation',
        };
      }
    }
    const result = await slot.session.handleCancelSession();
    slot.queue.reset();
    return result;
  }

  async handleCompactSession(request: CompactSessionRequest): Promise<CompactSessionResponse> {
    const slot = this.getSlot(request.sessionType, request.externalReferenceId);
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

  async applySessionConfigUpdate(request: ApplySessionConfigUpdateRequest): Promise<void> {
    const slot = this.getSlot(request.sessionType, request.externalReferenceId);
    if (!slot?.session) {
      log.debug(
        `${this.logTag} acpModel/acpMode change for ${request.sessionType}/${request.externalReferenceId} — session not active, ignoring`,
      );
      return;
    }
    await slot.session.applySessionConfig(request.updates);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  startIdleCleanup(): void {
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
      const timeout = DEFAULT_SESSION_IDLE_TIMEOUT_MS;
      const now = Date.now();

      if (this.chatSlot?.session && now - this.chatSlot.lastActivityAt > timeout && !this.chatSlot.inFlight) {
        log.info(`${this.logTag} Idle session cleanup: chat session`);
        await this.stopSession(this.chatSlot);
      }

      for (const [conversationId, slot] of this.conversationSlots) {
        if (now - slot.lastActivityAt > timeout && slot.session && !slot.inFlight) {
          log.info(`${this.logTag} Idle session cleanup: work session ${conversationId}`);
          await this.stopSession(slot);
        }
      }

      for (const [cronId, slot] of this.cronSlots) {
        if (now - slot.lastActivityAt > timeout && slot.session && !slot.inFlight) {
          log.info(`${this.logTag} Idle session cleanup: cron ${cronId}`);
          await this.stopSession(slot);
        }
      }
    } finally {
      this.cleaningUpIdleSessions = false;
    }
  }

  /**
   * End a session on idle: persist durable facts (memory-update prompt, for conversation-bearing
   * sessions), then close. No handoff — the stored mapping is retained so the next event resumes
   * with context intact.
   */
  private async stopSession(slot: SessionSlot): Promise<void> {
    const session = slot.session;
    if (!session) {
      slot.queue.close();
      this.removeSlot(slot);
      return;
    }

    if (slot.type === 'conversation') {
      try {
        await collectAgentMessage(
          session.prompt(this.promptManager.buildMemoryUpdatePrompt(session.promptFormatterVersion)),
        );
      } catch (err: unknown) {
        log.warn(`${this.logTag} Memory-update prompt failed for ${slot.type}:${slot.externalReferenceId}`, err);
      }
    }

    slot.queue.close();
    await this.endSession(session.correlationId);
    this.removeSlot(slot);
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    this.injectedConversationIds.clear();
    this.injectedUserIds.clear();

    if (this.chatSlot) {
      log.debug(`${this.logTag} Disposing chat slot`);
      this.chatSlot.queue.close();
      if (this.chatSlot.session) {
        await this.endSession(this.chatSlot.session.correlationId);
      }
      this.chatSlot = undefined;
    }

    for (const [id, slot] of this.conversationSlots) {
      log.debug(`${this.logTag} Disposing work-session slot: ${id}`);
      slot.queue.close();
      if (slot.session) {
        await this.endSession(slot.session.correlationId);
      }
    }
    this.conversationSlots.clear();

    for (const [id, slot] of this.cronSlots) {
      log.debug(`${this.logTag} Disposing cron slot: ${id}`);
      slot.queue.close();
      if (slot.session) {
        await this.endSession(slot.session.correlationId);
      }
    }
    this.cronSlots.clear();
  }
}

/**
 * The conversation whose persisted acpModel/acpMode config a freshly-launched session should adopt:
 * - chat slot → the owner DM member record.
 * - focused work-session conversation → its own conversation.
 * - cron (and the SHARED_SESSION_ID placeholder) → none.
 */
function slotConfigSource(
  type: SessionType,
  externalReferenceId: string,
  role: SessionPromptRole,
  ownerDmConversationId: string,
): string | undefined {
  if (role === 'chat') {
    return ownerDmConversationId;
  }
  if (type === 'conversation' && externalReferenceId !== SHARED_SESSION_ID) {
    return externalReferenceId;
  }
  return undefined;
}
