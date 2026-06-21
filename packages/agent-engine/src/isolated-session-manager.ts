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
  StartSessionRequest,
  StartSessionResponse,
  UpdateMemoryRequest,
  UpdateMemoryResponse,
} from '@newio/agent-sdk';
import { AgentSession } from './agent-session';
import { AgentEvent, EventQueue } from './event-queue';
import {
  ApplySessionConfigUpdateRequest,
  SessionEventProcessor,
  InboundEvent,
  NewioAppForSession,
  SessionManager,
  SessionType,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
} from './types';
import { collectAgentMessage } from './utils';
import { PromptManager } from './prompt-manager';

interface SessionSlot {
  readonly type: SessionType;
  /** ConversationId, __contact__, cron id job */
  readonly externalReferenceId: string;
  readonly queue: EventQueue;
  session: AgentSession | undefined;
  readonly sessionPromise: Promise<AgentSession>;
  lastActivityAt: number;
  /** Non-null while the session loop is processing any event. */
  inFlight: AgentEvent['type'] | null;
}

const log = getLogger('isolated-session-manager');

/**
 * EXPERIMENTAL — not yet exposed via the CLI and not wired into any released
 * configuration. The isolated session model runs a dedicated agent session per
 * scope (one per conversation, plus dedicated contact and cron sessions), as an
 * alternative to the shipped chat-shared model ({@link ChatSharedSessionManager}).
 * Kept for ongoing experimentation; the API and behavior may change or be removed.
 */
