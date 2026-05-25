/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * MockBackend — Shared in-memory "server" for multi-agent evaluation.
 *
 * Holds all users, conversations, messages, contacts, memory, crons.
 * Emits events to connected MockNewioApp instances.
 * Exposes backdoor methods for eval scenario setup.
 */
import { randomUUID } from 'crypto';
import type { AccountType, ConversationType } from '@newio/agent-sdk';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface BackendUser {
  userId: string;
  username: string;
  displayName: string;
  accountType: AccountType;
  avatarUrl?: string;
  bio?: string;
  ownerId?: string;
}

export interface BackendContact {
  userId: string;
  contactId: string;
  status: 'pending' | 'accepted';
  note?: string;
}

export interface BackendConversation {
  conversationId: string;
  type: ConversationType;
  name?: string;
  members: BackendMember[];
  createdBy: string;
  createdAt: string;
  lastMessageAt?: string;
}

export interface BackendMember {
  userId: string;
  role: 'admin' | 'member';
  canSend: boolean;
  // Limitation: notifyLevel is not modeled. Messages are always delivered to all members.
}

export interface BackendMessage {
  messageId: string;
  conversationId: string;
  senderId: string;
  content: { text?: string; attachments?: { fileName: string; contentType: string; size: number; s3Key: string }[] };
  createdAt: string;
  visibleTo?: readonly string[];
}

export interface BackendMemoryFact {
  factId: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackendMemoryScope {
  summary: string | null;
  facts: BackendMemoryFact[];
}

export interface BackendCronJob {
  cronId: string;
  agentId: string;
  expression: string;
  label: string;
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type BackendEvent =
  | { type: 'message.new'; message: BackendMessage; conversation: BackendConversation }
  | { type: 'contact.request_received'; fromUserId: string; toUserId: string; note?: string }
  | { type: 'contact.accepted'; userId: string; contactId: string }
  | { type: 'contact.removed'; userId: string; contactId: string }
  | { type: 'signal'; targetUserId: string; signal: BackendSignal };

export type BackendSignalType =
  | 'rotate_session'
  | 'update_memory'
  | 'cancel_session'
  | 'compact_session'
  | 'start_session'
  | 'live_session_info';

export interface BackendSignal {
  readonly signalType: BackendSignalType;
  readonly sessionType: 'conversation' | 'contact' | 'cron';
  readonly externalReferenceId: string;
}

export type BackendEventListener = (event: BackendEvent) => void;

// ---------------------------------------------------------------------------
// Scenario data schema (for loading from JSON files)
// ---------------------------------------------------------------------------

export interface ScenarioUser {
  readonly userId?: string;
  readonly username: string;
  readonly displayName: string;
  readonly accountType: AccountType;
  readonly ownerId?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
}

export interface ScenarioFriendship {
  /** Username of one side */
  readonly user1: string;
  /** Username of the other side */
  readonly user2: string;
}

export interface ScenarioFriendRequest {
  /** Username of the sender */
  readonly from: string;
  /** Username of the recipient */
  readonly to: string;
  readonly note?: string;
}

export interface ScenarioConversationMember {
  /** Username */
  readonly username: string;
  readonly role?: 'admin' | 'member';
}

export interface ScenarioConversation {
  readonly conversationId?: string;
  readonly type: ConversationType;
  readonly name?: string;
  /** Members by username */
  readonly members: readonly ScenarioConversationMember[];
  /** Username of the creator */
  readonly createdBy: string;
}

export interface ScenarioMessage {
  /** Username of sender */
  readonly from: string;
  readonly conversationId: string;
  readonly text?: string;
  readonly createdAt?: string;
}

export interface ScenarioMemoryFact {
  readonly text: string;
}

export interface ScenarioMemoryScope {
  readonly summary?: string;
  readonly facts?: readonly ScenarioMemoryFact[];
}

export interface ScenarioMemory {
  /** Username of the agent that owns this memory */
  readonly agent: string;
  readonly global?: ScenarioMemoryScope;
  /** Keyed by username */
  readonly users?: Readonly<Record<string, ScenarioMemoryScope>>;
  /** Keyed by conversationId */
  readonly conversations?: Readonly<Record<string, ScenarioMemoryScope>>;
}

export interface ScenarioHandoffNote {
  /** Username of the agent */
  readonly agent: string;
  readonly conversationId: string;
  readonly text: string;
}

export interface ScenarioData {
  readonly users: readonly ScenarioUser[];
  readonly friendships?: readonly ScenarioFriendship[];
  readonly friendRequests?: readonly ScenarioFriendRequest[];
  readonly conversations?: readonly ScenarioConversation[];
  readonly messages?: readonly ScenarioMessage[];
  readonly memory?: readonly ScenarioMemory[];
  readonly handoffNotes?: readonly ScenarioHandoffNote[];
}

// ---------------------------------------------------------------------------
// MockBackend
// ---------------------------------------------------------------------------

export class MockBackend {
  private readonly users = new Map<string, BackendUser>();
  private readonly contacts = new Map<string, BackendContact[]>();
  private readonly conversations = new Map<string, BackendConversation>();
  private readonly messages = new Map<string, BackendMessage[]>();
  private readonly memory = new Map<string, Map<string, BackendMemoryScope>>();
  private readonly handoffNotes = new Map<string, Map<string, string>>();
  private readonly cronJobs = new Map<string, BackendCronJob>();
  private readonly listeners = new Map<string, BackendEventListener>();
  private nextFactId = 1;

