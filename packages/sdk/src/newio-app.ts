/**
 * NewioApp — high-level abstraction over the Newio SDK.
 *
 * Owns the full Newio lifecycle: auth, HTTP client, WebSocket connection.
 * Caches contacts and conversations, provides username-based lookups,
 * tracks sequenceNumbers, builds system prompts, and exposes a clean event interface.
 *
 * Used by the Agent Connector, MCP server, and standalone agent implementations.
 */
import { AuthManager } from './auth.js';
import { NewioClient } from './client.js';
import { NewioWebSocket } from './websocket.js';
import type { WebSocketFactory } from './websocket.js';
import type { ApprovalHandle } from './auth.js';
import type {
  AccountType,
  NotifyLevel,
  ActivityStatus,
  Attachment,
  ContactRecord,
  ConversationListItem,
  MemberRecord,
  MessageContent,
  MessageRecord,
  ConversationType,
} from './types.js';
import type { MessageNewEvent } from './events.js';

/** Default Newio REST API base URL. */
export const NEWIO_API_BASE_URL = 'https://api.conduit.qinnan.dev';

/** Default Newio WebSocket URL. */
export const NEWIO_WS_URL = 'wss://ws.conduit.qinnan.dev';

/** How long received messages are kept in the cache (ms). */
const MESSAGE_CACHE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A processed incoming message with sender metadata resolved from caches. */
export interface IncomingMessage {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationType: string;
  readonly groupName?: string;
  readonly senderUserId: string;
  readonly senderUsername?: string;
  readonly senderDisplayName?: string;
  readonly senderAccountType?: AccountType;
  readonly inContact: boolean;
  readonly isOwnMessage: boolean;
  readonly text: string;
  readonly timestamp: string;
}

/** Callback for incoming messages. */
export type MessageHandler = (message: IncomingMessage) => void;

/** The agent's Newio identity (populated after auth). */
export interface NewioIdentity {
  readonly userId: string;
  readonly username: string;
  readonly displayName?: string;
  readonly ownerId?: string;
}

/** Tokens returned after auth. */
export interface NewioTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

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
}

// ---------------------------------------------------------------------------
// NewioApp
// ---------------------------------------------------------------------------

/**
 * High-level Newio agent client.
 *
 * Wraps {@link AuthManager}, {@link NewioClient}, and {@link NewioWebSocket}
 * into a single object with caching, username resolution, sequence tracking,
 * and system prompt generation.
 */
export class NewioApp {
  readonly identity: NewioIdentity;
  readonly client: NewioClient;
  readonly auth: AuthManager;
  private readonly ws: NewioWebSocket;

  /** contactId → ContactRecord */
  private readonly contacts = new Map<string, ContactRecord>();
  /** username (lowercase) → contactId */
  private readonly usernameToContactId = new Map<string, string>();
  /** conversationId → ConversationListItem */
  private readonly conversations = new Map<string, ConversationListItem>();
  /** conversationId → MemberRecord[] (lazily populated) */
  private readonly conversationMembers = new Map<string, Map<string, MemberRecord>>();
  /** conversationId → next sequenceNumber */
  private readonly sequenceNumbers = new Map<string, number>();
  /** conversationId → notification preference (missing = 'all') */
  private readonly notifyLevels = new Map<string, NotifyLevel>();
  /** conversationId → backend session ID (for agent members) */
  private readonly sessionIds = new Map<string, string>();

  /** conversationId → ULID-sorted message list (recent cache, evicted by TTL) */
  private readonly messageCache = new Map<string, IncomingMessage[]>();

  private messageHandler: MessageHandler | null = null;

  /** Directory for downloaded attachments. */
  private readonly downloadDir: string;

