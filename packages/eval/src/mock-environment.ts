/**
 * Mock environment for eval scenarios.
 *
 * Provides:
 * - MockNewioApp: minimal NewioApp stub for PromptFormatterImpl
 * - ToolInterceptor: captures MCP tool calls for assertion
 * - MockMemoryStore: in-memory memory store that records operations
 */
import type { ToolCallRecord } from './types.js';

// ---------------------------------------------------------------------------
// MockNewioApp — satisfies PromptFormatterImpl's needs
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

export interface MockNewioAppOptions {
  readonly identity: MockIdentity;
  readonly owner: MockOwnerInfo;
  readonly contacts?: readonly { readonly username: string; readonly displayName: string }[];
  readonly conversations?: readonly {
    readonly conversationId: string;
    readonly type: string;
    readonly name?: string;
  }[];
}

/**
 * Minimal mock that satisfies what PromptFormatterImpl and MCP tools need.
 * Does NOT extend NewioApp — it's a duck-typed stand-in with only the
 * properties/methods the engine actually calls during prompt formatting.
 */
export class MockNewioApp {
  readonly identity: MockIdentity;
  private readonly owner: MockOwnerInfo;
  private readonly contacts: ReadonlyMap<string, { readonly username: string; readonly displayName: string }>;
  private readonly conversations: readonly {
    readonly conversationId: string;
    readonly type: string;
    readonly name?: string;
  }[];

  constructor(opts: MockNewioAppOptions) {
    this.identity = opts.identity;
    this.owner = opts.owner;
    this.contacts = new Map((opts.contacts ?? []).map((c) => [c.username, c]));
    this.conversations = opts.conversations ?? [];
  }

  getOwnerInfo(): MockOwnerInfo {
    return this.owner;
  }

  getAllContacts(): readonly { readonly username: string; readonly displayName: string }[] {
    return [...this.contacts.values()];
  }

  getAllConversations(): readonly { readonly conversationId: string; readonly type: string; readonly name?: string }[] {
    return this.conversations;
  }

  /** Stub — returns the username as userId for simplicity in tests. */
  resolveUsername(username: string): Promise<string> {
    return Promise.resolve(`user_${username}`);
  }

  /** Stub — memory operations are handled by MockMemoryStore via ToolInterceptor. */
  getContactMemory(_username: string): Promise<{ summary: null; facts: readonly [] }> {
    return Promise.resolve({ summary: null, facts: [] });
  }

  getConversationMemory(_conversationId: string): Promise<{ summary: null; facts: readonly [] }> {
    return Promise.resolve({ summary: null, facts: [] });
  }

  async addMemory(_text: string, _opts?: { username?: string; conversationId?: string }): Promise<void> {}
  async updateMemory(
    _factId: string,
    _text: string,
    _opts?: { username?: string; conversationId?: string },
  ): Promise<void> {}
  async deleteMemory(_factId: string, _opts?: { username?: string; conversationId?: string }): Promise<void> {}
  async updateMemorySummary(_text: string, _opts?: { username?: string; conversationId?: string }): Promise<void> {}

  async sendMessage(_conversationId: string, _text?: string, _filePaths?: readonly string[]): Promise<void> {}
  async sendDm(_username: string, _text: string, _filePaths?: readonly string[]): Promise<void> {}
  async dmOwner(_text: string, _filePaths?: readonly string[]): Promise<void> {}

  async sendFriendRequestByUsername(_username: string, _note?: string): Promise<void> {}
  async acceptFriendRequestByUsername(_username: string): Promise<void> {}
  async rejectFriendRequestByUsername(_username: string): Promise<void> {}
  async removeFriendByUsername(_username: string): Promise<void> {}

  listIncomingFriendRequests(): readonly [] {
    return [];
  }

  createWorkSession(_name: string, _usernames: readonly string[]): Promise<string> {
    return Promise.resolve('mock-work-session-id');
  }

  createGroup(_name: string, _usernames: readonly string[]): Promise<string> {
    return Promise.resolve('mock-group-id');
  }

  // Stub client for tools that reach through to app.client
  readonly client = {
    listMessages: () => Promise.resolve({ messages: [] }),
    getConversation: () =>
      Promise.resolve({
        conversationId: '',
        type: 'dm',
        members: [],
        name: undefined,
        createdBy: '',
        createdAt: '',
        updatedAt: '',
        lastMessageAt: undefined,
      }),
    addMembers: () => Promise.resolve(),
    removeMember: () => Promise.resolve(),
  };
}

// ---------------------------------------------------------------------------
// ToolInterceptor — captures tool calls for assertions
// ---------------------------------------------------------------------------

export class ToolInterceptor {
  private readonly calls: ToolCallRecord[] = [];

  /** Record a tool call. */
  record(tool: string, args: Record<string, unknown>, result?: unknown): void {
    this.calls.push({ tool, args, timestamp: Date.now(), result });
  }

  /** Get all recorded tool calls. */
  getAll(): readonly ToolCallRecord[] {
    return this.calls;
  }

  /** Get tool calls since a given index (for per-event slicing). */
  getSince(startIndex: number): readonly ToolCallRecord[] {
    return this.calls.slice(startIndex);
  }

  /** Current count (use as marker before event processing). */
  get count(): number {
    return this.calls.length;
  }

  /** Clear all recorded calls. */
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

  /** Get all recorded operations. */
  getOperations(): readonly MemoryOperation[] {
    return this.operations;
  }

  /** Get operations of a specific type. */
  getOperationsByType(op: MemoryOperation['op']): readonly MemoryOperation[] {
    return this.operations.filter((o) => o.op === op);
  }

  /** Clear all state. */
  clear(): void {
    this.operations.length = 0;
    this.facts.clear();
    this.summaries.clear();
  }
}
