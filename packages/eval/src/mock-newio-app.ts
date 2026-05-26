/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-non-null-assertion */
/**
 * MockNewioApp — Per-agent app implementing NewioAppForAgent + NewioAppForMcp.
 *
 * Each instance connects to a shared MockBackend with a specific agent identity.
 * Used by the agent-engine (BaseAgentInstance) as the Newio integration layer during eval.
 */
import type {
  ActionRequest,
  ActionResponse,
  ActivityStatus,
  AppEventHandlers,
  CancelSessionRequest,
  CancelSessionResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  ContactEvent,
  ContactEventHandler,
  ConversationMemberUpdatedHandler,
  CronScheduledHandler,
  CronCancelledHandler,
  CronTriggeredHandler,
  IncomingMessage,
  LiveSessionInfoRequest,
  LiveSessionInfoResponse,
  LoadSessionMemoryResponse,
  MemoryScopeData,
  MessageDeletedHandler,
  MessageNewHandler,
  MessageUpdatedHandler,
  ReportAgentInfoRequest,
  RotateSessionRequest,
  RotateSessionResponse,
  SenderRelationship,
  SessionUpdatedHandler,
  StartSessionRequest,
  StartSessionResponse,
  UpdateMemoryRequest,
  UpdateMemoryResponse,
} from '@newio/agent-sdk';
import type { NewioAppForAgent, SessionType } from '@newio/agent-engine';
import type { CronJobRow } from '@newio/agent-engine';
import type { NewioAppForMcp, McpContactSummary, McpMemoryData } from './mcp/v1/types.js';
import type { MockBackend, BackendEvent, BackendMemoryScope, BackendSignal } from './mock-backend.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockNewioAppOptions {
  readonly backend: MockBackend;
  readonly userId: string;
}

type SignalHandler<Req, Res> = (request: Req) => Res | Promise<Res>;

// ---------------------------------------------------------------------------
// MockNewioApp
// ---------------------------------------------------------------------------

export class MockNewioApp implements NewioAppForAgent, NewioAppForMcp {
  readonly identity: {
    readonly userId: string;
    readonly username: string;
    readonly displayName?: string;
    readonly avatarUrl?: string;
    readonly ownerId?: string;
  };

  private readonly backend: MockBackend;
  private readonly eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  private liveSessionInfoHandler?: SignalHandler<LiveSessionInfoRequest, LiveSessionInfoResponse>;
  private cancelSessionHandler?: SignalHandler<CancelSessionRequest, CancelSessionResponse>;
  private compactSessionHandler?: SignalHandler<CompactSessionRequest, CompactSessionResponse>;
  private startSessionHandler?: SignalHandler<StartSessionRequest, StartSessionResponse>;
  private updateMemoryHandler?: SignalHandler<UpdateMemoryRequest, UpdateMemoryResponse>;
  private rotateSessionHandler?: SignalHandler<RotateSessionRequest, RotateSessionResponse>;
  private readonly cronJobs = new Map<string, CronJobRow>();