  // ── Load scenario data ──────────────────────────────────────────────────────

  /** Load scenario data from a typed object (parsed from JSON). */
  loadFrom(data: ScenarioData): void {
    // Users
    for (const u of data.users) {
      this.createUser(u);
    }

    // Friendships
    for (const f of data.friendships ?? []) {
      const u1 = this.getUserByUsername(f.user1);
      const u2 = this.getUserByUsername(f.user2);
      if (u1 && u2) {
        this.addFriendship(u1.userId, u2.userId);
      }
    }

    // Friend requests
    for (const r of data.friendRequests ?? []) {
      const from = this.getUserByUsername(r.from);
      const to = this.getUserByUsername(r.to);
      if (from && to) {
        this.seedFriendRequest(from.userId, to.userId, r.note);
      }
    }

    // Conversations (bypass ACL — scenario setup)
    for (const c of data.conversations ?? []) {
      const creator = this.getUserByUsername(c.createdBy);
      if (!creator) {
        continue;
      }
      const memberUserIds = c.members
        .map((m) => this.getUserByUsername(m.username)?.userId)
        .filter((id): id is string => id !== undefined);
      const conv = this.createConversationUnchecked({
        conversationId: c.conversationId,
        type: c.type,
        name: c.name,
        memberUserIds,
        createdBy: creator.userId,
      });
      // Apply roles
      for (const m of c.members) {
        if (m.role === 'admin') {
          const user = this.getUserByUsername(m.username);
          if (user) {
            const member = conv.members.find((bm) => bm.userId === user.userId);
            if (member) {
              member.role = 'admin';
            }
          }
        }
      }
    }

    // Messages (seeded without events)
    for (const m of data.messages ?? []) {
      const sender = this.getUserByUsername(m.from);
      if (sender) {
        this.seedMessage({
          conversationId: m.conversationId,
          senderId: sender.userId,
          text: m.text,
          createdAt: m.createdAt,
        });
      }
    }

    // Memory
    for (const mem of data.memory ?? []) {
      const agent = this.getUserByUsername(mem.agent);
      if (!agent) {
        continue;
      }
      if (mem.global) {
        if (mem.global.summary) {
          this.updateMemorySummary(agent.userId, 'global', mem.global.summary);
        }
        for (const f of mem.global.facts ?? []) {
          this.addMemoryFact(agent.userId, 'global', f.text);
        }
      }
      for (const [username, scope] of Object.entries(mem.users ?? {})) {
        const user = this.getUserByUsername(username);
        if (!user) {
          continue;
        }
        const key = `user#${user.userId}`;
        if (scope.summary) {
          this.updateMemorySummary(agent.userId, key, scope.summary);
        }
        for (const f of scope.facts ?? []) {
          this.addMemoryFact(agent.userId, key, f.text);
        }
      }
      for (const [convId, scope] of Object.entries(mem.conversations ?? {})) {
        const key = `conv#${convId}`;
        if (scope.summary) {
          this.updateMemorySummary(agent.userId, key, scope.summary);
        }
        for (const f of scope.facts ?? []) {
          this.addMemoryFact(agent.userId, key, f.text);
        }
      }
    }

    // Handoff notes
    for (const h of data.handoffNotes ?? []) {
      const agent = this.getUserByUsername(h.agent);
      if (agent) {
        this.putHandoffNote(agent.userId, h.conversationId, h.text);
      }
    }
  }

