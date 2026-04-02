/**
 * NewioAppStore — in-memory state store for NewioApp.
 *
 * Owns all cached state: contacts, conversations, members, messages,
 * sequence numbers, session IDs, and notify levels.
 *
 * Optionally writes through to a {@link StorePersistence} implementation
 * (e.g., sqlite) for durable storage. Reads always hit in-memory maps.
 */
import type {
  AccountType,
  ContactRecord,
  ConversationListItem,
  MemberRecord,
  MessageRecord,
  NotifyLevel,
} from '../core/types.js';
import type { IncomingMessage, NewioIdentity } from './types.js';

/** How long received messages are kept in the cache (ms). */
const MESSAGE_CACHE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Persistence interface (not implemented yet — future sqlite layer)
// ---------------------------------------------------------------------------

/**
 * Optional persistence layer for the store.
 *
 * When provided, the store writes through to persistence on every mutation.
 * Reads always come from in-memory maps. On app start, the persistence
 * layer loads data into memory; at runtime, writes go to both.
 *
 * Sync interface — designed for `better-sqlite3` which is synchronous.
 */
export interface StorePersistence {
  /** Persist a contact record. */
  saveContact(contact: ContactRecord): void;
  /** Remove a contact record. */
  removeContact(contactId: string): void;
  /** Persist a conversation record. */
  saveConversation(conv: ConversationListItem): void;
  /** Remove a conversation record. */
  removeConversation(conversationId: string): void;
  /** Persist a message. */
  saveMessage(conversationId: string, message: IncomingMessage): void;
  /** Persist conversation members. */
  saveMembers(conversationId: string, members: readonly MemberRecord[]): void;
}

// ---------------------------------------------------------------------------
// NewioAppStore
// ---------------------------------------------------------------------------

/** In-memory state store with optional write-through persistence. */
export class NewioAppStore {
  /** contactId → ContactRecord */
  private readonly contacts = new Map<string, ContactRecord>();
  /** username (lowercase) → contactId */
  private readonly usernameToContactId = new Map<string, string>();
  /** conversationId → ConversationListItem */
  private readonly conversations = new Map<string, ConversationListItem>();
  /** conversationId → Map<userId, MemberRecord> (lazily populated) */
  private readonly conversationMembers = new Map<string, Map<string, MemberRecord>>();
  /** conversationId → next sequenceNumber */
  private readonly sequenceNumbers = new Map<string, number>();
  /** conversationId → notification preference (missing = 'all') */
  private readonly notifyLevels = new Map<string, NotifyLevel>();
  /** conversationId → backend session ID (for agent members) */
  private readonly sessionIds = new Map<string, string>();
  /** conversationId → ULID-sorted message list (recent cache, evicted by TTL) */
  private readonly messageCache = new Map<string, IncomingMessage[]>();
  /** contactId → pending incoming friend request */
  private readonly incomingRequests = new Map<string, ContactRecord>();

  private readonly persistence: StorePersistence | undefined;

