/**
 * NewioApp — high-level abstraction over the Newio SDK.
 *
 * Owns the full Newio lifecycle: auth, HTTP client, WebSocket connection.
 * Delegates state management to {@link NewioAppStore}, media to helper functions,
 * event wiring to {@link wireEvents}, and prompt building to {@link buildNewioInstruction}.
 *
 * Used by the Agent Connector, MCP server, and standalone agent implementations.
 */
import { AuthManager } from '../core/auth.js';
import { NewioClient } from '../core/client.js';
import { NewioWebSocket } from '../core/websocket.js';
import { NewioAppStore } from './store.js';
import { wireEvents } from './events.js';
import { buildNewioInstruction } from './prompt.js';
import { uploadFiles, downloadAttachment } from './media.js';
import type { WebSocketFactory } from '../core/websocket.js';
import type { ApprovalHandle } from '../core/auth.js';
import type { StorePersistence } from './store.js';
import type { ActivityStatus, ContactRecord, MemberRecord, MessageContent, ConversationType } from '../core/types.js';
import type {
  IncomingMessage,
  ContactSummary,
  ConversationSummary,
  FriendRequestSummary,
  MemberSummary,
  MessageHandler,
  AppEventHandlers,
  NewioIdentity,
  NewioTokens,
} from './types.js';

// Re-export types and helpers that are part of the public API
export type {
  IncomingMessage,
  ContactSummary,
  ConversationSummary,
  FriendRequestSummary,
  MemberSummary,
  MessageHandler,
  AppEventHandlers,
  ContactEventInfo,
  NewioIdentity,
  NewioTokens,
} from './types.js';
export type { StorePersistence } from './store.js';
export { NewioAppStore } from './store.js';

/** Default Newio REST API base URL. */
export const NEWIO_API_BASE_URL = 'https://api.conduit.qinnan.dev';

/** Default Newio WebSocket URL. */
export const NEWIO_WS_URL = 'wss://ws.conduit.qinnan.dev';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link NewioApp.create}. */
export interface NewioAppCreateOptions {
  /** Existing agent ID (for login flow). */
  readonly agentId?: string;
  /** Existing username (for login-by-username flow). */
  readonly username?: string;
  /** Agent display name (used during registration). */
  readonly name: string;
  /** REST API base URL. */
  readonly apiBaseUrl: string;
  /** WebSocket URL. */
  readonly wsUrl: string;
  /** Factory to create WebSocket instances (e.g., `(url) => new WebSocket(url)`). */
  readonly wsFactory: WebSocketFactory;
  /** Pre-existing tokens to attempt reuse. */
  readonly tokens?: NewioTokens;
  /** Called when the approval URL is available (user must open it). */
  readonly onApprovalUrl?: (url: string) => void;
  /** Called when new tokens are obtained. */
  readonly onTokens?: (tokens: NewioTokens) => void;
  /** Abort signal to cancel the auth flow. */
  readonly signal?: AbortSignal;
  /** Directory for downloaded attachments (default: `./newio-downloads`). */
  readonly downloadDir?: string;
  /** Optional persistence layer for durable storage. */
  readonly persistence?: StorePersistence;
}

// ---------------------------------------------------------------------------
// NewioApp
// ---------------------------------------------------------------------------

/**
 * High-level Newio agent client.
 *
 * Wraps {@link AuthManager}, {@link NewioClient}, {@link NewioWebSocket},
 * and {@link NewioAppStore} into a single object with username resolution,
 * system prompt generation, and a clean event interface.
 */
export class NewioApp {
  readonly identity: NewioIdentity;
  readonly client: NewioClient;
  readonly auth: AuthManager;
  readonly store: NewioAppStore;
  private readonly ws: NewioWebSocket;
  private readonly downloadDir: string;

  private readonly eventHandlers: Partial<AppEventHandlers> = {};