  // ── Backdoor: Setup ────────────────────────────────────────────────────────

  createUser(input: {
    userId?: string;
    username: string;
    displayName: string;
    accountType: AccountType;
    ownerId?: string;
    avatarUrl?: string;
    bio?: string;
  }): BackendUser {
    const user: BackendUser = {
      userId: input.userId ?? randomUUID(),
      username: input.username,
      displayName: input.displayName,
      accountType: input.accountType,
      ownerId: input.ownerId,
      avatarUrl: input.avatarUrl,
      bio: input.bio,
    };
    this.users.set(user.userId, user);
    this.contacts.set(user.userId, []);
    return user;
  }

  addFriendship(userId1: string, userId2: string): void {
    const c1 = this.contacts.get(userId1) ?? [];
    const c2 = this.contacts.get(userId2) ?? [];
    if (!c1.some((c) => c.contactId === userId2)) {
      c1.push({ userId: userId1, contactId: userId2, status: 'accepted' });
      this.contacts.set(userId1, c1);
    }
    if (!c2.some((c) => c.contactId === userId1)) {
      c2.push({ userId: userId2, contactId: userId1, status: 'accepted' });
      this.contacts.set(userId2, c2);
    }
  }

  createConversation(input: {
    conversationId?: string;
    type: ConversationType;
    name?: string;
    memberUserIds: readonly string[];
    createdBy: string;
  }): BackendConversation {
    // ACL: for DMs, creator must be friends with the other person
    if (input.type === 'dm') {
      const other = input.memberUserIds.find((id) => id !== input.createdBy);
      if (other) {
        const contacts = this.contacts.get(input.createdBy) ?? [];
        if (!contacts.some((c) => c.contactId === other && c.status === 'accepted')) {
          throw new Error(`User ${input.createdBy} is not friends with ${other}`);
        }
      }
    }
    // ACL: for group/temp_group, all non-creator members must be contacts of the creator
    if (input.type === 'group' || input.type === 'temp_group') {
      const contacts = this.contacts.get(input.createdBy) ?? [];
      for (const uid of input.memberUserIds) {
        if (uid !== input.createdBy && !contacts.some((c) => c.contactId === uid && c.status === 'accepted')) {
          throw new Error(`User ${input.createdBy} is not friends with ${uid}`);
        }
      }
    }
    return this.createConversationUnchecked(input);
  }

