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
import { NewioError } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import { ActivityThrottle } from '../core/activity-throttle.js';
import { NewioAppStore } from './store.js';
import { wireEvents } from './events.js';
import { buildNewioInstruction } from './prompt.js';
import { uploadFiles, downloadAttachment } from './media.js';
import type { WebSocketFactory } from '../core/websocket.js';
import type { ApprovalHandle } from '../core/auth.js';
import type { StorePersistence } from './store.js';
import type {
  ActivityStatus,
  ContactRecord,
  MemberRecord,
  Mentions,
  MessageContent,
  ConversationType,
} from '../core/types.js';
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

const log = getLogger('newio-app');

/** Extract all @username tokens from a message (preceded by whitespace or start-of-line). */
const MENTION_EXTRACT_RE = /(?:^|[\s])@([a-zA-Z][a-zA-Z0-9]*)/g;

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
  /** Called each time a poll request is made during approval. */
  readonly onPollAttempt?: () => void;
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
  private readonly activityThrottle: ActivityThrottle;

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
    this.activityThrottle = new ActivityThrottle((conversationId, status) => {
      this.ws.sendActivity(conversationId, status);
    });
  }

  /**
   * Create a NewioApp from pre-initialized components (for testing).
   * Loads contacts/conversations and wires WebSocket events.
   */
  static createFromComponents(
    identity: NewioIdentity,
    auth: AuthManager,
    client: NewioClient,
    ws: NewioWebSocket,
    store?: NewioAppStore,
  ): NewioApp {
    const app = new NewioApp(identity, auth, client, ws, store ?? new NewioAppStore());
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
      log.info('Attempting token reuse...');
      auth.setTokens(opts.tokens.accessToken, opts.tokens.refreshToken);
      try {
        await auth.forceRefresh();
        log.info('Token reuse successful.');
      } catch {
        log.info('Token reuse failed — starting approval flow.');
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
    log.info('Fetching agent profile...');
    const me = await client.getMe({});
    if (!me.username) {
      throw new Error('Agent account has no username. Registration may have failed.');
    }

    const identity: NewioIdentity = {
      userId: me.userId,
      username: me.username,
      displayName: me.displayName,
      avatarUrl: me.avatarUrl,
      ownerId: me.ownerId,
    };
    log.info(`Authenticated as @${identity.username} (${identity.userId}).`);

    // Connect WebSocket
    const ws = new NewioWebSocket({
      url: opts.wsUrl,
      tokenProvider: auth.tokenProvider,
      wsFactory: opts.wsFactory,
    });
    await ws.connect();

    const store = new NewioAppStore(opts.persistence);
    const app = new NewioApp(identity, auth, client, ws, store, opts.downloadDir);
    wireEvents(ws, store, client, identity, () => app.eventHandlers);
    return app;
  }

  async init(): Promise<void> {
    log.info('Loading initial data (contacts, conversations, requests)...');
    await Promise.all([this.loadContacts(), this.loadConversations(), this.loadIncomingRequests()]);
    log.info(
      `Init complete. ${this.store.getAllContacts().length} contacts, ${this.store.getAllConversations().length} conversations, ${this.store.getIncomingRequests().length} incoming requests.`,
    );
  }

  /** Disconnect WebSocket and dispose auth. */
  dispose(): void {
    log.info('Disposing NewioApp...');
    this.activityThrottle.dispose();
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

  /** Send a message to a conversation, with optional file attachments. */
  async sendMessage(conversationId: string, text: string, filePaths?: readonly string[]): Promise<void> {
    log.debug(`Sending message to ${conversationId} (${text.length} chars, ${filePaths?.length ?? 0} attachments)`);
    const attachments = filePaths ? await uploadFiles(this.client, filePaths) : undefined;
    const mentions = text ? await this.buildMentions(conversationId, text) : undefined;
    const content: MessageContent = {
      text: text || undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      ...(mentions ? { mentions } : {}),
    };
    await this.client.sendMessage({ conversationId, content });
  }

  /**
   * Set the agent's activity status for a conversation.
   * Broadcasts typing/thinking indicators to other participants via WebSocket.
   * Throttled: duplicate statuses are suppressed, heartbeats keep the receiver alive.
   */
  setStatus(status: ActivityStatus, conversationId?: string): void {
    // log.debug('setStatus called', { status, conversationId });
    if (conversationId) {
      this.activityThrottle.update(conversationId, status);
    }
  }

  /** Send a DM to the agent's owner. No-op if ownerId is not set. */
  async dmOwner(text: string, filePaths?: readonly string[]): Promise<void> {
    if (!this.identity.ownerId) {
      log.warn('dmOwner called but no ownerId set');
      return;
    }
    log.debug(`Sending DM to owner ${this.identity.ownerId}`);
    const conversationId = await this.findOrCreateDm(this.identity.ownerId);
    await this.sendMessage(conversationId, text, filePaths);
  }

  /** Get or create the DM conversation with the agent's owner. Returns undefined if no owner. */
  async getOwnerDmConversationId(): Promise<string | undefined> {
    if (!this.identity.ownerId) {
      return undefined;
    }
    return this.findOrCreateDm(this.identity.ownerId);
  }

  /** Send a DM by username. Creates the DM conversation if it doesn't exist. */
  async sendDm(username: string, text: string, filePaths?: readonly string[]): Promise<void> {
    log.debug(`Sending DM to @${username}`);
    const userId = await this.resolveUsername(username);
    const conversationId = await this.findOrCreateDm(userId);
    await this.sendMessage(conversationId, text, filePaths);
  }

  // ---------------------------------------------------------------------------
  // Contacts — high-level (username-based)
  // ---------------------------------------------------------------------------

  /** Send a friend request by username. */
  async sendFriendRequestByUsername(username: string, note?: string): Promise<void> {
    log.info(`Sending friend request to @${username}`);
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
    log.info(`Accepting friend request from @${username}`);
    const request = await this.findIncomingRequestByUsername(username);
    await this.client.acceptFriendRequest({ requestId: request.contactId });
    this.store.removeIncomingRequest(request.contactId);
    this.store.indexContact(request);
  }

  /** Reject an incoming friend request by the sender's username. */
  async rejectFriendRequestByUsername(username: string): Promise<void> {
    log.info(`Rejecting friend request from @${username}`);
    const request = await this.findIncomingRequestByUsername(username);
    await this.client.rejectFriendRequest({ requestId: request.contactId });
    this.store.removeIncomingRequest(request.contactId);
  }

  /** Remove a friend by username. */
  async removeFriendByUsername(username: string): Promise<void> {
    log.info(`Removing friend @${username}`);
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
    log.debug(`Downloading attachment ${fileName} from ${conversationId}`);
    return downloadAttachment(this.client, this.downloadDir, conversationId, s3Key, fileName);
  }

  // ---------------------------------------------------------------------------
  // Lookups (delegate to store, fallback to API)
  // ---------------------------------------------------------------------------

  /** Resolve a username to a userId. Checks contact cache first, then API. */
  async resolveUsername(username: string): Promise<string> {
    const cached = this.store.resolveUsernameFromCache(username);
    if (cached) {
      log.debug(`Resolved @${username} → ${cached} (cache)`);
      return cached;
    }
    const user = await this.client.getUserByUsername({ username });
    log.debug(`Resolved @${username} → ${user.userId} (API)`);
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
    return this.toContactSummary(c);
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
    return this.store.getAllContacts().map((c) => this.toContactSummary(c));
  }

  /** Get recent cached messages for a conversation, sorted oldest-first. */
  getRecentMessages(conversationId: string): readonly IncomingMessage[] {
    return this.store.getRecentMessages(conversationId);
  }

  /** Get the backend session ID for a conversation, if known. */
  getSessionId(conversationId: string): string | undefined {
    return this.store.getSessionId(conversationId);
  }

  private toContactSummary(c: ContactRecord): ContactSummary {
    const owner = c.friendAccountType === 'agent' && c.ownerId ? this.store.getOwnerProfile(c.ownerId) : undefined;
    return {
      username: c.friendUsername,
      displayName: c.friendDisplayName,
      accountType: c.friendAccountType,
      ...(owner?.username ? { ownerUsername: owner.username } : {}),
      ...(owner?.displayName ? { ownerDisplayName: owner.displayName } : {}),
    };
  }

  /**
   * Resolve the backend session ID for a conversation.
   * Returns the cached session ID if known, otherwise fetches from the backend.
   * Throws if no session ID exists for this conversation.
   */
  async resolveSessionId(conversationId: string): Promise<string> {
    const cached = this.store.getSessionId(conversationId);
    if (cached) {
      log.debug(`Resolved sessionId for ${conversationId} → ${cached} (cache)`);
      return cached;
    }
    log.debug(`Fetching sessionId for ${conversationId} from API`);
    const conv = await this.client.getConversation({ conversationId });
    const self = conv.members.find((m) => m.userId === this.identity.userId);
    if (self?.sessionId) {
      this.store.setSessionId(conversationId, self.sessionId);
      return self.sessionId;
    }
    throw new NewioError(`No session ID found for conversation ${conversationId}`);
  }

  /** Get members of a conversation as agent-friendly summaries. */
  async getMembers(conversationId: string): Promise<MemberSummary[]> {
    log.debug(`Getting members for ${conversationId}`);
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
  private async findOrCreateDmByUsername(username: string): Promise<string> {
    log.debug(`Finding or creating DM with @${username}`);
    const userId = await this.resolveUsername(username);
    return this.findOrCreateDm(userId);
  }

  /** Find an existing DM with a user, or create one. */
  private async findOrCreateDm(userId: string): Promise<string> {
    log.debug(`Finding or creating DM with ${userId}`);
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
      createdBy: resp.createdBy,
      createdAt: resp.createdAt,
      updatedAt: resp.updatedAt,
      lastMessageAt: resp.lastMessageAt,
    });
    this.store.setMembers(resp.conversationId, resp.members);
    return resp.conversationId;
  }

  /** Create a group conversation. If `sessionId` is provided, the agent joins under that session. */
  async createGroup(name: string, memberUsernames: readonly string[], sessionId?: string): Promise<string> {
    const filtered = memberUsernames.filter((u) => u.toLowerCase() !== this.identity.username.toLowerCase());
    log.info(`Creating group "${name}" with ${filtered.length} members`);
    const memberIds = await Promise.all(filtered.map((u) => this.resolveUsername(u)));
    const agentSettings = sessionId ? { [this.identity.userId]: { sessionId } } : undefined;
    const resp = await this.client.createConversation({
      type: 'group',
      name,
      memberIds,
      agentSettings,
    });
    this.store.setConversation({
      conversationId: resp.conversationId,
      type: resp.type,
      name: resp.name,
      createdBy: resp.createdBy,
      createdAt: resp.createdAt,
      updatedAt: resp.updatedAt,
      lastMessageAt: resp.lastMessageAt,
    });
    this.store.setMembers(resp.conversationId, resp.members);
    return resp.conversationId;
  }

  /** Create a work session (temp_group) conversation. If `sessionId` is provided, the agent joins under that session. */
  async createWorkSession(name: string, memberUsernames: readonly string[], sessionId?: string): Promise<string> {
    const filtered = memberUsernames.filter((u) => u.toLowerCase() !== this.identity.username.toLowerCase());
    log.info(`Creating work session "${name}" with ${filtered.length} members`);
    const memberIds = await Promise.all(filtered.map((u) => this.resolveUsername(u)));
    const agentSettings = sessionId ? { [this.identity.userId]: { sessionId } } : undefined;
    const resp = await this.client.createConversation({
      type: 'temp_group',
      name,
      memberIds,
      agentSettings,
    });
    this.store.setConversation({
      conversationId: resp.conversationId,
      type: resp.type,
      name: resp.name,
      createdBy: resp.createdBy,
      createdAt: resp.createdAt,
      updatedAt: resp.updatedAt,
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

  private async loadContacts(): Promise<void> {
    let cursor: string | undefined;
    do {
      const resp = await this.client.listFriends({ cursor, limit: 100 });
      for (const contact of resp.contacts) {
        this.store.indexContact(contact);
      }
      cursor = resp.cursor;
    } while (cursor);

    await this.resolveOwnerProfiles();
  }

  /** Batch-fetch owner profiles for agent contacts whose owners aren't in the contact cache. */
  private async resolveOwnerProfiles(): Promise<void> {
    const missingOwnerIds: string[] = [];
    for (const contact of this.store.getAllContacts()) {
      if (contact.friendAccountType !== 'agent' || !contact.ownerId) {
        continue;
      }
      const ownerId = contact.ownerId;
      // Try resolving from contact cache first
      const cached = this.store.getContact(ownerId);
      if (cached) {
        this.store.setOwnerProfile(ownerId, { username: cached.friendUsername, displayName: cached.friendDisplayName });
      } else if (!this.store.getOwnerProfile(ownerId)) {
        missingOwnerIds.push(ownerId);
      }
    }

    if (missingOwnerIds.length === 0) {
      return;
    }

    const unique = [...new Set(missingOwnerIds)];
    // Batch in chunks of 25 (API limit)
    for (let i = 0; i < unique.length; i += 25) {
      const batch = unique.slice(i, i + 25);
      const resp = await this.client.getUserSummaries({ userIds: batch });
      for (const user of resp.users) {
        this.store.setOwnerProfile(user.userId, { username: user.username, displayName: user.displayName });
      }
    }
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
      for (const r of resp.contacts) {
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

  /** Parse @username, @everyone, @here from text and resolve to a Mentions object. */
  private async buildMentions(conversationId: string, text: string): Promise<Mentions | undefined> {
    const everyone = /(?:^|[\s])@everyone\b/.test(text);
    const here = /(?:^|[\s])@here\b/.test(text);

    const members = await this.getMembersRaw(conversationId);
    const usernameToUserId = new Map<string, string>();
    for (const m of members) {
      if (m.username) {
        usernameToUserId.set(m.username.toLowerCase(), m.userId);
      }
    }

    const userIds: string[] = [];
    for (const match of text.matchAll(MENTION_EXTRACT_RE)) {
      const name = match[1]?.toLowerCase();
      if (!name || name === 'everyone' || name === 'here') {
        continue;
      }
      const userId = usernameToUserId.get(name);
      if (userId && !userIds.includes(userId)) {
        userIds.push(userId);
      }
    }

    if (!everyone && !here && userIds.length === 0) {
      return undefined;
    }
    return {
      ...(userIds.length > 0 ? { userIds } : {}),
      ...(everyone ? { everyone: true } : {}),
      ...(here ? { here: true } : {}),
    };
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
    onPollAttempt?: () => void;
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
  await handle.waitForApproval({ signal: opts.signal, onPollAttempt: opts.onPollAttempt });
}
