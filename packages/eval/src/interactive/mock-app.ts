/* eslint-disable @typescript-eslint/require-await */
/**
 * InteractiveMockNewioApp — implements NewioAppForAgent for the interactive eval.
 *
 * Extends the existing MockNewioApp (which implements NewioAppForMcp) and adds
 * all the additional methods required by BaseAgentInstance:
 * - Lifecycle (init, dispose, onDisconnect)
 * - Event system (on)
 * - Capability signal handlers
 * - Conversation cache methods
 * - Memory loading
 * - Backend reporting (no-ops)
 *
 * Also provides triggerRotateSession/triggerUpdateMemory that route to the
 * session manager once wired.
 */
import type {
  ActionRequest,
  ActionResponse,
  ActivityStatus,
  LoadSessionMemoryResponse,
  MemoryScopeData,
  ReportAgentInfoRequest,
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
  AppEventHandlers,
} from '@newio/agent-sdk';
import type { NewioAppForAgent, SessionType } from '@newio/agent-engine';
import { MockNewioApp, dmConversationId } from '../mock-environment.js';
import type { MockNewioAppOptions } from '../mock-environment.js';
import type { NewioAppForDriverMcp } from './types.js';

type SignalHandler<Req, Res> = (request: Req) => Res | Promise<Res>;

export interface InteractiveMockAppOptions extends MockNewioAppOptions {
  readonly initialMemory?: LoadSessionMemoryResponse;
}

/**
 * Full mock implementing both NewioAppForAgent (for the target agent instance)
 * and NewioAppForDriverMcp (for the driver MCP server).
 */
export class InteractiveMockNewioApp extends MockNewioApp implements NewioAppForAgent, NewioAppForDriverMcp {
  private readonly eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  private disconnectHandler?: () => void;
  private liveSessionInfoHandler?: SignalHandler<LiveSessionInfoRequest, LiveSessionInfoResponse>;
  private cancelSessionHandler?: SignalHandler<CancelSessionRequest, CancelSessionResponse>;
  private compactSessionHandler?: SignalHandler<CompactSessionRequest, CompactSessionResponse>;
  private startSessionHandler?: SignalHandler<StartSessionRequest, StartSessionResponse>;
  private updateMemoryHandler?: SignalHandler<UpdateMemoryRequest, UpdateMemoryResponse>;
  private rotateSessionHandler?: SignalHandler<RotateSessionRequest, RotateSessionResponse>;
  private readonly handoffNotes = new Map<string, string>();
  private readonly _initialMemory?: LoadSessionMemoryResponse;

  constructor(opts: InteractiveMockAppOptions) {
    super(opts);
    this._initialMemory = opts.initialMemory;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    // No-op for eval — mock is already initialized
  }

