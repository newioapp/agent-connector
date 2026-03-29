/**
 * NewioApp — high-level abstraction over the Newio SDK.
 *
 * Caches contacts and conversations, provides username-based lookups,
 * tracks sequenceNumbers, and exposes a clean event interface.
 * Used by both the Claude adapter and the future MCP server.
 */
import type { NewioClient, NewioWebSocket } from '@newio/sdk';
import type { ContactRecord, ConversationListItem, MemberRecord, MessageRecord, ConversationType } from '@newio/sdk';

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

// ---------------------------------------------------------------------------
// NewioApp
// ---------------------------------------------------------------------------

export class NewioApp {
  readonly identity: NewioIdentity;
  private readonly client: NewioClient;
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

  constructor(identity: NewioIdentity, client: NewioClient, ws: NewioWebSocket) {
    this.identity = identity;
    this.client = client;
    this.ws = ws;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /** Load contacts and conversations, wire up WebSocket events. */
  async init(): Promise<void> {
    await Promise.all([this.loadContacts(), this.loadConversations()]);
    this.wireEvents();
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
    // Check cached conversations for an existing DM
    for (const conv of this.conversations.values()) {
      if (conv.type === 'dm') {
        const members = await this.getMembers(conv.conversationId);
        if (members.some((m) => m.userId === userId)) {
          return conv.conversationId;
        }
      }
    }
    // Create new DM (backend returns existing if one already exists)
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
  // Internal — data loading
  // ---------------------------------------------------------------------------

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
      // If we were removed, clean up
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
    // Ignore own messages
    if (payload.senderId === this.identity.userId) {
      return;
    }

    // Ignore messages without text
    if (!payload.content.text) {
      return;
    }

    // Update sequenceNumber tracking
    const currentSeq = this.sequenceNumbers.get(payload.conversationId) ?? 0;
    if (payload.sequenceNumber > currentSeq) {
      this.sequenceNumbers.set(payload.conversationId, payload.sequenceNumber);
    }

    // Resolve sender info from contacts
    const contact = this.contacts.get(payload.senderId);
    const conv = this.conversations.get(payload.conversationId);

    const message: IncomingMessage = {
      conversationId: payload.conversationId,
      conversationType: payload.conversationType,
      groupName: conv?.name,
      senderUserId: payload.senderId,
      senderUsername: contact?.friendUsername,
      senderDisplayName: contact?.friendDisplayName,
      inContact: this.contacts.has(payload.senderId),
      text: payload.content.text,
      timestamp: payload.createdAt,
    };

    this.messageHandler?.(message);
  }
}
