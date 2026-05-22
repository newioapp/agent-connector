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
import { AgentEvent, EventQueue } from './event-queue';
import { AgentSession } from './agent-session';
import { PromptManager } from './prompt-manager';
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

const log = getLogger('shared-session-manager');

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

export class SharedSessionManager implements SessionManager {
  private sharedSessionSlot: SessionSlot | undefined;
  /** Tracks which conversation scopes have already been injected into the shared session. */
  private readonly injectedConversationIds = new Set<string>();
  /** Tracks which user scopes have already been injected into the shared session. */
  private readonly injectedUserIds = new Set<string>();
  /** Serializes session launches so only one runs at a time (protects latestMcpServer wiring). */
  private launchQueue: Promise<void> = Promise.resolve();
  private idleTimer?: ReturnType<typeof setInterval>;
  private cleaningUpIdleSessions = false;

  constructor(
    private readonly logTag: string,
    private readonly eventProcessor: SessionEventProcessor,
    private readonly newSession: (sessionType: SessionType, externalReferenceId: string) => Promise<AgentSession>,
    private readonly endSession: (correlationId: string) => Promise<void>,
    private readonly promptManager: PromptManager,
    private readonly app: NewioAppForSession,
  ) {}

  getDmSession(_convId: string): Promise<AgentSession> {
    const slot = this.getOrCreateSharedSessionSlot();
    return slot.sessionPromise;
  }

  routeInboundEvent(event: InboundEvent): void {
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
      default: {
        throw new Error(`Unsupported InboundEvent: ${event.type}`);
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
        // Inject per-conversation/per-user memory on first encounter
        if (event.type === 'messages') {
          await this.injectConversationContextIfNeeded(event.conversationId, session);
        }
        await this.eventProcessor.processEvent(event, session);
      } finally {
        slot.inFlight = null;
      }
    }
    log.debug(`${this.logTag} Session loop ended`);
  }

  /**
   * Inject conversation and participant memory into the shared session the first time
   * we process messages for a given conversation. Subsequent messages for the same
   * conversation (and already-seen participants) skip fetching.
   */
  private async injectConversationContextIfNeeded(conversationId: string, session: AgentSession): Promise<void> {
    const agentId = this.app.agentUserId;
    const sections: string[] = [];

    // Per-conversation memory
    if (!this.injectedConversationIds.has(conversationId)) {
      this.injectedConversationIds.add(conversationId);
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

    // Per-user memory for unseen participants
    const memberIds = this.app.getConversationMemberIds(conversationId);
    if (memberIds) {
      for (const userId of memberIds) {
        if (userId === agentId || this.injectedUserIds.has(userId)) {
          continue;
        }
        this.injectedUserIds.add(userId);
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
            const info = this.app.getMemberDisplayInfo(conversationId, userId);
            const label = info?.displayName ?? info?.username ?? userId;
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
    const session = await this.newSession(SESSION_TYPE, EXTERNAL_REFERENCE_ID);

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
      this.app.handlePermissionRequest(title, options, conversationId),
    );

    // Wire context pressure — triggers session rotation
    session.onContextPressure(() => {
      void this.rotateSession();
    });

    log.info(`${this.logTag} Shared Session ready`);

    // todo: appy session config.

    return session;
  }

  private async provideContext(session: AgentSession, handoffNote?: string): Promise<void> {
    log.info(`${this.logTag} Preparing memory`);
    const instruction = this.promptManager.buildNewioInstruction(session.promptFormatterVersion);

    // Load memory for conversation sessions
    const memory = await this.app.loadMemoryForSession();
    // Use provided handoff note (in-memory from rotation) or fetch from backend
    let resolvedHandoff: string | null = handoffNote ?? null;
    if (!resolvedHandoff) {
      resolvedHandoff = await this.app.getHandoffNote(EXTERNAL_REFERENCE_ID);
    }

    const memoryContext = this.promptManager.formatMemoryContext(
      instruction.version,
      memory,
      resolvedHandoff ?? undefined,
    );
    const fullInstruction = memoryContext ? `${instruction.prompt}\n\n${memoryContext}` : instruction.prompt;

    await collectAgentMessage(session.prompt(fullInstruction));
  }

  async rotateSession(_sessionType?: SessionType, _externalReferenceId?: string): Promise<void> {
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
    await this.endSession(oldSession.correlationId);
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
        this.app
          .putHandoffNote(EXTERNAL_REFERENCE_ID, handoffNote)
          .catch((e: unknown) => log.warn(`${this.logTag} Failed to persist handoff note`, e));
      }
      slot.queue.close();
      this.sharedSessionSlot = undefined;
    }
  }
  /** Get live session info for a session. */
  getLiveSessionInfo(request: LiveSessionInfoRequest): LiveSessionInfoResponse {
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
  async handleCancelSession(_request: CancelSessionRequest): Promise<CancelSessionResponse> {
    const slot = this.sharedSessionSlot;
    if (!slot?.session) {
      return { success: false, errorCode: 'session_not_live', error: 'Session not found or not active' };
    }
    const result = await slot.session.handleCancelSession();
    slot.queue.reset();
    return result;
  }

  /** Handle compact session signal. */
  async handleCompactSession(_request: CompactSessionRequest): Promise<CompactSessionResponse> {
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
  async handleStartSession(request: StartSessionRequest): Promise<StartSessionResponse> {
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
  async handleUpdateMemory(_request: UpdateMemoryRequest): Promise<UpdateMemoryResponse> {
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
  async handleRotateSession(request: RotateSessionRequest): Promise<RotateSessionResponse> {
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

  async applySessionConfigUpdate(request: ApplySessionConfigUpdateRequest): Promise<void> {
    const slot = this.sharedSessionSlot;
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

    this.injectedConversationIds.clear();
    this.injectedUserIds.clear();

    if (this.sharedSessionSlot) {
      log.debug(`${this.logTag} Disposing shared session slot`);
      this.sharedSessionSlot.queue.close();
      if (this.sharedSessionSlot.session) {
        await this.endSession(this.sharedSessionSlot.session.correlationId);
      }
      this.sharedSessionSlot = undefined;
    }
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

      // Shared session slot
      if (
        this.sharedSessionSlot?.session &&
        now - this.sharedSessionSlot.lastActivityAt > timeout &&
        !this.sharedSessionSlot.inFlight
      ) {
        log.info(`${this.logTag} Idle session cleanup: shared session`);
        await this.stopSession(this.sharedSessionSlot);
      }
    } finally {
      this.cleaningUpIdleSessions = false;
    }
  }

  private async stopSession(slot: SessionSlot): Promise<void> {
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
        await this.app.putHandoffNote(EXTERNAL_REFERENCE_ID, summary);
        log.info(`${this.logTag} Captured handoff shared session (${summary.length} chars)`);
      }
    } catch (err: unknown) {
      log.warn(`${this.logTag} Session-end prompt failed for shared session`, err);
    }

    slot.queue.close();
    await this.endSession(session.correlationId);
    this.sharedSessionSlot = undefined;
  }
}