  constructor(opts: MockNewioAppOptions) {
    const user = opts.backend.getUser(opts.userId);
    if (!user) {
      throw new Error(`User ${opts.userId} not found in backend`);
    }
    this.backend = opts.backend;
    this.identity = {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      ownerId: user.ownerId,
    };
    this.backend.registerListener(user.userId, (event) => this.handleBackendEvent(event));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {}
  dispose(): void {
    this.backend.unregisterListener(this.identity.userId);
  }
  onDisconnect(): void {}

  // ── Events ─────────────────────────────────────────────────────────────────

  private on<K extends keyof AppEventHandlers>(event: K, handler: AppEventHandlers[K]): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler as (...args: unknown[]) => void);
    this.eventHandlers.set(event, handlers);
  }

  onMessageNew(handler: MessageNewHandler): void {
    this.on('message.new', handler);
  }
  onMessageUpdated(handler: MessageUpdatedHandler): void {
    this.on('message.updated', handler);
  }
  onMessageDeleted(handler: MessageDeletedHandler): void {
    this.on('message.deleted', handler);
  }
  onContactEvent(handler: ContactEventHandler): void {
    this.on('contact.event', handler);
  }
  onCronTriggered(handler: CronTriggeredHandler): void {
    this.on('cron.triggered', handler);
  }
  onCronScheduled(handler: CronScheduledHandler): void {
    this.on('cron.scheduled', handler);
  }
  onCronCancelled(handler: CronCancelledHandler): void {
    this.on('cron.cancelled', handler);
  }
  onConversationMemberUpdated(handler: ConversationMemberUpdatedHandler): void {
    this.on('conversation.member_updated', handler);
  }
  onSessionUpdated(handler: SessionUpdatedHandler): void {
    this.on('session.updated', handler);
  }

  private emit<K extends keyof AppEventHandlers>(event: K, ...args: Parameters<AppEventHandlers[K]>): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(...args);
      }
    }
  }

  // ── Signal handlers ────────────────────────────────────────────────────────

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

  // ── Identity ───────────────────────────────────────────────────────────────

  getOwnerInfo(): { readonly username: string; readonly displayName: string } {
    if (!this.identity.ownerId) {
      throw new Error('Agent has no owner');
    }
    const owner = this.backend.getUser(this.identity.ownerId);
    if (!owner) {
      throw new Error('Owner not found in backend');
    }
    return { username: owner.username, displayName: owner.displayName };
  }

  // ── Contacts ───────────────────────────────────────────────────────────────

  getAllContacts(): McpContactSummary[] {
    return this.backend.getContacts(this.identity.userId).map((u) => ({
      username: u.username,
      displayName: u.displayName,
      accountType: u.accountType,
    }));
  }

  listIncomingFriendRequests(): readonly {
    username: string | undefined;
    displayName: string | undefined;
    accountType: string;
    note?: string;
  }[] {
    return this.backend.getIncomingFriendRequests(this.identity.userId).map((r) => ({
      username: r.user.username,
      displayName: r.user.displayName,
      accountType: r.user.accountType,
      note: r.note,
    }));
  }

  async sendFriendRequestByUsername(username: string, note?: string): Promise<void> {
    const target = this.resolveUser(username);
    this.backend.sendFriendRequest(this.identity.userId, target.userId, note);
  }

  async acceptFriendRequestByUsername(username: string): Promise<void> {
    const target = this.resolveUser(username);
    this.backend.acceptFriendRequest(this.identity.userId, target.userId);
  }

  async rejectFriendRequestByUsername(username: string): Promise<void> {
    const target = this.resolveUser(username);
    this.backend.rejectFriendRequest(this.identity.userId, target.userId);
  }

  async removeFriendByUsername(username: string): Promise<void> {
    const target = this.resolveUser(username);
    this.backend.removeFriend(this.identity.userId, target.userId);
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  listConversations(
    limit?: number,
    afterConversationId?: string,
  ): { conversations: { conversationId: string; type: string; name?: string }[]; hasMore: boolean } {
    const all = this.backend.getConversationsForUser(this.identity.userId);
    const pageSize = limit ?? 20;
    let startIdx = 0;
    if (afterConversationId) {
      const idx = all.findIndex((c) => c.conversationId === afterConversationId);
      if (idx >= 0) {
        startIdx = idx + 1;
      }
    }
    const page = all.slice(startIdx, startIdx + pageSize);
    return {
      conversations: page.map((c) => ({
        conversationId: c.conversationId,
        type: c.type,
        ...(c.name ? { name: c.name } : {}),
      })),
      hasMore: startIdx + pageSize < all.length,
    };
  }

  async getConversationInfo(
    conversationId: string,
  ): Promise<{ conversationId: string; type: string; name?: string; admins: readonly string[] }> {
    const conv = this.backend.getConversation(conversationId);
    if (!conv) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    const admins = conv.members
      .filter((m) => m.role === 'admin')
      .map((m) => this.backend.getUser(m.userId)?.username ?? m.userId);
    return { conversationId, type: conv.type, ...(conv.name ? { name: conv.name } : {}), admins };
  }

  async checkIsMember(conversationId: string, username: string): Promise<boolean> {
    const conv = this.backend.getConversation(conversationId);
    if (!conv) {
      return false;
    }
    const user = this.backend.getUserByUsername(username);
    return user ? conv.members.some((m) => m.userId === user.userId) : false;
  }

  async listConversationMembers(
    conversationId: string,
    limit?: number,
    afterUsername?: string,
  ): Promise<{
    members: { username: string; displayName: string; accountType: string; role: string }[];
    hasMore: boolean;
  }> {
    const conv = this.backend.getConversation(conversationId);
    const allMembers = (conv?.members ?? []).map((m) => {
      const u = this.backend.getUser(m.userId);
      return {
        username: u?.username ?? m.userId,
        displayName: u?.displayName ?? m.userId,
        accountType: u?.accountType ?? 'human',
        role: m.role,
      };
    });
    const pageSize = limit ?? 20;
    let startIdx = 0;
    if (afterUsername) {
      const idx = allMembers.findIndex((m) => m.username.toLowerCase() === afterUsername.toLowerCase());
      if (idx >= 0) {
        startIdx = idx + 1;
      }
    }
    const page = allMembers.slice(startIdx, startIdx + pageSize);
    return { members: page, hasMore: startIdx + pageSize < allMembers.length };
  }

  async getOrCreateDm(username: string): Promise<string> {
    const target = this.resolveUser(username);
    const existing = this.backend.findDm(this.identity.userId, target.userId);
    if (existing) {
      return existing.conversationId;
    }
    const conv = this.backend.createConversation({
      type: 'dm',
      memberUserIds: [this.identity.userId, target.userId],
      createdBy: this.identity.userId,
    });
    return conv.conversationId;
  }

  async createWorkSession(name: string, usernames: readonly string[]): Promise<string> {
    const memberIds = [this.identity.userId, ...this.resolveUsernames(usernames)];
    return this.backend.createConversation({
      type: 'temp_group',
      name,
      memberUserIds: memberIds,
      createdBy: this.identity.userId,
    }).conversationId;
  }

  async createGroup(name: string, usernames: readonly string[]): Promise<string> {
    const memberIds = [this.identity.userId, ...this.resolveUsernames(usernames)];
    return this.backend.createConversation({
      type: 'group',
      name,
      memberUserIds: memberIds,
      createdBy: this.identity.userId,
    }).conversationId;
  }

  async addMembersByUsername(conversationId: string, usernames: readonly string[]): Promise<void> {
    for (const username of usernames) {
      const user = this.backend.getUserByUsername(username);
      if (user) {
        this.backend.addMember(conversationId, user.userId, this.identity.userId);
      }
    }
  }

  async removeMemberByUsername(conversationId: string, username: string): Promise<void> {
    const user = this.backend.getUserByUsername(username);
    if (user) {
      this.backend.removeMember(conversationId, user.userId, this.identity.userId);
    }
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  async sendMessage(
    conversationId: string,
    text?: string,
    opts?: { filePaths?: readonly string[]; metadata?: Record<string, unknown>; visibleTo?: readonly string[] },
  ): Promise<void> {
    this.backend.sendMessage({
      conversationId,
      senderId: this.identity.userId,
      text: text ?? undefined,
      visibleTo: opts?.visibleTo,
    });
  }

  async sendDm(username: string, text: string, filePaths?: readonly string[]): Promise<void> {
    const convId = await this.getOrCreateDm(username);
    await this.sendMessage(convId, text, filePaths ? { filePaths } : undefined);
  }

  async sendActionRequest(
    _conversationId: string,
    _action: ActionRequest,
    _text?: string,
    _visibleTo?: readonly string[],
  ): Promise<ActionResponse> {
    return { requestId: 'eval', selectedOptionId: 'allow' };
  }

  setStatus(_status: ActivityStatus, _conversationId?: string): void {}

  async listMessages(
    conversationId: string,
    limit?: number,
    beforeMessageId?: string,
  ): Promise<{
    messages: {
      messageId: string;
      senderId: string;
      content: {
        text?: string;
        attachments?: { fileName: string; contentType: string; size: number; s3Key: string }[];
      };
      createdAt: string;
    }[];
  }> {
    const all = this.backend.getMessages(conversationId, this.identity.userId);
    let filtered = [...all].reverse();
    if (beforeMessageId) {
      const idx = filtered.findIndex((m) => m.messageId === beforeMessageId);
      if (idx >= 0) {
        filtered = filtered.slice(idx + 1);
      }
    }
    return { messages: filtered.slice(0, limit ?? 20) };
  }

  async downloadAttachment(_conversationId: string, _s3Key: string, fileName: string): Promise<string> {
    return `/tmp/newio-downloads/${fileName}`;
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  async getMe(): Promise<{
    userId: string;
    username: string;
    displayName: string;
    accountType: string;
    bio?: string;
    avatarUrl?: string;
    ownerId?: string;
  }> {
    const user = this.backend.getUser(this.identity.userId)!;
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      accountType: user.accountType,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      ownerId: user.ownerId,
    };
  }

  async searchUsers(query: string): Promise<{
    users: {
      userId: string;
      username: string;
      displayName: string;
      accountType: string;
      bio?: string;
      avatarUrl?: string;
    }[];
  }> {
    return { users: this.backend.searchUsers(query) };
  }

  async getUserByUsername(username: string): Promise<{
    userId: string;
    username: string;
    displayName: string;
    accountType: string;
    bio?: string;
    avatarUrl?: string;
  }> {
    return this.resolveUser(username);
  }

  // ── Cron ───────────────────────────────────────────────────────────────────

  scheduleCron(def: CronJobRow): void {
    this.cronJobs.set(def.cronId, def);
    this.backend.saveCron({ ...def, agentId: this.identity.userId });
  }

  cancelCron(cronId: string): 'success' | 'cancelled' | 'not_found' {
    if (this.cronJobs.delete(cronId)) {
      this.backend.deleteCron(cronId);
      return 'cancelled';
    }
    return 'not_found';
  }

  listCrons(): readonly CronJobRow[] {
    return [...this.cronJobs.values()];
  }

  // ── Memory (NewioAppForMcp) ────────────────────────────────────────────────

  async getContactMemory(username: string): Promise<McpMemoryData> {
    const user = this.backend.getUserByUsername(username);
    if (!user) {
      return { summary: null, facts: [] };
    }
    const scope = this.backend.getMemoryScope(this.identity.userId, `user#${user.userId}`);
    return { summary: scope.summary, facts: scope.facts };
  }

  async getConversationMemory(conversationId: string): Promise<McpMemoryData> {
    const scope = this.backend.getMemoryScope(this.identity.userId, `conv#${conversationId}`);
    return { summary: scope.summary, facts: scope.facts };
  }

  async addMemory(text: string, opts?: { username?: string; conversationId?: string }): Promise<void> {
    this.backend.addMemoryFact(this.identity.userId, this.memoryScopeKey(opts?.username, opts?.conversationId), text);
  }

  async updateMemory(
    factId: string,
    text: string,
    opts?: { username?: string; conversationId?: string },
  ): Promise<void> {
    this.backend.updateMemoryFact(
      this.identity.userId,
      this.memoryScopeKey(opts?.username, opts?.conversationId),
      factId,
      text,
    );
  }

  async deleteMemory(factId: string, opts?: { username?: string; conversationId?: string }): Promise<void> {
    this.backend.deleteMemoryFact(
      this.identity.userId,
      this.memoryScopeKey(opts?.username, opts?.conversationId),
      factId,
    );
  }

  async updateMemorySummary(text: string, opts?: { username?: string; conversationId?: string }): Promise<void> {
    this.backend.updateMemorySummary(
      this.identity.userId,
      this.memoryScopeKey(opts?.username, opts?.conversationId),
      text,
    );
  }

  // ── Memory (NewioAppForAgent) ──────────────────────────────────────────────

  async loadSessionMemory(
    conversationId?: string,
    _participantIds?: readonly string[],
  ): Promise<LoadSessionMemoryResponse> {
    return {
      global: this.toScopeData(this.backend.getMemoryScope(this.identity.userId, 'global')),
      participants: {},
      conversation: conversationId
        ? this.toScopeData(this.backend.getMemoryScope(this.identity.userId, `conv#${conversationId}`))
        : { summary: null, facts: [] },
      topUsers: [],
      topConversations: [],
    };
  }

  async getMemoryScope(scope: string, scopeId: string): Promise<MemoryScopeData> {
    const key = scope === 'global' ? 'global' : scope === 'user' ? `user#${scopeId}` : `conv#${scopeId}`;
    return this.toScopeData(this.backend.getMemoryScope(this.identity.userId, key));
  }

  async getHandoffNote(conversationId: string): Promise<string | null> {
    return this.backend.getHandoffNote(this.identity.userId, conversationId);
  }

  async putHandoffNote(conversationId: string, text: string): Promise<void> {
    this.backend.putHandoffNote(this.identity.userId, conversationId, text);
  }

  // ── Conversations (cache methods for NewioAppForAgent) ─────────────────────

  async getOrCreateOwnerDmConversationId(): Promise<string> {
    if (!this.identity.ownerId) {
      throw new Error('Agent has no owner');
    }
    const owner = this.backend.getUser(this.identity.ownerId)!;
    return this.getOrCreateDm(owner.username);
  }

  getCachedConversationInfo(conversationId: string): { type: string; name?: string } | undefined {
    const conv = this.backend.getConversation(conversationId);
    if (!conv) {
      return undefined;
    }
    return { type: conv.type, ...(conv.name ? { name: conv.name } : {}) };
  }

  isConversationMember(conversationId: string, userId: string): boolean {
    return this.backend.getConversation(conversationId)?.members.some((m) => m.userId === userId) ?? false;
  }

  getConversationMemberIds(conversationId: string): readonly string[] | undefined {
    return this.backend.getConversation(conversationId)?.members.map((m) => m.userId);
  }

  getMemberDisplayInfo(
    conversationId: string,
    userId: string,
  ): { username?: string; displayName?: string } | undefined {
    const conv = this.backend.getConversation(conversationId);
    if (!conv?.members.some((m) => m.userId === userId)) {
      return undefined;
    }
    const user = this.backend.getUser(userId);
    return { username: user?.username, displayName: user?.displayName };
  }

  getSessionConfig(_conversationId: string): { acpModel?: string; acpMode?: string } | undefined {
    return undefined;
  }

  getConversationFlags(_conversationId: string): { showToolCalls: boolean; showThoughts: boolean } {
    return { showToolCalls: false, showThoughts: false };
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

  // ── Internal ───────────────────────────────────────────────────────────────

  private handleBackendEvent(event: BackendEvent): void {
    switch (event.type) {
      case 'message.new': {
        const sender = this.backend.getUser(event.message.senderId);
        const isOwnMessage = event.message.senderId === this.identity.userId;
        const contacts = this.backend.getContacts(this.identity.userId);
        const isOwner = event.message.senderId === this.identity.ownerId;
        const isContact = contacts.some((c) => c.userId === event.message.senderId);
        let relationship: SenderRelationship = 'stranger';
        if (isOwner) {
          relationship = 'owner';
        } else if (isContact) {
          relationship = 'in-contact';
        }

        const incoming: IncomingMessage = {
          messageId: event.message.messageId,
          conversationId: event.message.conversationId,
          conversationType: event.conversation.type,
          groupName: event.conversation.name,
          senderUserId: event.message.senderId,
          senderUsername: sender?.username,
          senderDisplayName: sender?.displayName,
          senderAccountType: sender?.accountType,
          relationship,
          isOwnMessage,
          text: event.message.content.text ?? '',
          timestamp: event.message.createdAt,
          status: 'new',
        };
        this.emit('message.new', incoming);
        break;
      }
      case 'contact.request_received': {
        const fromUser = this.backend.getUser(event.fromUserId);
        if (fromUser) {
          this.emit('contact.event', {
            type: 'contact.request_received',
            username: fromUser.username,
            displayName: fromUser.displayName,
            accountType: fromUser.accountType,
            timestamp: new Date().toISOString(),
          } satisfies ContactEvent);
        }
        break;
      }
      case 'contact.accepted': {
        const contactUser = this.backend.getUser(event.contactId);
        if (contactUser) {
          this.emit('contact.event', {
            type: 'contact.request_accepted',
            username: contactUser.username,
            displayName: contactUser.displayName,
            accountType: contactUser.accountType,
            timestamp: new Date().toISOString(),
          } satisfies ContactEvent);
        }
        break;
      }
      case 'contact.removed': {
        const removedUser = this.backend.getUser(event.contactId);
        if (removedUser) {
          this.emit('contact.event', {
            type: 'contact.removed',
            username: removedUser.username,
            displayName: removedUser.displayName,
            accountType: removedUser.accountType,
            timestamp: new Date().toISOString(),
          } satisfies ContactEvent);
        }
        break;
      }
      case 'signal': {
        void this.handleSignal(event.signal);
        break;
      }
    }
  }

  private async handleSignal(signal: BackendSignal): Promise<void> {
    const req = { sessionType: signal.sessionType, externalReferenceId: signal.externalReferenceId };
    switch (signal.signalType) {
      case 'rotate_session':
        if (this.rotateSessionHandler) {
          await this.rotateSessionHandler(req);
        }
        break;
      case 'update_memory':
        if (this.updateMemoryHandler) {
          await this.updateMemoryHandler(req);
        }
        break;
      case 'cancel_session':
        if (this.cancelSessionHandler) {
          await this.cancelSessionHandler(req);
        }
        break;
      case 'compact_session':
        if (this.compactSessionHandler) {
          await this.compactSessionHandler(req);
        }
        break;
      case 'start_session':
        if (this.startSessionHandler) {
          await this.startSessionHandler(req);
        }
        break;
      case 'live_session_info':
        if (this.liveSessionInfoHandler) {
          await this.liveSessionInfoHandler(req as never);
        }
        break;
    }
  }

  private resolveUser(username: string): {
    userId: string;
    username: string;
    displayName: string;
    accountType: string;
    bio?: string;
    avatarUrl?: string;
  } {
    const user = this.backend.getUserByUsername(username);
    if (!user) {
      throw new Error(`User @${username} not found`);
    }
    return user;
  }

  private resolveUsernames(usernames: readonly string[]): string[] {
    return usernames
      .filter((u) => u.toLowerCase() !== this.identity.username.toLowerCase())
      .map((u) => this.resolveUser(u).userId);
  }

  private memoryScopeKey(username?: string, conversationId?: string): string {
    if (username) {
      return `user#${this.resolveUser(username).userId}`;
    }
    if (conversationId) {
      return `conv#${conversationId}`;
    }
    return 'global';
  }

  private toScopeData(scope: BackendMemoryScope): MemoryScopeData {
    return {
      summary: scope.summary
        ? {
            scope: 'global',
            scopeId: '_',
            text: scope.summary,
            lastInteractionAt: new Date().toISOString(),
            interactionCount: 1,
          }
        : null,
      facts: scope.facts,
    };
  }
}