  dispose(): void {
    // No-op
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  on<K extends keyof AppEventHandlers>(event: K, handler: AppEventHandlers[K]): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler as (...args: unknown[]) => void);
    this.eventHandlers.set(event, handlers);
  }

  onMessageNew(handler: AppEventHandlers['message.new']): void {
    this.on('message.new', handler);
  }
  onMessageUpdated(handler: AppEventHandlers['message.updated']): void {
    this.on('message.updated', handler);
  }
  onMessageDeleted(handler: AppEventHandlers['message.deleted']): void {
    this.on('message.deleted', handler);
  }
  onContactEvent(handler: AppEventHandlers['contact.event']): void {
    this.on('contact.event', handler);
  }
  onCronTriggered(handler: AppEventHandlers['cron.triggered']): void {
    this.on('cron.triggered', handler);
  }
  onCronScheduled(handler: AppEventHandlers['cron.scheduled']): void {
    this.on('cron.scheduled', handler);
  }
  onCronCancelled(handler: AppEventHandlers['cron.cancelled']): void {
    this.on('cron.cancelled', handler);
  }
  onConversationMemberUpdated(handler: AppEventHandlers['conversation.member_updated']): void {
    this.on('conversation.member_updated', handler);
  }
  onSessionUpdated(handler: AppEventHandlers['session.updated']): void {
    this.on('session.updated', handler);
  }

  /** Emit an event to registered handlers. Used by the driver to inject messages. */
  emit<K extends keyof AppEventHandlers>(event: K, ...args: Parameters<AppEventHandlers[K]>): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(...args);
      }
    }
  }

  // ── Capability signal handlers ─────────────────────────────────────────────

  onLiveSessionInfo(handler: SignalHandler<LiveSessionInfoRequest, LiveSessionInfoResponse>): void {
    this.liveSessionInfoHandler = handler;
  }

  onCancelSession(handler: SignalHandler<CancelSessionRequest, CancelSessionResponse>): void {
    this.cancelSessionHandler = handler;
  }

  onCompactSession(handler: SignalHandler<CompactSessionRequest, CompactSessionResponse>): void {
    this.compactSessionHandler = handler;
  }

  onStartSession(handler: SignalHandler<StartSessionRequest, StartSessionResponse>): void {
    this.startSessionHandler = handler;
  }

  onUpdateMemory(handler: SignalHandler<UpdateMemoryRequest, UpdateMemoryResponse>): void {
    this.updateMemoryHandler = handler;
  }

  onRotateSession(handler: SignalHandler<RotateSessionRequest, RotateSessionResponse>): void {
    this.rotateSessionHandler = handler;
  }

  // ── Messaging extensions (NewioAppForAgent) ────────────────────────────────

  async sendActionRequest(
    _conversationId: string,
    _action: ActionRequest,
    _text?: string,
    _visibleTo?: readonly string[],
  ): Promise<ActionResponse> {
    // Auto-approve all permission requests in eval
    return { requestId: 'eval', selectedOptionId: 'allow' };
  }

  setStatus(_status: ActivityStatus, _conversationId?: string): void {
    // No-op in eval
  }

  // ── Identity & owner ───────────────────────────────────────────────────────

  async getOrCreateOwnerDmConversationId(): Promise<string> {
    const ownerInfo = this.getOwnerInfo();
    return dmConversationId(ownerInfo.username);
  }

  // ── Conversations (cache methods) ──────────────────────────────────────────

  getCachedConversationInfo(conversationId: string): { type: string; name?: string } | undefined {
    // Use the sync listConversations to find it
    const result = this.listConversations(100);
    const conv = result.conversations.find((c) => c.conversationId === conversationId);
    if (!conv) {
      return undefined;
    }
    return { type: conv.type, ...(conv.name ? { name: conv.name } : {}) };
  }

  isConversationMember(conversationId: string, userId: string): boolean {
    // Sync check using listConversationMembers (we'll resolve it synchronously since mock is sync)
    const info = this.getCachedConversationInfo(conversationId);
    if (!info) {
      return false;
    }
    // Check by iterating members — use the internal conversation data
    // We need to use checkIsMember but it's async. For eval, resolve by userId lookup.
    return this.isConversationMemberByUserId(conversationId, userId);
  }

  /** Sync member check by userId (for eval use). */
  private isConversationMemberByUserId(conversationId: string, userId: string): boolean {
    // Access internal conversations via the public API
    // We'll use a workaround: check if the userId matches any known user
    const conversations = (this as unknown as { conversations: Map<string, { members: Array<{ userId: string }> }> })
      .conversations;
    const conv = conversations.get(conversationId);
    return conv?.members.some((m) => m.userId === userId) ?? false;
  }

  getConversationMemberIds(conversationId: string): readonly string[] | undefined {
    const conversations = (this as unknown as { conversations: Map<string, { members: Array<{ userId: string }> }> })
      .conversations;
    const conv = conversations.get(conversationId);
    return conv?.members.map((m) => m.userId);
  }

  getMemberDisplayInfo(
    conversationId: string,
    userId: string,
  ): { username?: string; displayName?: string } | undefined {
    const conversations = (
      this as unknown as {
        conversations: Map<string, { members: Array<{ userId: string; username: string; displayName: string }> }>;
      }
    ).conversations;
    const conv = conversations.get(conversationId);
    const member = conv?.members.find((m) => m.userId === userId);
    if (!member) {
      return undefined;
    }
    return { username: member.username, displayName: member.displayName };
  }

  getSessionConfig(_conversationId: string): { acpModel?: string; acpMode?: string } | undefined {
    return undefined;
  }

  // ── Memory ─────────────────────────────────────────────────────────────────

  async loadSessionMemory(
    _conversationId?: string,
    _participantIds?: readonly string[],
  ): Promise<LoadSessionMemoryResponse> {
    return (
      this._initialMemory ?? {
        global: { summary: null, facts: [] },
        participants: {},
        conversation: { summary: null, facts: [] },
        topUsers: [],
        topConversations: [],
      }
    );
  }

  async getMemoryScope(_scope: string, _scopeId: string): Promise<MemoryScopeData> {
    return { summary: null, facts: [] };
  }

  async getHandoffNote(conversationId: string): Promise<string | null> {
    return this.handoffNotes.get(conversationId) ?? null;
  }

  async putHandoffNote(conversationId: string, text: string): Promise<void> {
    this.handoffNotes.set(conversationId, text);
  }

  // ── Backend reporting (no-ops) ─────────────────────────────────────────────

  async reportAgentInfo(_request: ReportAgentInfoRequest): Promise<void> {}

  async updateAgentMemberConfig(
    _conversationId: string,
    _config: { acpModel?: string | null; acpMode?: string | null },
  ): Promise<void> {}

  async sendContextWindowUpdate(
    _targetUserId: string,
    _sessionType: SessionType,
    _externalReferenceId: string,
    _contextWindowSize: number,
    _contextWindowUsed: number,
  ): Promise<void> {}

  // ── NewioAppForDriverMcp: triggerRotateSession / triggerUpdateMemory ────────

  async triggerRotateSession(conversationId: string): Promise<void> {
    if (this.rotateSessionHandler) {
      await this.rotateSessionHandler({ sessionType: 'conversation', externalReferenceId: conversationId });
    }
  }

  async triggerUpdateMemory(conversationId: string): Promise<void> {
    if (this.updateMemoryHandler) {
      await this.updateMemoryHandler({ sessionType: 'conversation', externalReferenceId: conversationId });
    }
  }
}