  private constructor(
    identity: NewioIdentity,
    auth: AuthManager,
    client: NewioClient,
    ws: NewioWebSocket,
    store: NewioAppStore,
    downloadDir?: string,
  ) {
    this.identity = identity;
    this.auth = auth;
    this.client = client;
    this.ws = ws;
    this.store = store;
    this.downloadDir = downloadDir ?? './newio-downloads';
  }

  /**
   * Create a NewioApp from pre-initialized components (for testing).
   * Loads contacts/conversations and wires WebSocket events.
   */
  static async createFromComponents(
    identity: NewioIdentity,
    auth: AuthManager,
    client: NewioClient,
    ws: NewioWebSocket,
    store?: NewioAppStore,
  ): Promise<NewioApp> {
    const app = new NewioApp(identity, auth, client, ws, store ?? new NewioAppStore());
    await app.loadData();
    wireEvents(ws, app.store, client, identity, () => app.eventHandlers);
    return app;
  }

  /**
   * Create and initialize a NewioApp.
   *
   * Handles auth (register or login), profile sync, WebSocket connect,
   * and initial data loading. Returns a fully ready app instance.
   */
  static async create(opts: NewioAppCreateOptions): Promise<NewioApp> {
    const auth = new AuthManager(opts.apiBaseUrl);

    // Authenticate
    if (opts.tokens) {
      auth.setTokens(opts.tokens.accessToken, opts.tokens.refreshToken);
      try {
        await auth.forceRefresh();
      } catch {
        await doApprovalFlow(auth, opts);
      }
    } else {
      await doApprovalFlow(auth, opts);
    }

    // Notify caller of new tokens
    const accessToken = auth.getAccessToken();
    const refreshToken = auth.getRefreshToken();
    if (accessToken && refreshToken) {
      opts.onTokens?.({ accessToken, refreshToken });
    }

    // Create client, fetch profile
    const client = new NewioClient({ baseUrl: opts.apiBaseUrl, tokenProvider: auth.tokenProvider });
    const me = await client.getMe({});
    if (!me.username) {
      throw new Error('Agent account has no username. Registration may have failed.');
    }

    const identity: NewioIdentity = {
      userId: me.userId,
      username: me.username,
      displayName: me.displayName,
      ownerId: me.ownerId,
    };

    // Connect WebSocket
    const ws = new NewioWebSocket({
      url: opts.wsUrl,
      tokenProvider: auth.tokenProvider,
      wsFactory: opts.wsFactory,
    });
    await ws.connect();

    const store = new NewioAppStore(opts.persistence);
    const app = new NewioApp(identity, auth, client, ws, store, opts.downloadDir);
    await app.loadData();
    wireEvents(ws, store, client, identity, () => app.eventHandlers);
    return app;
  }

  /** Disconnect WebSocket and dispose auth. */
  dispose(): void {
    this.ws.disconnect();
    this.auth.dispose();
  }