  /** Internal: create conversation without ACL checks (used by loadFrom and seedMessage). */
  private createConversationUnchecked(input: {
    conversationId?: string;
    type: ConversationType;
    name?: string;
    memberUserIds: readonly string[];
    createdBy: string;
  }): BackendConversation {
    const conv: BackendConversation = {
      conversationId: input.conversationId ?? randomUUID(),
      type: input.type,
      name: input.name,
      members: input.memberUserIds.map((uid) => ({
        userId: uid,
        role: uid === input.createdBy ? 'admin' : 'member',
        canSend: true,
      })),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    this.conversations.set(conv.conversationId, conv);
    this.messages.set(conv.conversationId, []);
    return conv;
  }

  seedMessage(input: { conversationId: string; senderId: string; text?: string; createdAt?: string }): BackendMessage {
    const msg: BackendMessage = {
      messageId: randomUUID(),
      conversationId: input.conversationId,
      senderId: input.senderId,
      content: { text: input.text },
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    const list = this.messages.get(input.conversationId) ?? [];
    list.push(msg);
    this.messages.set(input.conversationId, list);
    const conv = this.conversations.get(input.conversationId);
    if (conv) {
      conv.lastMessageAt = msg.createdAt;
    }
    return msg;
  }

  seedFriendRequest(fromUserId: string, toUserId: string, note?: string): void {
    const c = this.contacts.get(toUserId) ?? [];
    c.push({ userId: toUserId, contactId: fromUserId, status: 'pending', note });
    this.contacts.set(toUserId, c);
  }

  // ── Runtime ────────────────────────────────────────────────────────────────

  registerListener(userId: string, listener: BackendEventListener): void {
    this.listeners.set(userId, listener);
  }

  unregisterListener(userId: string): void {
    this.listeners.delete(userId);
  }

  getUser(userId: string): BackendUser | undefined {
    return this.users.get(userId);
  }

  getUserByUsername(username: string): BackendUser | undefined {
    for (const u of this.users.values()) {
      if (u.username.toLowerCase() === username.toLowerCase()) {
        return u;
      }
    }
    return undefined;
  }

  searchUsers(query: string): BackendUser[] {
    const q = query.toLowerCase();
    return [...this.users.values()].filter(
      (u) => u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q),
    );
  }

  getContacts(userId: string): BackendUser[] {
    const records = this.contacts.get(userId) ?? [];
    return records
      .filter((c) => c.status === 'accepted')
      .map((c) => this.users.get(c.contactId))
      .filter((u): u is BackendUser => u !== undefined);
  }

  getIncomingFriendRequests(userId: string): Array<{ user: BackendUser; note?: string }> {
    const records = this.contacts.get(userId) ?? [];
    return records
      .filter((c) => c.status === 'pending')
      .map((c) => ({ user: this.users.get(c.contactId), note: c.note }))
      .filter((r): r is { user: BackendUser; note: string | undefined } => r.user !== undefined);
  }

  sendFriendRequest(fromUserId: string, toUserId: string, note?: string): void {
    if (fromUserId === toUserId) {
      throw new Error('Cannot send a friend request to yourself');
    }
    const c = this.contacts.get(toUserId) ?? [];
    if (c.some((r) => r.contactId === fromUserId)) {
      return;
    }
    c.push({ userId: toUserId, contactId: fromUserId, status: 'pending', note });
    this.contacts.set(toUserId, c);
    this.emit(toUserId, { type: 'contact.request_received', fromUserId, toUserId, note });
  }

  acceptFriendRequest(userId: string, fromUserId: string): void {
    const records = this.contacts.get(userId) ?? [];
    const idx = records.findIndex((c) => c.contactId === fromUserId && c.status === 'pending');
    if (idx >= 0) {
      records[idx] = { ...records[idx]!, status: 'accepted' };
      const reverse = this.contacts.get(fromUserId) ?? [];
      reverse.push({ userId: fromUserId, contactId: userId, status: 'accepted' });
      this.contacts.set(fromUserId, reverse);
      this.emit(fromUserId, { type: 'contact.accepted', userId: fromUserId, contactId: userId });
    }
  }

  rejectFriendRequest(userId: string, fromUserId: string): void {
    const records = this.contacts.get(userId) ?? [];
    const idx = records.findIndex((c) => c.contactId === fromUserId && c.status === 'pending');
    if (idx >= 0) {
      records.splice(idx, 1);
    }
  }

  removeFriend(userId: string, contactId: string): void {
    const c1 = this.contacts.get(userId) ?? [];
    const c2 = this.contacts.get(contactId) ?? [];
    this.contacts.set(
      userId,
      c1.filter((c) => c.contactId !== contactId),
    );
    this.contacts.set(
      contactId,
      c2.filter((c) => c.contactId !== userId),
    );
    this.emit(contactId, { type: 'contact.removed', userId: contactId, contactId: userId });
  }

  getConversationsForUser(userId: string): BackendConversation[] {
    return [...this.conversations.values()].filter((c) => c.members.some((m) => m.userId === userId));
  }

  getConversation(conversationId: string): BackendConversation | undefined {
    return this.conversations.get(conversationId);
  }

  findDm(userId1: string, userId2: string): BackendConversation | undefined {
    for (const conv of this.conversations.values()) {
      if (conv.type === 'dm' && conv.members.length === 2) {
        const ids = conv.members.map((m) => m.userId);
        if (ids.includes(userId1) && ids.includes(userId2)) {
          return conv;
        }
      }
    }
    return undefined;
  }

  addMember(conversationId: string, userId: string, requesterId: string, role: 'admin' | 'member' = 'member'): void {
    const conv = this.conversations.get(conversationId);
    if (!conv) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    // ACL: requester must be a member; for groups, must be admin
    const requester = conv.members.find((m) => m.userId === requesterId);
    if (!requester) {
      throw new Error(`Requester ${requesterId} is not a member of conversation ${conversationId}`);
    }
    if (conv.type === 'group' && requester.role !== 'admin') {
      throw new Error(`User ${requesterId} is not an admin of group ${conversationId}`);
    }
    if (!conv.members.some((m) => m.userId === userId)) {
      conv.members.push({ userId, role, canSend: true });
    }
  }

  removeMember(conversationId: string, userId: string, requesterId: string): void {
    const conv = this.conversations.get(conversationId);
    if (!conv) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    // ACL: requester must be admin or removing themselves
    const requester = conv.members.find((m) => m.userId === requesterId);
    if (!requester) {
      throw new Error(`Requester ${requesterId} is not a member of conversation ${conversationId}`);
    }
    if (userId !== requesterId && conv.type === 'group' && requester.role !== 'admin') {
      throw new Error(`User ${requesterId} is not an admin of group ${conversationId}`);
    }
    conv.members = conv.members.filter((m) => m.userId !== userId);
  }

  sendMessage(input: {
    conversationId: string;
    senderId: string;
    text?: string;
    attachments?: { fileName: string; contentType: string; size: number; s3Key: string }[];
    visibleTo?: readonly string[];
  }): BackendMessage {
    const conv = this.conversations.get(input.conversationId);
    if (!conv) {
      throw new Error(`Conversation ${input.conversationId} not found`);
    }
    // ACL: sender must be a member
    if (!conv.members.some((m) => m.userId === input.senderId)) {
      throw new Error(`User ${input.senderId} is not a member of conversation ${input.conversationId}`);
    }
    // ACL: canSend check for group/temp_group
    const senderMember = conv.members.find((m) => m.userId === input.senderId);
    if ((conv.type === 'group' || conv.type === 'temp_group') && senderMember && !senderMember.canSend) {
      throw new Error(`User ${input.senderId} does not have send permission in conversation ${input.conversationId}`);
    }
    const msg: BackendMessage = {
      messageId: randomUUID(),
      conversationId: input.conversationId,
      senderId: input.senderId,
      content: { text: input.text, attachments: input.attachments },
      createdAt: new Date().toISOString(),
      visibleTo: input.visibleTo,
    };
    const list = this.messages.get(input.conversationId) ?? [];
    list.push(msg);
    this.messages.set(input.conversationId, list);
    conv.lastMessageAt = msg.createdAt;
    this.notifyObservers(msg);
    for (const member of conv.members) {
      this.emit(member.userId, { type: 'message.new', message: msg, conversation: conv });
    }
    return msg;
  }

  getMessages(conversationId: string, requesterId: string): BackendMessage[] {
    const conv = this.conversations.get(conversationId);
    if (!conv) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    if (!conv.members.some((m) => m.userId === requesterId)) {
      throw new Error(`User ${requesterId} is not a member of conversation ${conversationId}`);
    }
    return this.messages.get(conversationId) ?? [];
  }

  // ── Memory ──

  getMemoryScope(agentId: string, scopeKey: string): BackendMemoryScope {
    return this.memory.get(agentId)?.get(scopeKey) ?? { summary: null, facts: [] };
  }

  addMemoryFact(agentId: string, scopeKey: string, text: string): string {
    if (!this.memory.has(agentId)) {
      this.memory.set(agentId, new Map());
    }
    const agentMem = this.memory.get(agentId)!;
    if (!agentMem.has(scopeKey)) {
      agentMem.set(scopeKey, { summary: null, facts: [] });
    }
    const scope = agentMem.get(scopeKey)!;
    const factId = `fact_${this.nextFactId++}`;
    const now = new Date().toISOString();
    scope.facts.push({ factId, text, createdAt: now, updatedAt: now });
    return factId;
  }

  updateMemoryFact(agentId: string, scopeKey: string, factId: string, text: string): void {
    const scope = this.memory.get(agentId)?.get(scopeKey);
    const fact = scope?.facts.find((f) => f.factId === factId);
    if (fact) {
      fact.text = text;
      fact.updatedAt = new Date().toISOString();
    }
  }

  deleteMemoryFact(agentId: string, scopeKey: string, factId: string): void {
    const scope = this.memory.get(agentId)?.get(scopeKey);
    if (scope) {
      scope.facts = scope.facts.filter((f) => f.factId !== factId);
    }
  }

  updateMemorySummary(agentId: string, scopeKey: string, text: string): void {
    if (!this.memory.has(agentId)) {
      this.memory.set(agentId, new Map());
    }
    const agentMem = this.memory.get(agentId)!;
    if (!agentMem.has(scopeKey)) {
      agentMem.set(scopeKey, { summary: null, facts: [] });
    }
    agentMem.get(scopeKey)!.summary = text;
  }

  // ── Handoff ──

  getHandoffNote(agentId: string, conversationId: string): string | null {
    return this.handoffNotes.get(agentId)?.get(conversationId) ?? null;
  }

  putHandoffNote(agentId: string, conversationId: string, text: string): void {
    if (!this.handoffNotes.has(agentId)) {
      this.handoffNotes.set(agentId, new Map());
    }
    this.handoffNotes.get(agentId)!.set(conversationId, text);
  }

  // ── Cron ──

  saveCron(job: BackendCronJob): void {
    this.cronJobs.set(job.cronId, job);
  }

  deleteCron(cronId: string): boolean {
    return this.cronJobs.delete(cronId);
  }

  listCrons(agentId: string): BackendCronJob[] {
    return [...this.cronJobs.values()].filter((j) => j.agentId === agentId);
  }

  // ── Signals ──

  /** Send a signal to a target agent (owner → agent capability trigger). */
  sendSignal(targetUserId: string, signal: BackendSignal): void {
    this.emit(targetUserId, { type: 'signal', targetUserId, signal });
  }

  // ── Event Observation (for eval driver) ──

  private readonly observers = new Map<string, (msg: BackendMessage) => void>();

  /**
   * Subscribe to messages sent by specific users. The callback fires on each
   * message from any of the watched senderIds.
   */
  observeMessages(observerId: string, senderIds: ReadonlySet<string>, cb: (msg: BackendMessage) => void): void {
    // We register a post-send hook keyed by observerId
    this.observers.set(observerId, (msg) => {
      if (senderIds.has(msg.senderId)) {
        cb(msg);
      }
    });
  }

  /** Unsubscribe an observer. */
  unobserveMessages(observerId: string): void {
    this.observers.delete(observerId);
  }

  /**
   * Collect messages from observed senders. Blocks until at least one message
   * arrives, then waits for `idleMs` of silence before returning the batch.
   * Returns empty array on overall timeout.
   */
  async collectEvents(opts: {
    readonly senderIds: ReadonlySet<string>;
    readonly idleMs?: number;
    readonly timeoutMs?: number;
  }): Promise<BackendMessage[]> {
    const idleMs = opts.idleMs ?? 5000;
    const timeoutMs = opts.timeoutMs ?? 60000;
    const batch: BackendMessage[] = [];
    const observerId = `collect-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise<BackendMessage[]>((resolve) => {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        clearTimeout(overallTimer);
        this.unobserveMessages(observerId);
      };

      const finish = (): void => {
        cleanup();
        resolve(batch);
      };

      const resetIdle = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(finish, idleMs);
      };

      this.observeMessages(observerId, opts.senderIds, (msg) => {
        batch.push(msg);
        resetIdle();
      });

      // Overall timeout
      const overallTimer = setTimeout(() => {
        cleanup();
        resolve(batch);
      }, timeoutMs);
    });
  }

  // ── Internal ──

  private emit(userId: string, event: BackendEvent): void {
    this.listeners.get(userId)?.(event);
  }

  /** Notify observers when a message is sent. Called from sendMessage. */
  private notifyObservers(msg: BackendMessage): void {
    for (const cb of this.observers.values()) {
      cb(msg);
    }
  }
}