  private constructor(
    identity: NewioIdentity,
    auth: AuthManager,
    client: NewioClient,
    ws: NewioWebSocket,
    downloadDir?: string,
  ) {
    this.identity = identity;
    this.auth = auth;
    this.client = client;
    this.ws = ws;
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
  ): Promise<NewioApp> {
    const app = new NewioApp(identity, auth, client, ws);
    await app.loadData();
    app.wireEvents();
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

    const app = new NewioApp(identity, auth, client, ws, opts.downloadDir);
    await app.loadData();
    app.wireEvents();
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

  /** Set the handler for incoming messages. */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /** Send a text message to a conversation. */
  async sendMessage(conversationId: string, text: string): Promise<void> {
    const seq = this.nextSequenceNumber(conversationId);
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
    const attachments = filePaths ? await this.uploadFiles(filePaths) : undefined;
    const content: MessageContent = {
      text: text || undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    };
    const seq = this.nextSequenceNumber(conversationId);
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

  /** List incoming friend requests with username info. */
  async listIncomingFriendRequests(): Promise<readonly ContactRecord[]> {
    const all: ContactRecord[] = [];
    let cursor: string | undefined;
    do {
      const resp = await this.client.listIncomingRequests({ cursor, limit: 100 });
      all.push(...resp.requests);
      cursor = resp.cursor;
    } while (cursor);
    return all;
  }

  /** Accept an incoming friend request by the sender's username. */
  async acceptFriendRequestByUsername(username: string): Promise<void> {
    const request = await this.findIncomingRequestByUsername(username);
    await this.client.acceptFriendRequest({ requestId: request.contactId });
    this.indexContact(request);
  }

  /** Reject an incoming friend request by the sender's username. */
  async rejectFriendRequestByUsername(username: string): Promise<void> {
    const request = await this.findIncomingRequestByUsername(username);
    await this.client.rejectFriendRequest({ requestId: request.contactId });
  }

  /** Remove a friend by username. */
  async removeFriendByUsername(username: string): Promise<void> {
    const userId = await this.resolveUsername(username);
    await this.client.removeFriend({ userId });
    this.removeContact(userId);
  }

  // ---------------------------------------------------------------------------
  // Media — local file management
  // ---------------------------------------------------------------------------

  /**
   * Download a message attachment to a local directory.
   * Files are organized as: `<downloadDir>/<conversationId>/<fileName>`
   * Returns the local file path.
   */
  async downloadAttachment(conversationId: string, s3Key: string, fileName: string): Promise<string> {
    const fsPromises = await import('fs/promises');
    const pathMod = await import('path');

    const dir = pathMod.join(this.downloadDir, conversationId);
    await fsPromises.mkdir(dir, { recursive: true });

    const { url } = await this.client.getDownloadUrl({ conversationId, s3Key });
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Download failed: ${String(resp.status)}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    const filePath = pathMod.join(dir, fileName);
    await fsPromises.writeFile(filePath, buffer);
    return filePath;
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  /** Resolve a username to a userId. Checks contact cache first, then API. */
  async resolveUsername(username: string): Promise<string> {
    const contactId = this.usernameToContactId.get(username.toLowerCase());
    if (contactId) {
      return contactId;
    }
    const user = await this.client.getUserByUsername({ username });
    return user.userId;
  }

  /** Check if a userId is in the contact (friend) list. */
  isContact(userId: string): boolean {
    return this.contacts.has(userId);
  }

  /** Get a contact by userId. */
  getContact(userId: string): ContactRecord | undefined {
    return this.contacts.get(userId);
  }

  /** Get a conversation by ID. */
  getConversation(conversationId: string): ConversationListItem | undefined {
    return this.conversations.get(conversationId);
  }

  /** Get all conversations. */
  getAllConversations(): ConversationListItem[] {
    return [...this.conversations.values()];
  }

  /** Get all contacts. */
  getAllContacts(): ContactRecord[] {
    return [...this.contacts.values()];
  }

  /** Get recent cached messages for a conversation, sorted oldest-first. */
  getRecentMessages(conversationId: string): readonly IncomingMessage[] {
    const messages = this.messageCache.get(conversationId);
    if (!messages) {
      return [];
    }
    this.evictExpired(conversationId, messages);
    return messages;
  }

  /** Get the backend session ID for a conversation, if known. */
  getSessionId(conversationId: string): string | undefined {
    return this.sessionIds.get(conversationId);
  }

  /**
   * Resolve the backend session ID for a conversation.
   * Returns the cached session ID if known, otherwise falls back to conversationId.
   */
  resolveSessionId(conversationId: string): string {
    return this.sessionIds.get(conversationId) ?? conversationId;
  }

  /** Get members of a conversation (fetches from API if not cached). */
  async getMembers(conversationId: string): Promise<MemberRecord[]> {
    const cached = this.conversationMembers.get(conversationId);
    if (cached) {
      return [...cached.values()];
    }
    const resp = await this.client.getConversation({ conversationId });
    this.setMembers(conversationId, resp.members);
    return [...resp.members];
  }

  // ---------------------------------------------------------------------------
  // Conversation helpers
  // ---------------------------------------------------------------------------

  /** Find an existing DM with a user, or create one. */
  async findOrCreateDm(userId: string): Promise<string> {
    for (const conv of this.conversations.values()) {
      if (conv.type === 'dm') {
        const members = await this.getMembers(conv.conversationId);
        if (members.some((m) => m.userId === userId)) {
          return conv.conversationId;
        }
      }
    }
    const resp = await this.client.createConversation({
      type: 'dm' as ConversationType,
      memberIds: [userId],
    });
    this.conversations.set(resp.conversationId, {
      conversationId: resp.conversationId,
      type: resp.type,
      name: resp.name,
      lastMessageAt: resp.lastMessageAt,
    });
    this.setMembers(resp.conversationId, resp.members);
    return resp.conversationId;
  }

  /** Create a group conversation. */
  async createGroup(name: string, memberUsernames: readonly string[]): Promise<string> {
    const memberIds = await Promise.all(memberUsernames.map((u) => this.resolveUsername(u)));
    const resp = await this.client.createConversation({
      type: 'group' as ConversationType,
      name,
      memberIds,
    });
    this.conversations.set(resp.conversationId, {
      conversationId: resp.conversationId,
      type: resp.type,
      name: resp.name,
      lastMessageAt: resp.lastMessageAt,
    });
    this.setMembers(resp.conversationId, resp.members);
    return resp.conversationId;
  }

  // ---------------------------------------------------------------------------
  // System prompt
  // ---------------------------------------------------------------------------

  /** Build Newio-specific instructions describing the agent's identity and messaging context. */
  buildNewioInstruction(opts?: { customInstructions?: string }): string {
    const { username, displayName } = this.identity;
    const ownerContact = this.findOwnerContact();

    const parts: string[] = [];

    parts.push(
      `You are an AI agent on a messaging platform. Your username is "${username}"${displayName ? ` and your display name is "${displayName}"` : ''}. You receive messages from multiple conversations — both direct messages and group chats. Each message batch you receive is from a single conversation.`,
    );

    if (ownerContact) {
      const ownerName = ownerContact.friendDisplayName ?? ownerContact.friendUsername ?? 'Unknown';
      const ownerUsername = ownerContact.friendUsername ?? 'unknown';
      parts.push(
        `Your owner is "${ownerName}" (username: "${ownerUsername}"). Treat messages from your owner with priority.`,
      );
    }

    parts.push(`Messages arrive as YAML. Each sender has a username, display name, account type (human or agent), and whether they are in your contacts.

DM example:
  conversationId: abc-123
  type: dm
  from:
    username: alice
    displayName: Alice
    accountType: human
    inContact: true
  messages:
    - message: Hey, how are you?
      timestamp: "2026-03-17T22:55:41Z"

Group example:
  conversationId: def-456
  type: group
  groupName: Team Chat
  messages:
    - from:
        username: bob
        displayName: Bob
        accountType: human
        inContact: true
      message: Meeting at 3?
      timestamp: "2026-03-17T23:01:02Z"
    - from:
        username: helper_bot
        displayName: Helper Bot
        accountType: agent
        inContact: false
      message: I can help schedule that
      timestamp: "2026-03-17T23:01:15Z"

Response rules:
- Reply with plain text or markdown — the messaging app renders markdown.
- If no reply is needed, respond with exactly: _skip
- In group chats, only respond when addressed or when you have something relevant to add.
- Be concise and natural.`);

    if (opts?.customInstructions) {
      parts.push(opts.customInstructions);
    }

    return parts.join('\n\n');
  }

  /** Get the owner's display name, if the owner is in contacts. */
  getOwnerDisplayName(): string | undefined {
    const owner = this.findOwnerContact();
    return owner?.friendDisplayName ?? owner?.friendUsername;
  }

  // ---------------------------------------------------------------------------
  // Internal — owner lookup
  // ---------------------------------------------------------------------------

  private findOwnerContact(): ContactRecord | undefined {
    const ownerId = this.identity.ownerId;
    if (!ownerId) {
      return undefined;
    }
    return this.contacts.get(ownerId);
  }

  // ---------------------------------------------------------------------------
  // Internal — data loading
  // ---------------------------------------------------------------------------

  private async loadData(): Promise<void> {
    await Promise.all([this.loadContacts(), this.loadConversations()]);
  }

  private async loadContacts(): Promise<void> {
    let cursor: string | undefined;
    do {
      const resp = await this.client.listFriends({ cursor, limit: 100 });
      for (const contact of resp.contacts) {
        this.indexContact(contact);
      }
      cursor = resp.cursor;
    } while (cursor);
  }

  private async loadConversations(): Promise<void> {
    let cursor: string | undefined;
    do {
      const resp = await this.client.listConversations({ cursor, limit: 100 });
      for (const conv of resp.conversations) {
        this.conversations.set(conv.conversationId, conv);
        if (conv.notifyLevel) {
          this.notifyLevels.set(conv.conversationId, conv.notifyLevel);
        }
        if (conv.sessionId) {
          this.sessionIds.set(conv.conversationId, conv.sessionId);
        }
      }
      cursor = resp.cursor;
    } while (cursor);
  }

  private async loadConversation(conversationId: string): Promise<void> {
    try {
      const conv = await this.client.getConversation({ conversationId });
      this.conversations.set(conversationId, {
        conversationId: conv.conversationId,
        type: conv.type,
        name: conv.name,
        description: conv.description,
        avatarUrl: conv.avatarUrl,
        lastMessageAt: conv.lastMessageAt,
      });
      this.setMembers(conversationId, conv.members);

      const self = conv.members.find((m) => m.userId === this.identity.userId);
      if (self) {
        if (self.notifyLevel) {
          this.notifyLevels.set(conversationId, self.notifyLevel);
        }
        if (self.sessionId) {
          this.sessionIds.set(conversationId, self.sessionId);
        }
      }
    } catch {
      // Failed to load conversation — non-fatal
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — contact indexing
  // ---------------------------------------------------------------------------

  private indexContact(contact: ContactRecord): void {
    this.contacts.set(contact.contactId, contact);
    if (contact.friendUsername) {
      this.usernameToContactId.set(contact.friendUsername.toLowerCase(), contact.contactId);
    }
  }

  private removeContact(contactId: string): void {
    const contact = this.contacts.get(contactId);
    if (contact?.friendUsername) {
      this.usernameToContactId.delete(contact.friendUsername.toLowerCase());
    }
    this.contacts.delete(contactId);
  }

  // ---------------------------------------------------------------------------
  // Internal — sequence numbers
  // ---------------------------------------------------------------------------

  private nextSequenceNumber(conversationId: string): number {
    const current = this.sequenceNumbers.get(conversationId) ?? -1;
    const next = current + 1;
    this.sequenceNumbers.set(conversationId, next);
    return next;
  }

  // ---------------------------------------------------------------------------
  // Internal — member cache
  // ---------------------------------------------------------------------------

  private setMembers(conversationId: string, members: readonly MemberRecord[]): void {
    this.conversationMembers.set(conversationId, new Map(members.map((m) => [m.userId, m])));
  }

  // ---------------------------------------------------------------------------
  // Internal — friend request lookup
  // ---------------------------------------------------------------------------

  private async findIncomingRequestByUsername(username: string): Promise<ContactRecord> {
    const requests = await this.listIncomingFriendRequests();
    const match = requests.find((r) => r.friendUsername?.toLowerCase() === username.toLowerCase());
    if (!match) {
      throw new Error(`No incoming friend request from @${username}`);
    }
    return match;
  }

  // ---------------------------------------------------------------------------
  // Internal — file upload
  // ---------------------------------------------------------------------------

  private async uploadFiles(filePaths: readonly string[]): Promise<Attachment[]> {
    const fsPromises = await import('fs/promises');
    const pathMod = await import('path');

    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.csv': 'text/csv',
    };

    const attachments: Attachment[] = [];
    for (const filePath of filePaths) {
      const fileName = pathMod.basename(filePath);
      const ext = pathMod.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] ?? 'application/octet-stream';
      const data = await fsPromises.readFile(filePath);
      const { s3Key } = await this.client.uploadFile({
        fileName,
        contentType,
        body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      });
      attachments.push({
        type: contentType.startsWith('image/') ? 'image' : 'file',
        s3Key,
        fileName,
        contentType,
        size: data.byteLength,
      });
    }
    return attachments;
  }

  // ---------------------------------------------------------------------------
  // Internal — WebSocket event wiring
  // ---------------------------------------------------------------------------

  private wireEvents(): void {
    this.ws.on('message.new', (event) => {
      void this.handleIncomingMessage(event.payload);
    });

    this.ws.on('conversation.new', (event) => {
      this.conversations.set(event.payload.conversationId, {
        conversationId: event.payload.conversationId,
        type: event.payload.type as ConversationType,
        name: event.payload.name,
      });
    });

    this.ws.on('conversation.updated', (event) => {
      const existing = this.conversations.get(event.payload.conversationId);
      if (existing) {
        const { changes } = event.payload;
        this.conversations.set(event.payload.conversationId, {
          ...existing,
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.description !== undefined ? { description: changes.description } : {}),
          ...(changes.avatarUrl !== undefined ? { avatarUrl: changes.avatarUrl } : {}),
          ...(changes.type ? { type: changes.type as ConversationType } : {}),
        });
      }
    });

    this.ws.on('conversation.member_added', (event) => {
      const { conversationId, members: added } = event.payload;

      const cached = this.conversationMembers.get(conversationId);
      if (cached) {
        for (const m of added) {
          cached.set(m.userId, m);
        }
      }

      const self = added.find((m) => m.userId === this.identity.userId);
      if (!self) {
        return;
      }

      if (self.sessionId) {
        this.sessionIds.set(conversationId, self.sessionId);
      }

      if (!this.conversations.has(conversationId)) {
        void this.loadConversation(conversationId);
      }
    });

    this.ws.on('conversation.member_removed', (event) => {
      const cached = this.conversationMembers.get(event.payload.conversationId);
      if (cached) {
        cached.delete(event.payload.targetUserId);
      }
      if (event.payload.targetUserId === this.identity.userId) {
        this.conversations.delete(event.payload.conversationId);
        this.conversationMembers.delete(event.payload.conversationId);
      }
    });

    this.ws.on('conversation.member_updated', (event) => {
      if (event.payload.userId !== this.identity.userId) {
        return;
      }
      if (event.payload.changes.notifyLevel) {
        this.notifyLevels.set(event.payload.conversationId, event.payload.changes.notifyLevel);
      }
      if (event.payload.changes.sessionId) {
        this.sessionIds.set(event.payload.conversationId, event.payload.changes.sessionId);
      }
    });

    this.ws.on('contact.request_accepted', (event) => {
      this.indexContact(event.payload.contact);
    });

    this.ws.on('contact.removed', (event) => {
      this.removeContact(event.payload.contactId);
    });
  }

  // ---------------------------------------------------------------------------
  // Internal — message handling
  // ---------------------------------------------------------------------------

  private toIncomingMessage(msg: MessageRecord, conversationId: string, conversationType?: string): IncomingMessage {
    const contact = this.contacts.get(msg.senderId);
    const conv = this.conversations.get(conversationId);
    const isOwnMessage = msg.senderId === this.identity.userId;
    return {
      messageId: msg.messageId,
      conversationId,
      conversationType: conversationType ?? conv?.type ?? 'dm',
      groupName: conv?.name,
      senderUserId: msg.senderId,
      senderUsername: isOwnMessage ? this.identity.username : contact?.friendUsername,
      senderDisplayName: isOwnMessage ? this.identity.displayName : contact?.friendDisplayName,
      senderAccountType: isOwnMessage ? ('agent' as AccountType) : contact?.friendAccountType,
      inContact: isOwnMessage || this.contacts.has(msg.senderId),
      isOwnMessage,
      text: msg.content.text ?? '',
      timestamp: msg.createdAt,
    };
  }

  private isMentioned(content: MessageRecord['content']): boolean {
    if (!content.mentions) {
      return false;
    }
    return !!(
      content.mentions.everyone ||
      content.mentions.here ||
      content.mentions.userIds?.includes(this.identity.userId)
    );
  }

  private async handleIncomingMessage(payload: MessageNewEvent['payload']): Promise<void> {
    const message = this.toIncomingMessage(payload, payload.conversationId, payload.conversationType);
    const inserted = this.insertMessage(payload.conversationId, message);

    const currentSeq = this.sequenceNumbers.get(payload.conversationId) ?? 0;
    const incomingSeq = payload.sequenceNumber ?? 0;
    if (incomingSeq > currentSeq) {
      this.sequenceNumbers.set(payload.conversationId, incomingSeq);
    }

    if (incomingSeq > currentSeq + 1 && currentSeq > 0) {
      const cached = this.messageCache.get(payload.conversationId);
      if (cached && cached.length > 1) {
        const prev = cached[cached.length - 2];
        if (prev) {
          await this.backfillGap(payload.conversationId, prev.messageId, payload.messageId, currentSeq);
        }
      }
    }

    if (inserted && !message.isOwnMessage) {
      const level = this.notifyLevels.get(payload.conversationId) ?? 'all';
      const shouldNotify = level === 'all' || (level === 'mentions' && this.isMentioned(payload.content));
      if (shouldNotify) {
        this.messageHandler?.(message);
      }
    }
  }

  /**
   * Insert a message into the per-conversation sorted list.
   * Scans from the end — O(1) for the common case (newest message).
   * Returns true if inserted, false if duplicate.
   */
  private insertMessage(conversationId: string, message: IncomingMessage): boolean {
    let messages = this.messageCache.get(conversationId);
    if (!messages) {
      messages = [];
      this.messageCache.set(conversationId, messages);
    }

    let i = messages.length;
    while (i > 0) {
      const prev = messages[i - 1];
      if (!prev || prev.messageId <= message.messageId) {
        break;
      }
      i--;
    }
    if (i > 0 && messages[i - 1]?.messageId === message.messageId) {
      return false;
    }
    messages.splice(i, 0, message);

    this.evictExpired(conversationId, messages);
    return true;
  }

  private evictExpired(conversationId: string, messages: IncomingMessage[]): void {
    const cutoff = Date.now() - MESSAGE_CACHE_TTL_MS;
    let evictCount = 0;
    while (evictCount < messages.length) {
      const msg = messages[evictCount];
      if (!msg || new Date(msg.timestamp).getTime() >= cutoff) {
        break;
      }
      evictCount++;
    }
    if (evictCount > 0) {
      messages.splice(0, evictCount);
    }
    if (messages.length === 0) {
      this.messageCache.delete(conversationId);
    }
  }

  private async backfillGap(
    conversationId: string,
    afterMessageId: string,
    beforeMessageId: string,
    rollbackSeq: number,
  ): Promise<void> {
    try {
      let cursor: string | undefined;
      do {
        const resp = await this.client.listMessages({
          conversationId,
          afterMessageId,
          beforeMessageId,
          limit: 50,
          cursor,
        });
        if (resp.messages.length === 0) {
          break;
        }
        for (const msg of resp.messages) {
          const message = this.toIncomingMessage(msg, conversationId);
          const inserted = this.insertMessage(conversationId, message);
          if (inserted && !message.isOwnMessage) {
            this.messageHandler?.(message);
          }
        }
        cursor = resp.cursor;
      } while (cursor);
    } catch {
      this.sequenceNumbers.set(conversationId, rollbackSeq);
    }
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