export class IsolatedSessionManager implements SessionManager {
  /** conversationId → session slot for conversation sessions. */
  private readonly conversationSlots = new Map<string, SessionSlot>();
  /** Dedicated session slot for contact events. */
  private contactSlot: SessionSlot | undefined;
  /** cronId → session slot for cron job sessions. */
  private readonly cronSlots = new Map<string, SessionSlot>();
  private launchQueue: Promise<void> = Promise.resolve();
  private idleTimer?: ReturnType<typeof setInterval>;
  private cleaningUpIdleSessions = false;

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
  ) {}

  getDmSession(convId: string): Promise<AgentSession> {
    const slot = this.getOrCreateConversationSlot(convId);
    return slot.sessionPromise;
  }

  routeInboundEvent(event: InboundEvent): void {
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
      case 'initiate_conversation': {
        const slot = this.getOrCreateConversationSlot(event.conversationId);
        slot.queue.enqueueInitiatingConversation(event.conversationId, event.context);
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
    const slot = this.createSlot('conversation', conversationId);
    this.conversationSlots.set(conversationId, slot);
    return slot;
  }

  /** Get or create the dedicated contact event session slot. */
  private getOrCreateContactSlot(): SessionSlot {
    if (this.contactSlot) {
      this.contactSlot.lastActivityAt = Date.now();
      return this.contactSlot;
    }
    const slot = this.createSlot('contact', '__contact__');
    this.contactSlot = slot;
    return slot;
  }

  /** Get or create a SessionSlot for a cron job. */
  private getOrCreateCronSlot(cronId: string): SessionSlot {
    const existing = this.cronSlots.get(cronId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }
    const slot = this.createSlot('cron', cronId);
    this.cronSlots.set(cronId, slot);
    return slot;
  }

  /** Create a new session slot — shared logic for all slot types. */
  private createSlot(type: SessionType, externalReferenceId: string): SessionSlot {
    const queue = new EventQueue(type, externalReferenceId);
    const sessionPromise = this.enqueueLaunch(type, externalReferenceId);

    const slot: SessionSlot = {
      type,
      externalReferenceId,
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

  /** Remove a slot from its owning collection. */
  private removeSlot(slot: SessionSlot): void {
    switch (slot.type) {
      case 'conversation':
        this.conversationSlots.delete(slot.externalReferenceId);
        break;
      case 'contact':
        this.contactSlot = undefined;
        break;
      case 'cron':
        this.cronSlots.delete(slot.externalReferenceId);
        break;
    }
  }

  private getSlot(type: SessionType, externalReferenceId: string): SessionSlot | undefined {
    switch (type) {
      case 'conversation':
        return this.conversationSlots.get(externalReferenceId);
      case 'contact':
        return this.contactSlot;
      case 'cron':
        return this.cronSlots.get(externalReferenceId);
    }
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
        await this.eventProcessor.processEvent(event, session);
      } catch (err: unknown) {
        // A single event must never tear down the loop — that would silently drop
        // every subsequent message for this slot until idle cleanup recreates it.
        log.error(
          `${this.logTag} Event ${event.type} failed for ${slot.type}:${slot.externalReferenceId}; session loop continues`,
          err,
        );
      } finally {
        slot.inFlight = null;
      }
    }
    log.debug(`${this.logTag} Session loop ended: ${slot.type}:${slot.externalReferenceId}`);
  }

  /**
   * Enqueue a session launch so only one runs at a time. Each launch holds until
   * its MCP bridge connection has been wired (see BaseAgentInstance.launchSession),
   * so the connection that arrives unambiguously belongs to the launch that
   * triggered it — even for agents that connect after `newSession` returns.
   */
  private enqueueLaunch(
    type: SessionType,
    externalReferenceId: string,
    opts: { resume?: boolean; handoffNote?: string } = {},
  ): Promise<AgentSession> {
    const launch = this.launchQueue.then(() => this.launchSession(type, externalReferenceId, opts));
    this.launchQueue = launch.then(
      () => {},
      (err: unknown) => {
        log.error(`${this.logTag} Session launch failed for ${type} ${externalReferenceId}`, err);
      },
    );
    return launch;
  }

  /**
   * Launch a session — resumes the prior session when `opts.resume` is set
   * (default), else creates fresh. Wires MCP and status hooks. A resumed session
   * already holds its instruction + memory, so context injection is skipped.
   */
  private async launchSession(
    type: SessionType,
    externalReferenceId: string,
    opts: { resume?: boolean; handoffNote?: string } = {},
  ): Promise<AgentSession> {
    const session = await this.newSession(type, externalReferenceId, opts.resume ?? true);

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
      this.app.handlePermissionRequest(title, options, conversationId),
    );

    // Wire context pressure — triggers session rotation
    session.onContextPressure(() => {
      void this.rotateSession(type, externalReferenceId);
    });

    log.info(`${this.logTag} Session ready: key=${type}/${externalReferenceId} → correlation=${session.correlationId}`);

    // Apply persisted acpModel/acpMode from the backend (conversation sessions
    // only) BEFORE providing context. Awaited — and not fire-and-forget — and
    // ahead of provideContext, which issues the session's first prompt: that
    // prompt (and the later greeting connection test) must run with the
    // configured model/mode already in effect, not race a pending change.
    await this.applyPersistedSessionConfig(type, externalReferenceId, session);

    // A resumed session already holds its instruction + memory + prior turns;
    // only fresh sessions need context injected.
    if (session.resumed) {
      log.info(`${this.logTag} Resumed session ${type}/${externalReferenceId} — skipping context injection`);
    } else {
      await this.provideContext(session, opts.handoffNote);
    }

    return session;
  }

  private async applyPersistedSessionConfig(
    type: SessionType,
    externalReferenceId: string,
    session: AgentSession,
  ): Promise<void> {
    if (type !== 'conversation') {
      return;
    }
    try {
      const config = await this.app.getConversationControls(externalReferenceId);
      if (config) {
        await session.applySessionConfig({ acpModel: config.acpModel, acpMode: config.acpMode });
      }
    } catch (err: unknown) {
      log.warn(`${this.logTag} Failed to apply persisted session config for ${type}/${externalReferenceId}`, err);
    }
  }

  async rotateSession(type: SessionType, externalReferenceId: string): Promise<void> {
    log.info(`${this.logTag} Rotating session in-place for ${type}:${externalReferenceId}`);
    const slot = this.getSlot(type, externalReferenceId);
    if (!slot?.session) {
      return;
    }

    const oldSession = slot.session;
    let handoffNote: string | undefined;

    // For conversation sessions, run session-end prompt to capture handoff
    if (type === 'conversation') {
      try {
        const fullOutput = await collectAgentMessage(
          oldSession.prompt(this.promptManager.buildSessionEndPrompt(oldSession.promptFormatterVersion)),
        );
        handoffNote = fullOutput
          ? this.promptManager.extractHandoff(oldSession.promptFormatterVersion, fullOutput)
          : undefined;
        if (handoffNote) {
          log.info(`${this.logTag} Captured handoff for ${type}:${externalReferenceId} (${handoffNote.length} chars)`);
        }
      } catch (err: unknown) {
        log.warn(`${this.logTag} Session-end prompt failed for ${type}:${externalReferenceId}`, err);
      }
    }

    // End old session
    slot.session = undefined;
    await this.endSession(oldSession.correlationId);

    // Rotation needs a fresh context window, so disable resume; the create path
    // overwrites the stored mapping with the new correlationId.
    try {
      const newSession = await this.enqueueLaunch(type, externalReferenceId, { resume: false, handoffNote });
      slot.session = newSession;
      log.info(`${this.logTag} Session rotated: ${type}:${externalReferenceId} → ${newSession.correlationId}`);
    } catch (err: unknown) {
      log.error(`${this.logTag} Failed to launch replacement session for ${type}:${externalReferenceId}`, err);
      // Persist handoff so the self-recovery path can load it from backend
      if (handoffNote) {
        this.app
          .putHandoffNote(externalReferenceId, handoffNote)
          .catch((e: unknown) => log.warn(`${this.logTag} Failed to persist handoff note`, e));
      }
      slot.queue.close();
      this.removeSlot(slot);
    }
  }

  private async provideContext(session: AgentSession, handoffNote?: string): Promise<void> {
    log.info(`${this.logTag} Preparing memory`);
    const instruction = this.promptManager.buildNewioInstruction(session.promptFormatterVersion);

    // Load memory for conversation sessions
    const memory = await this.app.loadMemoryForSession(
      session.type === 'conversation' ? session.externalReferenceId : undefined,
    );
    // Use provided handoff note (in-memory from rotation) or fetch from backend
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

  /** Handle start session signal. Launches the session if not already running. */
  async handleStartSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    if (request.sessionType !== 'conversation') {
      return { success: false, error: 'Can only start conversation session ondemand' };
    }
    const slot = this.getOrCreateConversationSlot(request.externalReferenceId);
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

  /** Handle rotate_session signal — end current session (with handoff note), next event starts fresh. */
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

  /** Get live session info for a session. */
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
    const info = slot.session.getLiveSessionInfo();
    // Isolated mode is one session per conversation, so config lives on that conversation itself.
    return info.sessionType === 'conversation'
      ? { ...info, sessionReference: { sessionType: 'conversation', externalReferenceId: info.externalReferenceId } }
      : info;
  }

  /** Handle cancel session signal. */
  async handleCancelSession(request: CancelSessionRequest): Promise<CancelSessionResponse> {
    const slot = this.getSlot(request.sessionType, request.externalReferenceId);
    if (!slot?.session) {
      return { success: false, errorCode: 'session_not_live', error: 'Session not found or not active' };
    }
    const result = await slot.session.handleCancelSession();
    slot.queue.reset();
    return result;
  }

  /** Handle compact session signal. */
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

  /** Apply acpModel/acpMode changes from conversation.member_updated to the live session. */
  async applySessionConfigUpdate(request: ApplySessionConfigUpdateRequest): Promise<void> {
    const slot = this.getSlot(request.sessionType, request.externalReferenceId);
    if (!slot?.session) {
      log.debug(
        `${this.logTag} acpModel/acpMode change for ${request.sessionType} / ${request.externalReferenceId} — session not active, ignoring`,
      );
      return;
    }
    await slot.session.applySessionConfig(request.updates);
  }

  async terminate(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    // Close all session slots
    for (const [id, slot] of this.conversationSlots) {
      log.debug(`${this.logTag} Disposing conversation slot: ${id}`);
      slot.queue.close();
      if (slot.session) {
        await this.endSession(slot.session.correlationId);
      }
    }
    this.conversationSlots.clear();

    if (this.contactSlot) {
      log.debug(`${this.logTag} Disposing contact slot`);
      this.contactSlot.queue.close();
      if (this.contactSlot.session) {
        await this.endSession(this.contactSlot.session.correlationId);
      }
      this.contactSlot = undefined;
    }

    for (const [id, slot] of this.cronSlots) {
      log.debug(`${this.logTag} Disposing cron slot: ${id}`);
      slot.queue.close();
      if (slot.session) {
        await this.endSession(slot.session.correlationId);
      }
    }
    this.cronSlots.clear();
  }

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

      // Conversation slots
      for (const [conversationId, slot] of this.conversationSlots) {
        if (now - slot.lastActivityAt > timeout && slot.session && !slot.inFlight) {
          log.info(
            `${this.logTag} Idle session cleanup: conversation ${conversationId} (idle ${Math.round((now - slot.lastActivityAt) / 1000)}s)`,
          );
          await this.stopSession(slot);
        }
      }

      // Contact slot
      if (this.contactSlot?.session && now - this.contactSlot.lastActivityAt > timeout && !this.contactSlot.inFlight) {
        log.info(`${this.logTag} Idle session cleanup: contact session`);
        await this.stopSession(this.contactSlot);
      }

      // Cron slots
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
   * End a session on idle: persist durable facts (memory-update prompt, for
   * conversation sessions), then close. No handoff is generated — the stored
   * mapping is retained so the next event resumes with context intact.
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
}