  /** Register a listener for WebSocket disconnection. */
  onDisconnect(handler: () => void): void {
    this.ws.onStateChange((state) => {
      if (state === 'disconnected') {
        handler();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Event handler
  // ---------------------------------------------------------------------------

  /** Register a handler for an app-level event. */
  on<K extends keyof AppEventHandlers>(event: K, handler: AppEventHandlers[K]): void {
    this.eventHandlers[event] = handler;
  }

  /**
   * Set the handler for incoming messages.
   * @deprecated Use `on('message.new', handler)` instead.
   */
  onMessage(handler: MessageHandler): void {
    this.eventHandlers['message.new'] = handler;
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /** Send a text message to a conversation. */
  async sendMessage(conversationId: string, text: string): Promise<void> {
    const seq = this.store.nextSequenceNumber(conversationId);
    await this.client.sendMessage({
      conversationId,
      content: { text },
      sequenceNumber: seq,
    });
  }

  /**
   * Set the agent's activity status for a conversation.
   * Broadcasts typing/thinking indicators to other participants via WebSocket.
   */
  setStatus(status: ActivityStatus, conversationId?: string): void {
    if (conversationId) {
      this.ws.sendActivity(conversationId, status);
    }
  }

  /** Send a DM to the agent's owner. No-op if ownerId is not set. */
  async dmOwner(text: string): Promise<void> {
    if (!this.identity.ownerId) {
      return;
    }
    const conversationId = await this.findOrCreateDm(this.identity.ownerId);
    await this.sendMessage(conversationId, text);
  }

  /** Get or create the DM conversation with the agent's owner. Returns undefined if no owner. */
  async getOwnerDmConversationId(): Promise<string | undefined> {
    if (!this.identity.ownerId) {
      return undefined;
    }
    return this.findOrCreateDm(this.identity.ownerId);
  }

  /** Send a DM by username. Creates the DM conversation if it doesn't exist. */
  async sendDm(username: string, text: string): Promise<void> {
    const userId = await this.resolveUsername(username);
    const conversationId = await this.findOrCreateDm(userId);
    await this.sendMessage(conversationId, text);
  }

  /**
   * Send a message with optional file attachments.
   * Accepts local file paths — handles upload to S3 automatically.
   */
  async sendMessageWithAttachments(conversationId: string, text: string, filePaths?: readonly string[]): Promise<void> {
    const attachments = filePaths ? await uploadFiles(this.client, filePaths) : undefined;
    const content: MessageContent = {
      text: text || undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    };
    const seq = this.store.nextSequenceNumber(conversationId);
    await this.client.sendMessage({ conversationId, content, sequenceNumber: seq });
  }

  // ---------------------------------------------------------------------------
  // Contacts — high-level (username-based)
  // ---------------------------------------------------------------------------

  /** Send a friend request by username. */
  async sendFriendRequestByUsername(username: string, note?: string): Promise<void> {
    const userId = await this.resolveUsername(username);
    await this.client.sendFriendRequest({ contactId: userId, note });
  }

  /** List incoming friend requests as agent-friendly summaries. */
  listIncomingFriendRequests(): readonly FriendRequestSummary[] {
    // Backfill from API into store cache
    return this.store.getIncomingRequests().map((r) => ({
      username: r.friendUsername,
      displayName: r.friendDisplayName,
      accountType: r.friendAccountType,
      note: r.note,
    }));
  }

  /** Accept an incoming friend request by the sender's username. */
  async acceptFriendRequestByUsername(username: string): Promise<void> {
    const request = await this.findIncomingRequestByUsername(username);
    await this.client.acceptFriendRequest({ requestId: request.contactId });
    this.store.removeIncomingRequest(request.contactId);
    this.store.indexContact(request);
  }

  /** Reject an incoming friend request by the sender's username. */
  async rejectFriendRequestByUsername(username: string): Promise<void> {
    const request = await this.findIncomingRequestByUsername(username);
    await this.client.rejectFriendRequest({ requestId: request.contactId });
    this.store.removeIncomingRequest(request.contactId);
  }

  /** Remove a friend by username. */
  async removeFriendByUsername(username: string): Promise<void> {
    const userId = await this.resolveUsername(username);
    await this.client.removeFriend({ userId });
    this.store.removeContact(userId);
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------

  /**
   * Download a message attachment to a local directory.
   * Returns the local file path.
   */
  async downloadAttachment(conversationId: string, s3Key: string, fileName: string): Promise<string> {
    return downloadAttachment(this.client, this.downloadDir, conversationId, s3Key, fileName);
  }

  // ---------------------------------------------------------------------------
  // Lookups (delegate to store, fallback to API)
  // ---------------------------------------------------------------------------

  /** Resolve a username to a userId. Checks contact cache first, then API. */
  async resolveUsername(username: string): Promise<string> {
    const cached = this.store.resolveUsernameFromCache(username);
    if (cached) {
      return cached;
    }
    const user = await this.client.getUserByUsername({ username });
    return user.userId;
  }

  /** Check if a username is in the contact (friend) list. */
  isContact(username: string): boolean {
    const contactId = this.store.resolveUsernameFromCache(username);
    return contactId !== undefined && this.store.isContact(contactId);
  }

  /** Get a contact summary by username. */
  getContact(username: string): ContactSummary | undefined {
    const contactId = this.store.resolveUsernameFromCache(username);
    if (!contactId) {
      return undefined;
    }
    const c = this.store.getContact(contactId);
    if (!c) {
      return undefined;
    }
    return { username: c.friendUsername, displayName: c.friendDisplayName, accountType: c.friendAccountType };
  }

  /** Get a conversation by ID. */
  getConversation(conversationId: string): ConversationSummary | undefined {
    const c = this.store.getConversation(conversationId);
    if (c) {
      return {
        conversationId: c.conversationId,
        type: c.type,
        name: c.name,
        lastMessageAt: c.lastMessageAt,
      };
    }
    return undefined;
  }

  /** Get all conversations as agent-friendly summaries. */
  getAllConversations(): ConversationSummary[] {
    return this.store.getAllConversations().map((c) => ({
      conversationId: c.conversationId,
      type: c.type,
      name: c.name,
      lastMessageAt: c.lastMessageAt,
    }));
  }

  /** Get all contacts as agent-friendly summaries. */
  getAllContacts(): ContactSummary[] {
    return this.store.getAllContacts().map((c) => ({
      username: c.friendUsername,
      displayName: c.friendDisplayName,
      accountType: c.friendAccountType,
    }));
  }

  /** Get recent cached messages for a conversation, sorted oldest-first. */
  getRecentMessages(conversationId: string): readonly IncomingMessage[] {
    return this.store.getRecentMessages(conversationId);
  }

  /** Get the backend session ID for a conversation, if known. */
  getSessionId(conversationId: string): string | undefined {
    return this.store.getSessionId(conversationId);
  }

  /**
   * Resolve the backend session ID for a conversation.
   * Returns the cached session ID if known, otherwise falls back to conversationId.
   */
  resolveSessionId(conversationId: string): string {
    return this.store.getSessionId(conversationId) ?? conversationId;
  }

  /** Get members of a conversation as agent-friendly summaries. */
  async getMembers(conversationId: string): Promise<MemberSummary[]> {
    const members = await this.getMembersRaw(conversationId);
    return members.map((m) => {
      const contact = this.store.getContact(m.userId);
      const isSelf = m.userId === this.identity.userId;
      return {
        username: isSelf ? this.identity.username : contact?.friendUsername,
        displayName: isSelf ? this.identity.displayName : contact?.friendDisplayName,
        accountType: m.accountType,
        role: m.role,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Conversation helpers
  // ---------------------------------------------------------------------------

  /** Find or create a DM by username. */
  async findOrCreateDmByUsername(username: string): Promise<string> {
    const userId = await this.resolveUsername(username);
    return this.findOrCreateDm(userId);
  }

  /** Find an existing DM with a user, or create one. */
  private async findOrCreateDm(userId: string): Promise<string> {
    for (const conv of this.store.getAllConversations()) {
      if (conv.type === 'dm') {
        const members = await this.getMembersRaw(conv.conversationId);
        if (members.some((m) => m.userId === userId)) {
          return conv.conversationId;
        }
      }
    }
    const resp = await this.client.createConversation({
      type: 'dm' as ConversationType,
      memberIds: [userId],
    });
    this.store.setConversation({
      conversationId: resp.conversationId,
      type: resp.type,
      name: resp.name,
      lastMessageAt: resp.lastMessageAt,
    });
    this.store.setMembers(resp.conversationId, resp.members);
    return resp.conversationId;
  }

  /** Create a group conversation. */
  async createGroup(name: string, memberUsernames: readonly string[]): Promise<string> {
    const memberIds = await Promise.all(memberUsernames.map((u) => this.resolveUsername(u)));
    const resp = await this.client.createConversation({
      type: 'group',
      name,
      memberIds,
    });
    this.store.setConversation({
      conversationId: resp.conversationId,
      type: resp.type,
      name: resp.name,
      lastMessageAt: resp.lastMessageAt,
    });
    this.store.setMembers(resp.conversationId, resp.members);
    return resp.conversationId;
  }

  /** Create a work session (temp_group) conversation. */
  async createWorkSession(name: string, memberUsernames: readonly string[]): Promise<string> {
    const memberIds = await Promise.all(memberUsernames.map((u) => this.resolveUsername(u)));
    const resp = await this.client.createConversation({
      type: 'temp_group',
      name,
      memberIds,
    });
    this.store.setConversation({
      conversationId: resp.conversationId,
      type: resp.type,
      name: resp.name,
      lastMessageAt: resp.lastMessageAt,
    });
    this.store.setMembers(resp.conversationId, resp.members);
    return resp.conversationId;
  }

  // ---------------------------------------------------------------------------
  // System prompt
  // ---------------------------------------------------------------------------

  /** Build Newio-specific instructions describing the agent's identity and messaging context. */
  buildNewioInstruction(opts?: { customInstructions?: string }): string {
    const ownerContact = this.identity.ownerId ? this.store.getContact(this.identity.ownerId) : undefined;
    return buildNewioInstruction(this.identity, ownerContact, opts);
  }

  /** Get the owner's display name, if the owner is in contacts. */
  getOwnerDisplayName(): string | undefined {
    const owner = this.identity.ownerId ? this.store.getContact(this.identity.ownerId) : undefined;
    return owner?.friendDisplayName ?? owner?.friendUsername;
  }

  // ---------------------------------------------------------------------------
  // Internal — data loading
  // ---------------------------------------------------------------------------

  private async loadData(): Promise<void> {
    await Promise.all([this.loadContacts(), this.loadConversations(), this.loadIncomingRequests()]);
  }

  private async loadContacts(): Promise<void> {
    let cursor: string | undefined;
    do {
      const resp = await this.client.listFriends({ cursor, limit: 100 });
      for (const contact of resp.contacts) {
        this.store.indexContact(contact);
      }
      cursor = resp.cursor;
    } while (cursor);
  }

  private async loadConversations(): Promise<void> {
    let cursor: string | undefined;
    do {
      const resp = await this.client.listConversations({ cursor, limit: 100 });
      for (const conv of resp.conversations) {
        this.store.setConversation(conv);
      }
      cursor = resp.cursor;
    } while (cursor);
  }

  private async loadIncomingRequests(): Promise<void> {
    let cursor: string | undefined;
    do {
      const resp = await this.client.listIncomingRequests({ cursor, limit: 100 });
      for (const r of resp.requests) {
        this.store.addIncomingRequest(r);
      }
      cursor = resp.cursor;
    } while (cursor);
  }

  // ---------------------------------------------------------------------------
  // Internal — data fetching
  // ---------------------------------------------------------------------------

  private async getMembersRaw(conversationId: string): Promise<MemberRecord[]> {
    const cached = this.store.getMembers(conversationId);
    if (cached) {
      return [...cached.values()];
    }
    const resp = await this.client.getConversation({ conversationId });
    this.store.setMembers(conversationId, resp.members);
    return [...resp.members];
  }

  private async findIncomingRequestByUsername(username: string): Promise<ContactRecord> {
    // Try store cache first
    let match = this.store.findIncomingRequestByUsername(username);
    if (match) {
      return match;
    }
    // Backfill from API
    await this.loadIncomingRequests();
    match = this.store.findIncomingRequestByUsername(username);
    if (!match) {
      throw new Error(`No incoming friend request from @${username}`);
    }
    return match;
  }
}

// ---------------------------------------------------------------------------
// Internal — approval flow helper
// ---------------------------------------------------------------------------

async function doApprovalFlow(
  auth: AuthManager,
  opts: {
    agentId?: string;
    username?: string;
    name: string;
    onApprovalUrl?: (url: string) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  let handle: ApprovalHandle;
  if (opts.agentId) {
    handle = await auth.login({ agentId: opts.agentId });
  } else if (opts.username) {
    handle = await auth.login({ username: opts.username });
  } else {
    handle = await auth.register({ name: opts.name });
  }
  opts.onApprovalUrl?.(handle.approvalUrl);
  await handle.waitForApproval({ signal: opts.signal });
}
