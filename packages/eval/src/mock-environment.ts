/**
 * Mock environment for eval scenarios.
 *
 * Provides:
 * - MockNewioApp: realistic in-memory NewioApp that holds and mutates state
 * - ToolInterceptor: captures MCP tool calls for assertion
 * - MockMemoryStore: in-memory memory store that records operations
 */
import { createHash, randomUUID } from 'crypto';
import type { ToolCallRecord } from './types.js';
import type { NewioAppForMcp, McpContactSummary } from '@newio/agent-engine';

// ---------------------------------------------------------------------------
// Deterministic UUID helper — derives a UUID v4-shaped ID from a stable key.
// Scenario authors use the same function to predict conversationIds.
// ---------------------------------------------------------------------------

/** Generate a deterministic UUID from a key string. Exported for use in scenario fixtures. */
export function deterministicUuid(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash.charAt(16), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

/** Deterministic conversationId for a DM with a given username. */
export function dmConversationId(username: string): string {
  return deterministicUuid(`dm:${username}`);
}

/** Deterministic conversationId for a work session with a given name. */
export function workSessionConversationId(name: string): string {
  return deterministicUuid(`work_session:${name}`);
}

/** Deterministic conversationId for a group with a given name. */
export function groupConversationId(name: string): string {
  return deterministicUuid(`group:${name}`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockIdentity {
  readonly userId: string;
  readonly username: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly ownerId?: string;
}

export interface MockOwnerInfo {
  readonly username: string;
  readonly displayName: string;
}

interface MockContact {
  userId: string;
  username: string;
  displayName: string;
  accountType: string;
}

interface MockMember {
  userId: string;
  username: string;
  displayName: string;
  accountType: string;
  role: string;
}

interface MockConversation {
  conversationId: string;
  type: string;
  name?: string;
  members: MockMember[];
  createdBy: string;
  createdAt: string;
  lastMessageAt?: string;
}

interface MockMessage {
  messageId: string;
  conversationId: string;
  senderId: string;
  content: { text?: string; attachments?: { fileName: string; contentType: string; size: number; s3Key: string }[] };
  createdAt: string;
}

interface MockFriendRequest {
  username: string;
  displayName: string;
  accountType: string;
  note?: string;
}

interface MockUserProfile {
  userId: string;
  username: string;
  displayName: string;
  accountType: string;
  bio?: string;
  avatarUrl?: string;
}

interface MockCronJob {
  cronId: string;
  expression: string;
  label: string;
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// MockNewioAppOptions
// ---------------------------------------------------------------------------

export interface MockNewioAppOptions {
  readonly identity: MockIdentity;
  readonly owner: MockOwnerInfo;
  readonly contacts?: readonly {
    readonly username: string;
    readonly displayName: string;
    readonly accountType?: string;
  }[];
  readonly conversations?: readonly {
    readonly conversationId: string;
    readonly type: string;
    readonly name?: string;
    readonly members?: readonly {
      readonly username: string;
      readonly displayName: string;
      readonly accountType: string;
      readonly role?: string;
    }[];
  }[];
  readonly messages?: readonly MockMessage[];
  readonly incomingFriendRequests?: readonly MockFriendRequest[];
  readonly users?: readonly MockUserProfile[];
  readonly memoryStore?: Readonly<
    Record<string, { summary: string | null; facts: readonly { factId: string; text: string }[] }>
  >;
}

// ---------------------------------------------------------------------------
// MockNewioApp — realistic in-memory simulation
// ---------------------------------------------------------------------------

/**
 * In-memory NewioApp mock that holds mutable state for contacts, conversations,
 * members, messages, friend requests, and memory. All IDs are UUIDs.
 */
export class MockNewioApp implements NewioAppForMcp {
  readonly identity: MockIdentity;
  private readonly owner: MockOwnerInfo;
  private readonly contacts: Map<string, MockContact>;
  private readonly conversations: Map<string, MockConversation>;
  private readonly messages: Map<string, MockMessage[]>; // keyed by conversationId
  private readonly incomingFriendRequests: MockFriendRequest[];
  private readonly users: Map<string, MockUserProfile>;
  private readonly memoryStore: Record<string, { summary: string | null; facts: { factId: string; text: string }[] }>;
  private readonly cronJobs: Map<string, MockCronJob>;
  private nextFactId = 1;

  constructor(opts: MockNewioAppOptions) {
    this.identity = opts.identity;
    this.owner = opts.owner;

    // Contacts
    this.contacts = new Map();
    for (const c of opts.contacts ?? []) {
      const userId = deterministicUuid(`user:${c.username}`);
      this.contacts.set(c.username, {
        userId,
        username: c.username,
        displayName: c.displayName,
        accountType: c.accountType ?? 'human',
      });
    }

    // Conversations with members
    this.conversations = new Map();
    for (const c of opts.conversations ?? []) {
      const members: MockMember[] = (c.members ?? []).map((m) => ({
        userId: deterministicUuid(`user:${m.username}`),
        username: m.username,
        displayName: m.displayName,
        accountType: m.accountType,
        role: m.role ?? 'member',
      }));
      this.conversations.set(c.conversationId, {
        conversationId: c.conversationId,
        type: c.type,
        name: c.name,
        members,
        createdBy: opts.identity.userId,
        createdAt: new Date().toISOString(),
      });
    }

    // Messages
    this.messages = new Map();
    for (const m of opts.messages ?? []) {
      const list = this.messages.get(m.conversationId) ?? [];
      list.push(m);
      this.messages.set(m.conversationId, list);
    }

    // Friend requests
    this.incomingFriendRequests = [...(opts.incomingFriendRequests ?? [])];

    // User profiles (for search/lookup)
    this.users = new Map();
    for (const u of opts.users ?? []) {
      this.users.set(u.username, u);
    }
    // Also add contacts as users for lookup
    for (const c of this.contacts.values()) {
      if (!this.users.has(c.username)) {
        this.users.set(c.username, { ...c });
      }
    }

    // Memory
    this.memoryStore = opts.memoryStore
      ? Object.fromEntries(
          Object.entries(opts.memoryStore).map(([k, v]) => [k, { summary: v.summary, facts: [...v.facts] }]),
        )
      : {};

    // Cron
    this.cronJobs = new Map();
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  getOwnerInfo(): MockOwnerInfo {
    return this.owner;
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  getAllContacts(): McpContactSummary[] {
    return [...this.contacts.values()].map((c) => ({
      username: c.username,
      displayName: c.displayName,
      accountType: c.accountType,
    }));
  }

  private resolveUsername(username: string): string {
    const contact = this.contacts.get(username);
    return contact?.userId ?? deterministicUuid(`user:${username}`);
  }

  listIncomingFriendRequests(): readonly MockFriendRequest[] {
    return this.incomingFriendRequests;
  }

  async sendFriendRequestByUsername(_username: string, _note?: string): Promise<void> {}

  acceptFriendRequestByUsername(username: string): Promise<void> {
    const idx = this.incomingFriendRequests.findIndex((r) => r.username === username);
    if (idx >= 0) {
      const req = this.incomingFriendRequests[idx];
      if (req) {
        this.incomingFriendRequests.splice(idx, 1);
        this.contacts.set(username, {
          userId: deterministicUuid(`user:${username}`),
          username,
          displayName: req.displayName,
          accountType: req.accountType,
        });
      }
    }
    return Promise.resolve();
  }

  rejectFriendRequestByUsername(username: string): Promise<void> {
    const idx = this.incomingFriendRequests.findIndex((r) => r.username === username);
    if (idx >= 0) {
      this.incomingFriendRequests.splice(idx, 1);
    }
    return Promise.resolve();
  }

  removeFriendByUsername(username: string): Promise<void> {
    this.contacts.delete(username);
    return Promise.resolve();
  }

  // ── Conversations ─────────────────────────────────────────────────────────

  listConversations(
    limit?: number,
    afterConversationId?: string,
  ): { conversations: { conversationId: string; type: string; name?: string }[]; hasMore: boolean } {
    const all = [...this.conversations.values()];
    const pageSize = limit ?? 20;
    let startIdx = 0;
    if (afterConversationId) {
      const idx = all.findIndex((c) => c.conversationId === afterConversationId);
      if (idx >= 0) {
        startIdx = idx + 1;
      }
    }
    const page = all.slice(startIdx, startIdx + pageSize);
    const hasMore = startIdx + pageSize < all.length;
    return {
      conversations: page.map((c) => ({
        conversationId: c.conversationId,
        type: c.type,
        ...(c.name ? { name: c.name } : {}),
      })),
      hasMore,
    };
  }

  getOrCreateDm(username: string): Promise<string> {
    const convId = dmConversationId(username);
    if (!this.conversations.has(convId)) {
      const contact = this.contacts.get(username);
      this.conversations.set(convId, {
        conversationId: convId,
        type: 'dm',
        members: [
          {
            userId: this.identity.userId,
            username: this.identity.username,
            displayName: this.identity.displayName ?? this.identity.username,
            accountType: 'agent',
            role: 'member',
          },
          ...(contact
            ? [
                {
                  userId: contact.userId,
                  username: contact.username,
                  displayName: contact.displayName,
                  accountType: contact.accountType,
                  role: 'member',
                },
              ]
            : []),
        ],
        createdBy: this.identity.userId,
        createdAt: new Date().toISOString(),
      });
    }
    return Promise.resolve(convId);
  }

  createWorkSession(name: string, usernames: readonly string[]): Promise<string> {
    const convId = workSessionConversationId(name);
    const members: MockMember[] = [
      {
        userId: this.identity.userId,
        username: this.identity.username,
        displayName: this.identity.displayName ?? this.identity.username,
        accountType: 'agent',
        role: 'admin',
      },
    ];
    for (const u of usernames) {
      const c = this.contacts.get(u);
      members.push({
        userId: c?.userId ?? deterministicUuid(`user:${u}`),
        username: u,
        displayName: c?.displayName ?? u,
        accountType: c?.accountType ?? 'human',
        role: 'member',
      });
    }
    this.conversations.set(convId, {
      conversationId: convId,
      type: 'temp_group',
      name,
      members,
      createdBy: this.identity.userId,
      createdAt: new Date().toISOString(),
    });
    return Promise.resolve(convId);
  }

  createGroup(name: string, usernames: readonly string[]): Promise<string> {
    const convId = groupConversationId(name);
    const members: MockMember[] = [
      {
        userId: this.identity.userId,
        username: this.identity.username,
        displayName: this.identity.displayName ?? this.identity.username,
        accountType: 'agent',
        role: 'admin',
      },
    ];
    for (const u of usernames) {
      const c = this.contacts.get(u);
      members.push({
        userId: c?.userId ?? deterministicUuid(`user:${u}`),
        username: u,
        displayName: c?.displayName ?? u,
        accountType: c?.accountType ?? 'human',
        role: 'member',
      });
    }
    this.conversations.set(convId, {
      conversationId: convId,
      type: 'group',
      name,
      members,
      createdBy: this.identity.userId,
      createdAt: new Date().toISOString(),
    });
    return Promise.resolve(convId);
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  sendMessage(
    conversationId: string,
    text?: string,
    _opts?: { filePaths?: readonly string[]; metadata?: Record<string, unknown>; visibleTo?: readonly string[] },
  ): Promise<void> {
    const msg: MockMessage = {
      messageId: randomUUID(),
      conversationId,
      senderId: this.identity.userId,
      content: { text: text ?? undefined },
      createdAt: new Date().toISOString(),
    };
    const list = this.messages.get(conversationId) ?? [];
    list.push(msg);
    this.messages.set(conversationId, list);
    const conv = this.conversations.get(conversationId);
    if (conv) {
      conv.lastMessageAt = msg.createdAt;
    }
    return Promise.resolve();
  }

  async sendDm(username: string, text: string, _filePaths?: readonly string[]): Promise<void> {
    const convId = await this.getOrCreateDm(username);
    await this.sendMessage(convId, text);
  }

  async dmOwner(text: string, _filePaths?: readonly string[]): Promise<void> {
    await this.sendDm(this.owner.username, text);
  }

  downloadAttachment(_conversationId: string, _s3Key: string, fileName: string): Promise<string> {
    return Promise.resolve(`/tmp/newio-downloads/${fileName}`);
  }

  // ── Cron ──────────────────────────────────────────────────────────────────

  scheduleCron(job: { cronId: string; expression: string; label: string; payload?: unknown }): void {
    this.cronJobs.set(job.cronId, job);
  }

  cancelCron(cronId: string): 'cancelled' | 'not_found' {
    return this.cronJobs.delete(cronId) ? 'cancelled' : 'not_found';
  }

  listCrons(): MockCronJob[] {
    return [...this.cronJobs.values()];
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  getContactMemory(
    username: string,
  ): Promise<{ summary: string | null; facts: readonly { factId: string; text: string }[] }> {
    return Promise.resolve(this.memoryStore[username] ?? { summary: null, facts: [] });
  }

  getConversationMemory(
    conversationId: string,
  ): Promise<{ summary: string | null; facts: readonly { factId: string; text: string }[] }> {
    return Promise.resolve(this.memoryStore[conversationId] ?? { summary: null, facts: [] });
  }

  addMemory(text: string, opts?: { username?: string; conversationId?: string }): Promise<void> {
    const key = opts?.username ?? opts?.conversationId ?? '__global__';
    if (!this.memoryStore[key]) {
      this.memoryStore[key] = { summary: null, facts: [] };
    }
    this.memoryStore[key].facts.push({ factId: `fact_${this.nextFactId++}`, text });
    return Promise.resolve();
  }

  updateMemory(factId: string, text: string, opts?: { username?: string; conversationId?: string }): Promise<void> {
    const key = opts?.username ?? opts?.conversationId ?? '__global__';
    const store = this.memoryStore[key];
    if (store) {
      const fact = store.facts.find((f) => f.factId === factId);
      if (fact) {
        (fact as { factId: string; text: string }).text = text;
      }
    }
    return Promise.resolve();
  }

  deleteMemory(factId: string, opts?: { username?: string; conversationId?: string }): Promise<void> {
    const key = opts?.username ?? opts?.conversationId ?? '__global__';
    const store = this.memoryStore[key];
    if (store) {
      store.facts = store.facts.filter((f) => f.factId !== factId);
    }
    return Promise.resolve();
  }

  updateMemorySummary(text: string, opts?: { username?: string; conversationId?: string }): Promise<void> {
    const key = opts?.username ?? opts?.conversationId ?? '__global__';
    if (!this.memoryStore[key]) {
      this.memoryStore[key] = { summary: null, facts: [] };
    }
    this.memoryStore[key].summary = text;
    return Promise.resolve();
  }

  // ── Client-facing methods (match NewioApp public API) ───────────────────

  getMe(): Promise<{
    userId: string;
    username: string;
    displayName: string;
    accountType: string;
    bio?: string;
    avatarUrl?: string;
  }> {
    return Promise.resolve({
      userId: this.identity.userId,
      username: this.identity.username,
      displayName: this.identity.displayName ?? this.identity.username,
      accountType: 'agent',
      bio: undefined,
      avatarUrl: this.identity.avatarUrl,
    });
  }

  getConversationInfo(conversationId: string): Promise<{
    conversationId: string;
    type: string;
    name?: string;
    admins: string[];
  }> {
    const conv = this.conversations.get(conversationId);
    const admins = (conv?.members ?? []).filter((m) => m.role === 'admin').map((m) => m.username);
    return Promise.resolve({
      conversationId,
      type: conv?.type ?? 'dm',
      ...(conv?.name ? { name: conv.name } : {}),
      admins,
    });
  }

  checkIsMember(conversationId: string, username: string): Promise<boolean> {
    const conv = this.conversations.get(conversationId);
    const isMember = conv?.members.some((m) => m.username.toLowerCase() === username.toLowerCase()) ?? false;
    return Promise.resolve(isMember);
  }

  listConversationMembers(
    conversationId: string,
    limit?: number,
    afterUsername?: string,
  ): Promise<{
    members: { username: string; displayName: string; accountType: string; role: string }[];
    hasMore: boolean;
  }> {
    const conv = this.conversations.get(conversationId);
    const allMembers = (conv?.members ?? []).map((m) => ({
      username: m.username,
      displayName: m.displayName,
      accountType: m.accountType,
      role: m.role,
    }));
    const pageSize = limit ?? 20;
    let startIdx = 0;
    if (afterUsername) {
      const idx = allMembers.findIndex((m) => m.username.toLowerCase() === afterUsername.toLowerCase());
      if (idx >= 0) {
        startIdx = idx + 1;
      }
    }
    const page = allMembers.slice(startIdx, startIdx + pageSize);
    const hasMore = startIdx + pageSize < allMembers.length;
    return Promise.resolve({ members: page, hasMore });
  }

  addMembersByUsername(conversationId: string, usernames: readonly string[]): Promise<void> {
    const conv = this.conversations.get(conversationId);
    if (conv) {
      for (const username of usernames) {
        const userId = this.resolveUsername(username);
        if (!conv.members.some((m) => m.userId === userId)) {
          const contact = this.contacts.get(username);
          conv.members.push({
            userId,
            username: contact?.username ?? username,
            displayName: contact?.displayName ?? username,
            accountType: contact?.accountType ?? 'human',
            role: 'member',
          });
        }
      }
    }
    return Promise.resolve();
  }

  removeMemberByUsername(conversationId: string, username: string): Promise<void> {
    const conv = this.conversations.get(conversationId);
    if (conv) {
      const userId = this.resolveUsername(username);
      conv.members = conv.members.filter((m) => m.userId !== userId);
    }
    return Promise.resolve();
  }

  listMessages(
    conversationId: string,
    limit?: number,
    beforeMessageId?: string,
  ): Promise<{
    messages: {
      messageId: string;
      conversationId: string;
      senderId: string;
      content: {
        text?: string;
        attachments?: { fileName: string; contentType: string; size: number; s3Key: string }[];
      };
      createdAt: string;
    }[];
  }> {
    const all = this.messages.get(conversationId) ?? [];
    let filtered = [...all].reverse(); // newest first
    if (beforeMessageId) {
      const idx = filtered.findIndex((m) => m.messageId === beforeMessageId);
      if (idx >= 0) {
        filtered = filtered.slice(idx + 1);
      }
    }
    const messages = filtered.slice(0, limit ?? 20);
    return Promise.resolve({ messages });
  }

  searchUsers(query: string): Promise<{ users: MockUserProfile[] }> {
    const q = query.toLowerCase();
    const results = [...this.users.values()].filter(
      (u) => u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q),
    );
    return Promise.resolve({ users: results });
  }

  getUserByUsername(username: string): Promise<MockUserProfile> {
    const user = this.users.get(username);
    if (user) {
      return Promise.resolve(user);
    }
    return Promise.resolve({
      userId: deterministicUuid(`user:${username}`),
      username,
      displayName: username,
      accountType: 'human',
    });
  }
}

// ---------------------------------------------------------------------------
// ToolInterceptor — captures tool calls for assertions
// ---------------------------------------------------------------------------

export class ToolInterceptor {
  private readonly calls: ToolCallRecord[] = [];
  private currentEventIndex: number | undefined;

  setEventIndex(index: number | undefined): void {
    this.currentEventIndex = index;
  }

  record(tool: string, args: Record<string, unknown>, result?: unknown): void {
    this.calls.push({ tool, args, timestamp: Date.now(), eventIndex: this.currentEventIndex, result });
  }

  getAll(): readonly ToolCallRecord[] {
    return this.calls;
  }

  getSince(startIndex: number): readonly ToolCallRecord[] {
    return this.calls.slice(startIndex);
  }

  get count(): number {
    return this.calls.length;
  }

  clear(): void {
    this.calls.length = 0;
  }
}

// ---------------------------------------------------------------------------
// MockMemoryStore — records memory operations for assertions
// ---------------------------------------------------------------------------

export interface MemoryOperation {
  readonly op: 'add' | 'update' | 'delete' | 'update_summary' | 'get';
  readonly scope: 'global' | 'user' | 'conversation';
  readonly scopeId?: string;
  readonly factId?: string;
  readonly text?: string;
  readonly timestamp: number;
}

export class MockMemoryStore {
  private readonly operations: MemoryOperation[] = [];
  private readonly facts = new Map<string, { text: string; scope: string; scopeId: string }>();
  private readonly summaries = new Map<string, string>();
  private nextFactId = 1;

  recordGet(scope: 'global' | 'user' | 'conversation', scopeId?: string): void {
    this.operations.push({ op: 'get', scope, scopeId, timestamp: Date.now() });
  }

  recordAdd(text: string, scope: 'global' | 'user' | 'conversation', scopeId?: string): string {
    const factId = `fact_${this.nextFactId++}`;
    this.facts.set(factId, { text, scope, scopeId: scopeId ?? '_' });
    this.operations.push({ op: 'add', scope, scopeId, text, timestamp: Date.now() });
    return factId;
  }

  recordUpdate(factId: string, text: string, scope: 'global' | 'user' | 'conversation', scopeId?: string): void {
    const existing = this.facts.get(factId);
    if (existing) {
      this.facts.set(factId, { ...existing, text });
    }
    this.operations.push({ op: 'update', scope, scopeId, factId, text, timestamp: Date.now() });
  }

  recordDelete(factId: string, scope: 'global' | 'user' | 'conversation', scopeId?: string): void {
    this.facts.delete(factId);
    this.operations.push({ op: 'delete', scope, scopeId, factId, timestamp: Date.now() });
  }

  recordUpdateSummary(text: string, scope: 'global' | 'user' | 'conversation', scopeId?: string): void {
    const key = `${scope}:${scopeId ?? '_'}`;
    this.summaries.set(key, text);
    this.operations.push({ op: 'update_summary', scope, scopeId, text, timestamp: Date.now() });
  }

  getOperations(): readonly MemoryOperation[] {
    return this.operations;
  }

  getOperationsByType(op: MemoryOperation['op']): readonly MemoryOperation[] {
    return this.operations.filter((o) => o.op === op);
  }

  clear(): void {
    this.operations.length = 0;
    this.facts.clear();
    this.summaries.clear();
  }
}
