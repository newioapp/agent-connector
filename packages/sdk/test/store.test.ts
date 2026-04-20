import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NewioAppStore } from '../src/app/store.js';
import type { ContactRecord, ConversationListItem, MemberRecord, MessageRecord } from '../src/core/types.js';
import type { NewioIdentity } from '../src/app/types.js';

const makeContact = (overrides: Partial<ContactRecord> = {}): ContactRecord => ({
  contactId: 'user-1',
  friendDisplayName: 'Alice',
  friendAccountType: 'human',
  status: 'accepted',
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const makeConversation = (overrides: Partial<ConversationListItem> = {}): ConversationListItem => ({
  conversationId: 'conv-1',
  type: 'dm',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const identity: NewioIdentity = {
  userId: 'me',
  username: 'mybot',
  displayName: 'My Bot',
};

describe('NewioAppStore', () => {
  let store: NewioAppStore;

  beforeEach(() => {
    store = new NewioAppStore();
  });

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  describe('contacts', () => {
    it('indexes and retrieves a contact', () => {
      const c = makeContact({ contactId: 'u1', friendUsername: 'alice' });
      store.indexContact(c);
      expect(store.getContact('u1')).toEqual(c);
      expect(store.isContact('u1')).toBe(true);
      expect(store.resolveUsernameFromCache('Alice')).toBe('u1');
    });

    it('removes a contact and its username index', () => {
      store.indexContact(makeContact({ contactId: 'u1', friendUsername: 'alice' }));
      store.removeContact('u1');
      expect(store.getContact('u1')).toBeUndefined();
      expect(store.isContact('u1')).toBe(false);
      expect(store.resolveUsernameFromCache('alice')).toBeUndefined();
    });

    it('removeContact is a no-op for unknown contactId', () => {
      store.removeContact('nonexistent');
    });

    it('getAllContacts returns all indexed contacts', () => {
      store.indexContact(makeContact({ contactId: 'a' }));
      store.indexContact(makeContact({ contactId: 'b' }));
      expect(store.getAllContacts()).toHaveLength(2);
    });

    it('updateContact updates fields and re-indexes username', () => {
      store.indexContact(makeContact({ contactId: 'u1', friendUsername: 'old' }));
      store.updateContact('u1', { friendUsername: 'new', friendDisplayName: 'New Name' });

      expect(store.getContact('u1')?.friendDisplayName).toBe('New Name');
      expect(store.resolveUsernameFromCache('old')).toBeUndefined();
      expect(store.resolveUsernameFromCache('new')).toBe('u1');
    });

    it('updateContact is a no-op for unknown contactId', () => {
      store.updateContact('nonexistent', { friendDisplayName: 'x' });
    });
  });

  // -------------------------------------------------------------------------
  // Owner profiles
  // -------------------------------------------------------------------------

  describe('owner profiles', () => {
    it('stores and retrieves owner profiles', () => {
      store.setOwnerProfile('owner-1', { username: 'nan', displayName: 'Nan' });
      expect(store.getOwnerProfile('owner-1')).toEqual({ username: 'nan', displayName: 'Nan' });
      expect(store.getOwnerProfile('unknown')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  describe('conversations', () => {
    it('stores and retrieves conversations', () => {
      const conv = makeConversation({ conversationId: 'c1', notifyLevel: 'mentions', sessionId: 's1' });
      store.setConversation(conv);
      expect(store.getConversation('c1')).toEqual(conv);
      expect(store.hasConversation('c1')).toBe(true);
      expect(store.getNotifyLevel('c1')).toBe('mentions');
      expect(store.getSessionId('c1')).toBe('s1');
    });

    it('removes a conversation and its members', () => {
      store.setConversation(makeConversation({ conversationId: 'c1' }));
      store.setMembers('c1', [{ userId: 'u1' } as MemberRecord]);
      store.removeConversation('c1');
      expect(store.getConversation('c1')).toBeUndefined();
      expect(store.getMembers('c1')).toBeUndefined();
    });

    it('getAllConversations returns all stored conversations', () => {
      store.setConversation(makeConversation({ conversationId: 'c1' }));
      store.setConversation(makeConversation({ conversationId: 'c2' }));
      expect(store.getAllConversations()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  describe('members', () => {
    it('stores and retrieves members', () => {
      const members = [{ userId: 'u1' }, { userId: 'u2' }] as MemberRecord[];
      store.setMembers('c1', members);
      expect(store.getMembers('c1')?.size).toBe(2);
    });

    it('addMembers appends to existing cache', () => {
      store.setMembers('c1', [{ userId: 'u1' } as MemberRecord]);
      store.addMembers('c1', [{ userId: 'u2' } as MemberRecord]);
      expect(store.getMembers('c1')?.size).toBe(2);
    });

    it('addMembers is a no-op when conversation not cached', () => {
      store.addMembers('unknown', [{ userId: 'u1' } as MemberRecord]);
      expect(store.getMembers('unknown')).toBeUndefined();
    });

    it('removeMember removes from cached map', () => {
      store.setMembers('c1', [{ userId: 'u1' }, { userId: 'u2' }] as MemberRecord[]);
      store.removeMember('c1', 'u1');
      expect(store.getMembers('c1')?.has('u1')).toBe(false);
      expect(store.getMembers('c1')?.has('u2')).toBe(true);
    });

    it('removeMember is a no-op when conversation not cached', () => {
      store.removeMember('unknown', 'u1');
    });
  });

  // -------------------------------------------------------------------------
  // Sequence numbers & session IDs & notify levels
  // -------------------------------------------------------------------------

  describe('sequence numbers', () => {
    it('defaults to 0', () => {
      expect(store.getSequenceNumber('c1')).toBe(0);
    });

    it('stores and retrieves', () => {
      store.setSequenceNumber('c1', 42);
      expect(store.getSequenceNumber('c1')).toBe(42);
    });
  });

  describe('session IDs', () => {
    it('stores and retrieves', () => {
      store.setSessionId('c1', 's1');
      expect(store.getSessionId('c1')).toBe('s1');
      expect(store.getSessionId('unknown')).toBeUndefined();
    });
  });

  describe('notify levels', () => {
    it('stores and retrieves', () => {
      store.setNotifyLevel('c1', 'nothing');
      expect(store.getNotifyLevel('c1')).toBe('nothing');
      expect(store.getNotifyLevel('unknown')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Incoming friend requests
  // -------------------------------------------------------------------------

  describe('incoming requests', () => {
    it('adds, retrieves, and removes requests', () => {
      const req = makeContact({ userId: 'sender1', contactId: 'me', friendUsername: 'bob', status: 'pending' });
      store.addIncomingRequest(req);
      expect(store.getIncomingRequests()).toHaveLength(1);

      store.removeIncomingRequest('sender1');
      expect(store.getIncomingRequests()).toHaveLength(0);
    });

    it('findIncomingRequestByUsername is case-insensitive', () => {
      store.addIncomingRequest(makeContact({ userId: 'sender1', contactId: 'me', friendUsername: 'Bob' }));
      expect(store.findIncomingRequestByUsername('bob')?.userId).toBe('sender1');
      expect(store.findIncomingRequestByUsername('BOB')?.userId).toBe('sender1');
      expect(store.findIncomingRequestByUsername('unknown')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  describe('messages', () => {
    const msg = (id: string, ts?: string) => ({
      messageId: id,
      conversationId: 'c1',
      conversationType: 'dm',
      senderUserId: 'u1',
      text: `msg-${id}`,
      timestamp: ts ?? new Date().toISOString(),
      isOwnMessage: false,
      relationship: 'in-contact' as const,
      status: 'new' as const,
    });

    it('inserts and retrieves messages in ULID order', () => {
      expect(store.insertMessage('c1', msg('002'))).toBe(true);
      expect(store.insertMessage('c1', msg('001'))).toBe(true);
      expect(store.insertMessage('c1', msg('003'))).toBe(true);

      const messages = store.getRecentMessages('c1');
      expect(messages.map((m) => m.messageId)).toEqual(['001', '002', '003']);
    });

    it('deduplicates messages', () => {
      store.insertMessage('c1', msg('001'));
      expect(store.insertMessage('c1', msg('001'))).toBe(false);
      expect(store.getRecentMessages('c1')).toHaveLength(1);
    });

    it('updateMessage updates text and sets status to edited', () => {
      store.insertMessage('c1', msg('001'));
      const updated = store.updateMessage('c1', '001', 'new text');
      expect(updated?.text).toBe('new text');
      expect(updated?.status).toBe('edited');
    });

    it('updateMessage returns undefined for unknown message', () => {
      expect(store.updateMessage('c1', 'unknown', 'x')).toBeUndefined();
      store.insertMessage('c1', msg('001'));
      expect(store.updateMessage('c1', 'unknown', 'x')).toBeUndefined();
    });

    it('removeMessage marks as deleted', () => {
      store.insertMessage('c1', msg('001'));
      const deleted = store.removeMessage('c1', '001');
      expect(deleted?.text).toBe('');
      expect(deleted?.status).toBe('deleted');
    });

    it('removeMessage returns undefined for unknown message', () => {
      expect(store.removeMessage('c1', 'unknown')).toBeUndefined();
      store.insertMessage('c1', msg('001'));
      expect(store.removeMessage('c1', 'unknown')).toBeUndefined();
    });

    it('getRecentMessages returns empty array for unknown conversation', () => {
      expect(store.getRecentMessages('unknown')).toEqual([]);
    });

    it('evicts expired messages', () => {
      vi.useFakeTimers();
      const old = new Date(Date.now() - 11 * 60 * 1000).toISOString(); // 11 min ago (> 10 min TTL)
      const recent = new Date().toISOString();

      store.insertMessage('c1', msg('001', old));
      store.insertMessage('c1', msg('002', recent));

      const messages = store.getRecentMessages('c1');
      expect(messages).toHaveLength(1);
      expect(messages[0]?.messageId).toBe('002');
      vi.useRealTimers();
    });

    it('cleans up map entry when all messages are evicted', () => {
      vi.useFakeTimers();
      const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      store.insertMessage('c1', msg('001', old));

      const messages = store.getRecentMessages('c1');
      expect(messages).toEqual([]);
      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // toIncomingMessage
  // -------------------------------------------------------------------------

  describe('toIncomingMessage', () => {
    const rawMsg: MessageRecord = {
      messageId: 'msg-1',
      senderId: 'user-1',
      content: { text: 'hello' },
      createdAt: '2026-01-01T00:00:00Z',
      sequenceNumber: 1,
    };

    it('resolves sender from contacts for non-self messages', () => {
      store.indexContact(makeContact({ contactId: 'user-1', friendUsername: 'alice', friendDisplayName: 'Alice' }));
      store.setConversation(makeConversation({ conversationId: 'c1', type: 'group', name: 'Team' }));

      const result = store.toIncomingMessage(identity, rawMsg, 'c1');
      expect(result.senderUsername).toBe('alice');
      expect(result.senderDisplayName).toBe('Alice');
      expect(result.isOwnMessage).toBe(false);
      expect(result.relationship).toBe('in-contact');
      expect(result.groupName).toBe('Team');
      expect(result.conversationType).toBe('group');
    });

    it('uses identity for own messages', () => {
      const ownMsg = { ...rawMsg, senderId: 'me' };
      const result = store.toIncomingMessage(identity, ownMsg, 'c1');
      expect(result.senderUsername).toBe('mybot');
      expect(result.senderDisplayName).toBe('My Bot');
      expect(result.isOwnMessage).toBe(true);
      expect(result.senderAccountType).toBe('agent');
    });

    it('uses explicit conversationType when provided', () => {
      const result = store.toIncomingMessage(identity, rawMsg, 'c1', 'temp_group');
      expect(result.conversationType).toBe('temp_group');
    });

    it('defaults to dm when conversation not in store', () => {
      const result = store.toIncomingMessage(identity, rawMsg, 'unknown');
      expect(result.conversationType).toBe('dm');
    });
  });

  // -------------------------------------------------------------------------
  // Persistence write-through
  // -------------------------------------------------------------------------

  describe('persistence', () => {
    it('calls persistence methods on mutations', () => {
      const persistence = {
        saveContact: vi.fn(),
        removeContact: vi.fn(),
        saveConversation: vi.fn(),
        removeConversation: vi.fn(),
        saveMessage: vi.fn(),
        saveMembers: vi.fn(),
      };
      const s = new NewioAppStore(persistence);

      const contact = makeContact({ contactId: 'u1' });
      s.indexContact(contact);
      expect(persistence.saveContact).toHaveBeenCalledWith(contact);

      s.removeContact('u1');
      expect(persistence.removeContact).toHaveBeenCalledWith('u1');

      const conv = makeConversation({ conversationId: 'c1' });
      s.setConversation(conv);
      expect(persistence.saveConversation).toHaveBeenCalledWith(conv);

      s.removeConversation('c1');
      expect(persistence.removeConversation).toHaveBeenCalledWith('c1');

      const members = [{ userId: 'u1' }] as MemberRecord[];
      s.setMembers('c1', members);
      expect(persistence.saveMembers).toHaveBeenCalledWith('c1', members);
    });
  });
});
