/**
 * Mock environment for eval scenarios.
 *
 * Provides:
 * - MockNewioApp: minimal NewioApp stub for PromptFormatterImpl
 * - ToolInterceptor: captures MCP tool calls for assertion
 * - MockMemoryStore: in-memory memory store that records operations
 */
import { createHash } from 'crypto';
import type { ToolCallRecord } from './types.js';

// ---------------------------------------------------------------------------
// Deterministic UUID helper — derives a UUID v4-shaped ID from a stable key.
// Scenario authors use the same function to predict conversationIds.
// ---------------------------------------------------------------------------

/** Generate a deterministic UUID from a key string. Exported for use in scenario fixtures. */
export function deterministicUuid(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  // Format as UUID v4 (set version nibble to 4, variant bits to 10xx)
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
  getOrCreateDm(username: string): Promise<string> {
    return Promise.resolve(dmConversationId(username));
  }

  async sendFriendRequestByUsername(_username: string, _note?: string): Promise<void> {}
  async acceptFriendRequestByUsername(_username: string): Promise<void> {}
  async rejectFriendRequestByUsername(_username: string): Promise<void> {}
  async removeFriendByUsername(_username: string): Promise<void> {}

  listIncomingFriendRequests(): readonly [] {
    return [];
  }

  createWorkSession(name: string, _usernames: readonly string[]): Promise<string> {
    return Promise.resolve(workSessionConversationId(name));
  }

  createGroup(name: string, _usernames: readonly string[]): Promise<string> {
    return Promise.resolve(groupConversationId(name));
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
  private currentEventIndex: number | undefined;

  /** Set the active event index. Tool calls recorded after this will be tagged with it. */
  setEventIndex(index: number | undefined): void {
    this.currentEventIndex = index;
  }

  /** Record a tool call. */
  record(tool: string, args: Record<string, unknown>, result?: unknown): void {
    this.calls.push({ tool, args, timestamp: Date.now(), eventIndex: this.currentEventIndex, result });
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