  constructor(persistence?: StorePersistence) {
    this.persistence = persistence;
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  /** Index a contact in the cache (and persist if configured). */
  indexContact(contact: ContactRecord): void {
    this.contacts.set(contact.contactId, contact);
    if (contact.friendUsername) {
      this.usernameToContactId.set(contact.friendUsername.toLowerCase(), contact.contactId);
    }
    this.persistence?.saveContact(contact);
  }

  /** Remove a contact from the cache (and persist if configured). */
  removeContact(contactId: string): void {
    const contact = this.contacts.get(contactId);
    if (contact?.friendUsername) {
      this.usernameToContactId.delete(contact.friendUsername.toLowerCase());
    }
    this.contacts.delete(contactId);
    this.persistence?.removeContact(contactId);
  }

  /** Get a contact by userId. */
  getContact(userId: string): ContactRecord | undefined {
    return this.contacts.get(userId);
  }

  /** Check if a userId is in the contact (friend) list. */
  isContact(userId: string): boolean {
    return this.contacts.has(userId);
  }

  /** Resolve a username to a contactId from the cache. Returns undefined if not found. */
  resolveUsernameFromCache(username: string): string | undefined {
    return this.usernameToContactId.get(username.toLowerCase());
  }

  /** Get all contacts (raw records). */
  getAllContacts(): ContactRecord[] {
    return [...this.contacts.values()];
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  /** Store a conversation (and persist if configured). */
  setConversation(conv: ConversationListItem): void {
    this.conversations.set(conv.conversationId, conv);
    if (conv.notifyLevel) {
      this.notifyLevels.set(conv.conversationId, conv.notifyLevel);
    }
    if (conv.sessionId) {
      this.sessionIds.set(conv.conversationId, conv.sessionId);
    }
    this.persistence?.saveConversation(conv);
  }

  /** Remove a conversation from the cache (and persist if configured). */
  removeConversation(conversationId: string): void {
    this.conversations.delete(conversationId);
    this.conversationMembers.delete(conversationId);
    this.persistence?.removeConversation(conversationId);
  }

  /** Get a conversation by ID. */
  getConversation(conversationId: string): ConversationListItem | undefined {
    return this.conversations.get(conversationId);
  }

  /** Check if a conversation exists. */
  hasConversation(conversationId: string): boolean {
    return this.conversations.has(conversationId);
  }

  /** Get all conversations (raw records). */
  getAllConversations(): ConversationListItem[] {
    return [...this.conversations.values()];
  }

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------

  /** Store members for a conversation (and persist if configured). */
  setMembers(conversationId: string, members: readonly MemberRecord[]): void {
    this.conversationMembers.set(conversationId, new Map(members.map((m) => [m.userId, m])));
    this.persistence?.saveMembers(conversationId, members);
  }

  /** Get cached members for a conversation. Returns undefined if not cached. */
  getMembers(conversationId: string): Map<string, MemberRecord> | undefined {
    return this.conversationMembers.get(conversationId);
  }

  /** Add members to an existing cached member map. */
  addMembers(conversationId: string, members: readonly MemberRecord[]): void {
    const cached = this.conversationMembers.get(conversationId);
    if (cached) {
      for (const m of members) {
        cached.set(m.userId, m);
      }
    }
  }

  /** Remove a member from the cached member map. */
  removeMember(conversationId: string, userId: string): void {
    const cached = this.conversationMembers.get(conversationId);
    if (cached) {
      cached.delete(userId);
    }
  }

  // ---------------------------------------------------------------------------
  // Sequence numbers
  // ---------------------------------------------------------------------------

  /** Get the current sequence number for a conversation. */
  getSequenceNumber(conversationId: string): number {
    return this.sequenceNumbers.get(conversationId) ?? 0;
  }

  /** Set the sequence number for a conversation. */
  setSequenceNumber(conversationId: string, seq: number): void {
    this.sequenceNumbers.set(conversationId, seq);
  }

  /** Increment and return the next sequence number for a conversation. */
  nextSequenceNumber(conversationId: string): number {
    const current = this.sequenceNumbers.get(conversationId) ?? -1;
    const next = current + 1;
    this.sequenceNumbers.set(conversationId, next);
    return next;
  }

  // ---------------------------------------------------------------------------
  // Session IDs & notify levels
  // ---------------------------------------------------------------------------

  /** Get the backend session ID for a conversation. */
  getSessionId(conversationId: string): string | undefined {
    return this.sessionIds.get(conversationId);
  }

  /** Set the backend session ID for a conversation. */
  setSessionId(conversationId: string, sessionId: string): void {
    this.sessionIds.set(conversationId, sessionId);
  }

  /** Get the notification level for a conversation. */
  getNotifyLevel(conversationId: string): NotifyLevel | undefined {
    return this.notifyLevels.get(conversationId);
  }

  /** Set the notification level for a conversation. */
  setNotifyLevel(conversationId: string, level: NotifyLevel): void {
    this.notifyLevels.set(conversationId, level);
  }

  // ---------------------------------------------------------------------------
  // Incoming friend requests
  // ---------------------------------------------------------------------------

  /** Cache an incoming friend request. */
  addIncomingRequest(request: ContactRecord): void {
    this.incomingRequests.set(request.contactId, request);
  }

  /** Remove an incoming friend request (accepted/rejected/revoked). */
  removeIncomingRequest(contactId: string): void {
    this.incomingRequests.delete(contactId);
  }

  /** Get all cached incoming friend requests. */
  getIncomingRequests(): ContactRecord[] {
    return [...this.incomingRequests.values()];
  }

  /** Update fields on an existing contact record. */
  updateContact(
    contactId: string,
    changes: Partial<Pick<ContactRecord, 'friendName' | 'friendDisplayName' | 'friendAvatarUrl' | 'friendUsername'>>,
  ): void {
    const existing = this.contacts.get(contactId);
    if (!existing) {
      return;
    }
    const updated: ContactRecord = { ...existing, ...changes };
    if (changes.friendUsername && existing.friendUsername !== changes.friendUsername) {
      if (existing.friendUsername) {
        this.usernameToContactId.delete(existing.friendUsername.toLowerCase());
      }
      this.usernameToContactId.set(changes.friendUsername.toLowerCase(), contactId);
    }
    this.contacts.set(contactId, updated);
    this.persistence?.saveContact(updated);
  }

  /** Find an incoming request by username. */
  findIncomingRequestByUsername(username: string): ContactRecord | undefined {
    for (const r of this.incomingRequests.values()) {
      if (r.friendUsername?.toLowerCase() === username.toLowerCase()) {
        return r;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /**
   * Insert a message into the per-conversation sorted list.
   * Scans from the end — O(1) for the common case (newest message).
   * Returns true if inserted, false if duplicate.
   */
  insertMessage(conversationId: string, message: IncomingMessage): boolean {
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
    this.persistence?.saveMessage(conversationId, message);
    return true;
  }

  /** Update a cached message's text content. Returns the updated message, or undefined if not found. */
  updateMessage(conversationId: string, messageId: string, text: string): IncomingMessage | undefined {
    const messages = this.messageCache.get(conversationId);
    if (!messages) {
      return undefined;
    }
    const msg = messages.find((m) => m.messageId === messageId);
    if (!msg) {
      return undefined;
    }
    const updated: IncomingMessage = { ...msg, text, status: 'edited' };
    messages[messages.indexOf(msg)] = updated;
    return updated;
  }

  /** Mark a cached message as deleted. Returns the updated message, or undefined if not found. */
  removeMessage(conversationId: string, messageId: string): IncomingMessage | undefined {
    const messages = this.messageCache.get(conversationId);
    if (!messages) {
      return undefined;
    }
    const msg = messages.find((m) => m.messageId === messageId);
    if (!msg) {
      return undefined;
    }
    const updated: IncomingMessage = { ...msg, text: '', status: 'deleted' };
    messages[messages.indexOf(msg)] = updated;
    return updated;
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

  // ---------------------------------------------------------------------------
  // Message resolution — convert raw MessageRecord to IncomingMessage
  // ---------------------------------------------------------------------------

  /** Convert a raw message record to an IncomingMessage using cached state. */
  toIncomingMessage(
    identity: NewioIdentity,
    msg: MessageRecord,
    conversationId: string,
    conversationType?: string,
  ): IncomingMessage {
    const contact = this.contacts.get(msg.senderId);
    const conv = this.conversations.get(conversationId);
    const isOwnMessage = msg.senderId === identity.userId;
    return {
      messageId: msg.messageId,
      conversationId,
      conversationType: conversationType ?? conv?.type ?? 'dm',
      groupName: conv?.name,
      senderUserId: msg.senderId,
      senderUsername: isOwnMessage ? identity.username : contact?.friendUsername,
      senderDisplayName: isOwnMessage ? identity.displayName : contact?.friendDisplayName,
      senderAccountType: isOwnMessage ? ('agent' as AccountType) : contact?.friendAccountType,
      inContact: isOwnMessage || this.contacts.has(msg.senderId),
      isOwnMessage,
      text: msg.content.text ?? '',
      timestamp: msg.createdAt,
      status: 'new',
    };
  }

  // ---------------------------------------------------------------------------
  // Internal — message eviction
  // ---------------------------------------------------------------------------

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
}
