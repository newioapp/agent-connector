/**
 * NewioApp — high-level abstraction over the Newio SDK.
 *
 * Owns the full Newio lifecycle: auth, HTTP client, WebSocket connection.
 * Caches contacts and conversations, provides username-based lookups,
 * tracks sequenceNumbers, builds system prompts, and exposes a clean event interface.
 * Used by both the Claude adapter and the future MCP server.
 */
import { AuthManager, NewioClient, NewioWebSocket } from '@newio/sdk';
import type { ApprovalHandle, AccountType } from '@newio/sdk';
import type { ContactRecord, ConversationListItem, MemberRecord, MessageRecord, ConversationType } from '@newio/sdk';
import WebSocket from 'ws';

const API_BASE_URL = 'https://api.conduit.qinnan.dev';
const WS_URL = 'wss://ws.conduit.qinnan.dev';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IncomingMessage {
  readonly conversationId: string;
  readonly conversationType: string;
  readonly groupName?: string;
  readonly senderUserId: string;
  readonly senderUsername?: string;
  readonly senderDisplayName?: string;
  readonly senderAccountType?: AccountType;
  readonly inContact: boolean;
  readonly text: string;
  readonly timestamp: string;
}

export type MessageHandler = (message: IncomingMessage) => void;

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

// ---------------------------------------------------------------------------
// NewioApp
// ---------------------------------------------------------------------------

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
  private readonly conversationMembers = new Map<string, MemberRecord[]>();
  /** conversationId → next sequenceNumber */
  private readonly sequenceNumbers = new Map<string, number>();

  private messageHandler: MessageHandler | null = null;

  private constructor(identity: NewioIdentity, auth: AuthManager, client: NewioClient, ws: NewioWebSocket) {
    this.identity = identity;
    this.auth = auth;
    this.client = client;
    this.ws = ws;
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
  static async create(opts: {
    agentId?: string;
    username?: string;
    name: string;
    tokens?: NewioTokens;
    onApprovalUrl?: (url: string) => void;
    onTokens?: (tokens: NewioTokens) => void;
    signal?: AbortSignal;
  }): Promise<NewioApp> {
    const auth = new AuthManager(API_BASE_URL);

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
    const client = new NewioClient({ baseUrl: API_BASE_URL, tokenProvider: auth.tokenProvider });
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
      url: WS_URL,
      tokenProvider: auth.tokenProvider,
      wsFactory: (url) => new WebSocket(url) as never,
    });
    await ws.connect();

    const app = new NewioApp(identity, auth, client, ws);
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

  /** Send a DM by username. Creates the DM conversation if it doesn't exist. */
  async sendDm(username: string, text: string): Promise<void> {
    const userId = await this.resolveUsername(username);
    const conversationId = await this.findOrCreateDm(userId);
    await this.sendMessage(conversationId, text);
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

  /** Get members of a conversation (fetches from API if not cached). */
  async getMembers(conversationId: string): Promise<MemberRecord[]> {
    const cached = this.conversationMembers.get(conversationId);
    if (cached) {
      return cached;
    }
    const resp = await this.client.getConversation({ conversationId });
    this.conversationMembers.set(conversationId, [...resp.members]);
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
    this.conversations.set(resp.conversation.conversationId, {
      conversationId: resp.conversation.conversationId,
      type: resp.conversation.type,
      name: resp.conversation.name,
      lastMessageAt: resp.conversation.lastMessageAt,
    });
    this.conversationMembers.set(resp.conversation.conversationId, [...resp.members]);
    return resp.conversation.conversationId;
  }

  /** Create a group conversation. */
  async createGroup(name: string, memberUsernames: readonly string[]): Promise<string> {
    const memberIds = await Promise.all(memberUsernames.map((u) => this.resolveUsername(u)));
    const resp = await this.client.createConversation({
      type: 'group' as ConversationType,
      name,
      memberIds,
    });
    this.conversations.set(resp.conversation.conversationId, {
      conversationId: resp.conversation.conversationId,
      type: resp.conversation.type,
      name: resp.conversation.name,
      lastMessageAt: resp.conversation.lastMessageAt,
    });
    this.conversationMembers.set(resp.conversation.conversationId, [...resp.members]);
    return resp.conversation.conversationId;
  }

  // ---------------------------------------------------------------------------
  // System prompt
  // ---------------------------------------------------------------------------

  /** Build a system prompt describing the agent's identity and messaging context. */
  buildSystemPrompt(opts?: { customInstructions?: string }): string {
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

    if (opts?.customInstructions) {
      parts.push(opts.customInstructions);
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

    return parts.join('\n\n');
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
      }
      cursor = resp.cursor;
    } while (cursor);
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
    const current = this.sequenceNumbers.get(conversationId) ?? 0;
    const next = current + 1;
    this.sequenceNumbers.set(conversationId, next);
    return next;
  }

  // ---------------------------------------------------------------------------
  // Internal — WebSocket event wiring
  // ---------------------------------------------------------------------------

  private wireEvents(): void {
    this.ws.on('message.new', (event) => {
      this.handleIncomingMessage(event.payload);
    });

    this.ws.on('conversation.new', (event) => {
      this.conversations.set(event.payload.conversationId, event.payload);
    });

    this.ws.on('conversation.updated', (event) => {
      const existing = this.conversations.get(event.payload.conversationId);
      if (existing) {
        this.conversations.set(event.payload.conversationId, {
          ...existing,
          ...(event.payload.name !== undefined ? { name: event.payload.name } : {}),
          ...(event.payload.description !== undefined ? { description: event.payload.description } : {}),
          ...(event.payload.avatarUrl !== undefined ? { avatarUrl: event.payload.avatarUrl } : {}),
          ...(event.payload.lastMessageAt !== undefined ? { lastMessageAt: event.payload.lastMessageAt } : {}),
          ...(event.payload.type ? { type: event.payload.type as ConversationType } : {}),
        });
      }
    });

    this.ws.on('conversation.member_added', (event) => {
      const members = this.conversationMembers.get(event.payload.conversationId);
      if (members) {
        members.push(event.payload.member);
      }
    });

    this.ws.on('conversation.member_removed', (event) => {
      const members = this.conversationMembers.get(event.payload.conversationId);
      if (members) {
        const idx = members.findIndex((m) => m.userId === event.payload.userId);
        if (idx !== -1) {
          members.splice(idx, 1);
        }
      }
      if (event.payload.userId === this.identity.userId) {
        this.conversations.delete(event.payload.conversationId);
        this.conversationMembers.delete(event.payload.conversationId);
      }
    });

    this.ws.on('contact.request_accepted', (event) => {
      this.indexContact(event.payload);
    });

    this.ws.on('contact.removed', (event) => {
      this.removeContact(event.payload.contactId);
    });
  }

  // ---------------------------------------------------------------------------
  // Internal — message handling
  // ---------------------------------------------------------------------------

  private handleIncomingMessage(payload: MessageRecord & { readonly conversationType: string }): void {
    if (payload.senderId === this.identity.userId) {
      return;
    }
    if (!payload.content.text) {
      return;
    }

    // Gap detection: if sequenceNumber jumped, backfill missed messages
    const currentSeq = this.sequenceNumbers.get(payload.conversationId) ?? 0;
    if (payload.sequenceNumber > currentSeq + 1 && currentSeq > 0) {
      void this.backfillGap(payload.conversationId, currentSeq, payload.sequenceNumber);
    }
    if (payload.sequenceNumber > currentSeq) {
      this.sequenceNumbers.set(payload.conversationId, payload.sequenceNumber);
    }

    const contact = this.contacts.get(payload.senderId);
    const conv = this.conversations.get(payload.conversationId);

    const message: IncomingMessage = {
      conversationId: payload.conversationId,
      conversationType: payload.conversationType,
      groupName: conv?.name,
      senderUserId: payload.senderId,
      senderUsername: contact?.friendUsername,
      senderDisplayName: contact?.friendDisplayName,
      senderAccountType: contact?.friendAccountType,
      inContact: this.contacts.has(payload.senderId),
      text: payload.content.text,
      timestamp: payload.createdAt,
    };

    this.messageHandler?.(message);
  }

  /**
   * Backfill missed messages when a sequence gap is detected.
   * Fetches messages between the last known sequence and the new one,
   * and delivers them to the message handler.
   */
  private async backfillGap(conversationId: string, afterSeq: number, beforeSeq: number): Promise<void> {
    try {
      // We don't have messageIds for the gap boundaries, so fetch recent messages
      // and filter to the ones we missed. The gap is typically small (reconnect scenario).
      const resp = await this.client.listMessages({ conversationId, limit: 50 });
      for (const msg of resp.messages) {
        if (
          msg.sequenceNumber > afterSeq &&
          msg.sequenceNumber < beforeSeq &&
          msg.senderId !== this.identity.userId &&
          msg.content.text
        ) {
          const contact = this.contacts.get(msg.senderId);
          const conv = this.conversations.get(conversationId);
          this.messageHandler?.({
            conversationId,
            conversationType: conv?.type ?? 'dm',
            groupName: conv?.name,
            senderUserId: msg.senderId,
            senderUsername: contact?.friendUsername,
            senderDisplayName: contact?.friendDisplayName,
            senderAccountType: contact?.friendAccountType,
            inContact: this.contacts.has(msg.senderId),
            text: msg.content.text,
            timestamp: msg.createdAt,
          });
        }
      }
    } catch {
      // Best-effort — if backfill fails, we still process the current message
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
