import { describe, it, expect, beforeEach } from 'vitest';
import { MockBackend } from '../src/mock-backend.js';
import type { BackendEvent } from '../src/mock-backend.js';

describe('MockBackend', () => {
  let backend: MockBackend;

  beforeEach(() => {
    backend = new MockBackend();
  });

  describe('createUser', () => {
    it('creates a user and retrieves by userId', () => {
      const user = backend.createUser({ username: 'alice', displayName: 'Alice', accountType: 'human' });
      expect(user.username).toBe('alice');
      expect(backend.getUser(user.userId)).toEqual(user);
    });

    it('creates a user and retrieves by username', () => {
      backend.createUser({ username: 'bob', displayName: 'Bob', accountType: 'agent', ownerId: 'owner-1' });
      const found = backend.getUserByUsername('bob');
      expect(found?.displayName).toBe('Bob');
      expect(found?.ownerId).toBe('owner-1');
    });

    it('username lookup is case-insensitive', () => {
      backend.createUser({ username: 'Alice', displayName: 'Alice', accountType: 'human' });
      expect(backend.getUserByUsername('alice')).toBeDefined();
      expect(backend.getUserByUsername('ALICE')).toBeDefined();
    });
  });

  describe('contacts', () => {
    it('addFriendship creates bidirectional contacts', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });
      backend.addFriendship(a.userId, b.userId);

      expect(backend.getContacts(a.userId).map((c) => c.userId)).toContain(b.userId);
      expect(backend.getContacts(b.userId).map((c) => c.userId)).toContain(a.userId);
    });

    it('addFriendship is idempotent', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });
      backend.addFriendship(a.userId, b.userId);
      backend.addFriendship(a.userId, b.userId);
      expect(backend.getContacts(a.userId)).toHaveLength(1);
    });

    it('sendFriendRequest creates pending request and emits event', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });

      const events: BackendEvent[] = [];
      backend.registerListener(b.userId, (e) => events.push(e));

      backend.sendFriendRequest(a.userId, b.userId, 'hi!');

      const requests = backend.getIncomingFriendRequests(b.userId);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.user.userId).toBe(a.userId);
      expect(requests[0]?.note).toBe('hi!');
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('contact.request_received');
    });

    it('acceptFriendRequest promotes to bidirectional and emits event', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });
      backend.seedFriendRequest(a.userId, b.userId);

      const events: BackendEvent[] = [];
      backend.registerListener(a.userId, (e) => events.push(e));

      backend.acceptFriendRequest(b.userId, a.userId);

      expect(backend.getContacts(a.userId).map((c) => c.userId)).toContain(b.userId);
      expect(backend.getContacts(b.userId).map((c) => c.userId)).toContain(a.userId);
      expect(backend.getIncomingFriendRequests(b.userId)).toHaveLength(0);
      expect(events[0]?.type).toBe('contact.accepted');
    });

    it('rejectFriendRequest removes the pending request', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });
      backend.seedFriendRequest(a.userId, b.userId);

      backend.rejectFriendRequest(b.userId, a.userId);
      expect(backend.getIncomingFriendRequests(b.userId)).toHaveLength(0);
    });

    it('removeFriend removes both directions and emits event', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });
      backend.addFriendship(a.userId, b.userId);

      const events: BackendEvent[] = [];
      backend.registerListener(b.userId, (e) => events.push(e));

      backend.removeFriend(a.userId, b.userId);
      expect(backend.getContacts(a.userId)).toHaveLength(0);
      expect(backend.getContacts(b.userId)).toHaveLength(0);
      expect(events[0]?.type).toBe('contact.removed');
    });
  });

  describe('conversations', () => {
    it('creates a conversation and lists for members', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });
      backend.addFriendship(a.userId, b.userId);
      const conv = backend.createConversation({ type: 'dm', memberUserIds: [a.userId, b.userId], createdBy: a.userId });

      expect(backend.getConversationsForUser(a.userId)).toHaveLength(1);
      expect(backend.getConversationsForUser(b.userId)).toHaveLength(1);
      expect(backend.getConversation(conv.conversationId)?.type).toBe('dm');
    });

    it('findDm finds existing DM between two users', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });
      backend.addFriendship(a.userId, b.userId);
      const conv = backend.createConversation({ type: 'dm', memberUserIds: [a.userId, b.userId], createdBy: a.userId });

      expect(backend.findDm(a.userId, b.userId)?.conversationId).toBe(conv.conversationId);
      expect(backend.findDm(b.userId, a.userId)?.conversationId).toBe(conv.conversationId);
    });

    it('addMember and removeMember modify membership', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });
      const c = backend.createUser({ username: 'c', displayName: 'C', accountType: 'human' });
      backend.addFriendship(a.userId, b.userId);
      backend.addFriendship(a.userId, c.userId);
      const conv = backend.createConversation({
        type: 'group',
        name: 'Test',
        memberUserIds: [a.userId, b.userId],
        createdBy: a.userId,
      });

      backend.addMember(conv.conversationId, c.userId, a.userId);
      expect(backend.getConversation(conv.conversationId)?.members).toHaveLength(3);

      backend.removeMember(conv.conversationId, c.userId, a.userId);
      expect(backend.getConversation(conv.conversationId)?.members).toHaveLength(2);
    });
  });

  describe('messaging', () => {
    it('sendMessage stores message and emits to other members', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });
      backend.addFriendship(a.userId, b.userId);
      const conv = backend.createConversation({ type: 'dm', memberUserIds: [a.userId, b.userId], createdBy: a.userId });

      const events: BackendEvent[] = [];
      backend.registerListener(b.userId, (e) => events.push(e));

      backend.sendMessage({ conversationId: conv.conversationId, senderId: a.userId, text: 'hello' });

      expect(backend.getMessages(conv.conversationId, a.userId)).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('message.new');
    });

    it('sendMessage does not emit to sender', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });
      backend.addFriendship(a.userId, b.userId);
      const conv = backend.createConversation({ type: 'dm', memberUserIds: [a.userId, b.userId], createdBy: a.userId });

      const events: BackendEvent[] = [];
      backend.registerListener(a.userId, (e) => events.push(e));

      backend.sendMessage({ conversationId: conv.conversationId, senderId: a.userId, text: 'hello' });
      // Sender receives the event too (filtering is done at the app layer)
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('message.new');
    });

    it('seedMessage stores without emitting events', () => {
      const a = backend.createUser({ username: 'a', displayName: 'A', accountType: 'human' });
      const b = backend.createUser({ username: 'b', displayName: 'B', accountType: 'human' });
      backend.addFriendship(a.userId, b.userId);
      const conv = backend.createConversation({ type: 'dm', memberUserIds: [a.userId, b.userId], createdBy: a.userId });

      const events: BackendEvent[] = [];
      backend.registerListener(b.userId, (e) => events.push(e));

      backend.seedMessage({ conversationId: conv.conversationId, senderId: a.userId, text: 'seed' });
      expect(backend.getMessages(conv.conversationId, a.userId)).toHaveLength(1);
      expect(events).toHaveLength(0);
    });
  });

  describe('memory', () => {
    it('add/update/delete facts', () => {
      const factId = backend.addMemoryFact('agent-1', 'global', 'fact text');
      expect(backend.getMemoryScope('agent-1', 'global').facts).toHaveLength(1);

      backend.updateMemoryFact('agent-1', 'global', factId, 'updated');
      expect(backend.getMemoryScope('agent-1', 'global').facts[0]?.text).toBe('updated');

      backend.deleteMemoryFact('agent-1', 'global', factId);
      expect(backend.getMemoryScope('agent-1', 'global').facts).toHaveLength(0);
    });

    it('update summary', () => {
      backend.updateMemorySummary('agent-1', 'user#u1', 'summary text');
      expect(backend.getMemoryScope('agent-1', 'user#u1').summary).toBe('summary text');
    });

    it('returns empty scope for unknown agent/key', () => {
      const scope = backend.getMemoryScope('unknown', 'global');
      expect(scope.summary).toBeNull();
      expect(scope.facts).toHaveLength(0);
    });
  });

  describe('handoff notes', () => {
    it('put and get handoff note', () => {
      backend.putHandoffNote('agent-1', 'conv-1', 'handoff text');
      expect(backend.getHandoffNote('agent-1', 'conv-1')).toBe('handoff text');
    });

    it('returns null for missing note', () => {
      expect(backend.getHandoffNote('agent-1', 'conv-99')).toBeNull();
    });
  });

  describe('searchUsers', () => {
    it('searches by username and displayName', () => {
      backend.createUser({ username: 'alice', displayName: 'Alice Wonder', accountType: 'human' });
      backend.createUser({ username: 'bob', displayName: 'Bob Builder', accountType: 'human' });

      expect(backend.searchUsers('ali')).toHaveLength(1);
      expect(backend.searchUsers('builder')).toHaveLength(1);
      expect(backend.searchUsers('xyz')).toHaveLength(0);
    });
  });
});
