import { describe, it, expect, beforeEach } from 'vitest';
import { MockBackend } from '../src/mock-backend.js';
import { MockNewioApp } from '../src/mock-newio-app.js';
import type { BackendUser } from '../src/mock-backend.js';
import type { IncomingMessage, ContactEvent } from '@newio/agent-sdk';

describe('MockNewioApp', () => {
  let backend: MockBackend;
  let owner: BackendUser;
  let agent: BackendUser;
  let app: MockNewioApp;

  beforeEach(() => {
    backend = new MockBackend();
    owner = backend.createUser({ username: 'alice', displayName: 'Alice', accountType: 'human' });
    agent = backend.createUser({ username: 'nova', displayName: 'Nova', accountType: 'agent', ownerId: owner.userId });
    backend.addFriendship(owner.userId, agent.userId);
    app = new MockNewioApp({ backend, userId: agent.userId });
  });

  describe('identity', () => {
    it('exposes correct identity', () => {
      expect(app.identity.userId).toBe(agent.userId);
      expect(app.identity.username).toBe('nova');
      expect(app.identity.ownerId).toBe(owner.userId);
    });

    it('getOwnerInfo returns owner details', () => {
      const info = app.getOwnerInfo();
      expect(info.username).toBe('alice');
      expect(info.displayName).toBe('Alice');
    });

    it('throws if user not found in backend', () => {
      expect(() => new MockNewioApp({ backend, userId: 'nonexistent' })).toThrow();
    });
  });

  describe('contacts', () => {
    it('getAllContacts returns current friends', () => {
      const contacts = app.getAllContacts();
      expect(contacts).toHaveLength(1);
      expect(contacts[0]?.username).toBe('alice');
    });

    it('sendFriendRequestByUsername sends request', async () => {
      const bob = backend.createUser({ username: 'bob', displayName: 'Bob', accountType: 'human' });
      await app.sendFriendRequestByUsername('bob');
      const requests = backend.getIncomingFriendRequests(bob.userId);
      expect(requests).toHaveLength(1);
    });

    it('acceptFriendRequestByUsername accepts and adds contact', async () => {
      const bob = backend.createUser({ username: 'bob', displayName: 'Bob', accountType: 'human' });
      backend.seedFriendRequest(bob.userId, agent.userId);

      await app.acceptFriendRequestByUsername('bob');
      expect(app.getAllContacts().some((c) => c.username === 'bob')).toBe(true);
    });

    it('rejectFriendRequestByUsername removes request', async () => {
      const bob = backend.createUser({ username: 'bob', displayName: 'Bob', accountType: 'human' });
      backend.seedFriendRequest(bob.userId, agent.userId);

      await app.rejectFriendRequestByUsername('bob');
      expect(app.listIncomingFriendRequests()).toHaveLength(0);
    });

    it('removeFriendByUsername removes friend', async () => {
      await app.removeFriendByUsername('alice');
      expect(app.getAllContacts()).toHaveLength(0);
    });
  });

  describe('conversations', () => {
    it('getOrCreateDm creates a new DM', async () => {
      const convId = await app.getOrCreateDm('alice');
      expect(convId).toBeDefined();
      const info = await app.getConversationInfo(convId);
      expect(info.type).toBe('dm');
    });

    it('getOrCreateDm returns existing DM', async () => {
      const id1 = await app.getOrCreateDm('alice');
      const id2 = await app.getOrCreateDm('alice');
      expect(id1).toBe(id2);
    });

    it('createWorkSession creates temp_group', async () => {
      const convId = await app.createWorkSession('Project X', ['alice']);
      const info = await app.getConversationInfo(convId);
      expect(info.type).toBe('temp_group');
      expect(info.name).toBe('Project X');
    });

    it('createGroup creates group', async () => {
      const convId = await app.createGroup('Team', ['alice']);
      const info = await app.getConversationInfo(convId);
      expect(info.type).toBe('group');
      expect(info.admins).toContain('nova');
    });

    it('listConversations lists user conversations', async () => {
      await app.getOrCreateDm('alice');
      const result = app.listConversations();
      expect(result.conversations.length).toBeGreaterThanOrEqual(1);
    });

    it('addMembersByUsername adds members', async () => {
      const bob = backend.createUser({ username: 'bob', displayName: 'Bob', accountType: 'human' });
      backend.addFriendship(agent.userId, bob.userId);
      const convId = await app.createGroup('Team', ['alice']);
      await app.addMembersByUsername(convId, ['bob']);
      const isMember = await app.checkIsMember(convId, 'bob');
      expect(isMember).toBe(true);
    });

    it('removeMemberByUsername removes member', async () => {
      const convId = await app.createGroup('Team', ['alice']);
      await app.removeMemberByUsername(convId, 'alice');
      const isMember = await app.checkIsMember(convId, 'alice');
      expect(isMember).toBe(false);
    });
  });

  describe('messaging', () => {
    it('sendMessage stores in backend', async () => {
      const convId = await app.getOrCreateDm('alice');
      await app.sendMessage(convId, 'hello');

      const messages = backend.getMessages(convId, agent.userId);
      expect(messages.some((m) => m.content.text === 'hello')).toBe(true);
    });

    it('sendDm creates DM and sends message', async () => {
      await app.sendDm('alice', 'hi owner');
      const convId = await app.getOrCreateDm('alice');
      const messages = backend.getMessages(convId, agent.userId);
      expect(messages.some((m) => m.content.text === 'hi owner')).toBe(true);
    });

    it('listMessages returns messages newest first', async () => {
      const convId = await app.getOrCreateDm('alice');
      backend.seedMessage({ conversationId: convId, senderId: owner.userId, text: 'msg1' });
      backend.seedMessage({ conversationId: convId, senderId: owner.userId, text: 'msg2' });

      const result = await app.listMessages(convId);
      expect(result.messages).toHaveLength(2);
      // Newest first
      expect(result.messages[0]?.content.text).toBe('msg2');
    });
  });

  describe('event delivery', () => {
    it('receives message.new events from backend', async () => {
      const convId = await app.getOrCreateDm('alice');
      const received: IncomingMessage[] = [];
      app.onMessageNew((msg) => received.push(msg));

      backend.sendMessage({ conversationId: convId, senderId: owner.userId, text: 'hey nova' });

      expect(received).toHaveLength(1);
      expect(received[0]?.text).toBe('hey nova');
      expect(received[0]?.senderUsername).toBe('alice');
      expect(received[0]?.relationship).toBe('owner');
    });

    it('receives contact events', () => {
      const bob = backend.createUser({ username: 'bob', displayName: 'Bob', accountType: 'human' });
      const events: ContactEvent[] = [];
      app.onContactEvent((e) => events.push(e));

      backend.sendFriendRequest(bob.userId, agent.userId);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('contact.request_received');
    });

    it('classifies stranger relationship correctly', async () => {
      const stranger = backend.createUser({ username: 'stranger', displayName: 'Stranger', accountType: 'human' });
      // Owner creates the group and adds both agent and stranger
      backend.addFriendship(owner.userId, stranger.userId);
      const conv = backend.createConversation({
        type: 'group',
        name: 'G',
        memberUserIds: [owner.userId, agent.userId, stranger.userId],
        createdBy: owner.userId,
      });

      const received: IncomingMessage[] = [];
      app.onMessageNew((msg) => received.push(msg));

      backend.sendMessage({ conversationId: conv.conversationId, senderId: stranger.userId, text: 'hi' });
      expect(received[0]?.relationship).toBe('stranger');
    });
  });

  describe('multi-agent interaction', () => {
    it('two agents can message each other through backend', async () => {
      const agent2 = backend.createUser({
        username: 'atlas',
        displayName: 'Atlas',
        accountType: 'agent',
        ownerId: owner.userId,
      });
      backend.addFriendship(agent.userId, agent2.userId);
      const app2 = new MockNewioApp({ backend, userId: agent2.userId });

      const received: IncomingMessage[] = [];
      app2.onMessageNew((msg) => received.push(msg));

      const convId = await app.getOrCreateDm('atlas');
      await app.sendMessage(convId, 'hello atlas');

      expect(received).toHaveLength(1);
      expect(received[0]?.text).toBe('hello atlas');
      expect(received[0]?.senderUsername).toBe('nova');

      app2.dispose();
    });
  });

  describe('memory', () => {
    it('addMemory and getContactMemory round-trips', async () => {
      await app.addMemory('Alice likes cats', { username: 'alice' });
      const mem = await app.getContactMemory('alice');
      expect(mem.facts).toHaveLength(1);
      expect(mem.facts[0]?.text).toBe('Alice likes cats');
    });

    it('updateMemory modifies fact text', async () => {
      await app.addMemory('original', { username: 'alice' });
      const mem = await app.getContactMemory('alice');
      const factId = mem.facts[0]!.factId;

      await app.updateMemory(factId, 'updated', { username: 'alice' });
      const updated = await app.getContactMemory('alice');
      expect(updated.facts[0]?.text).toBe('updated');
    });

    it('deleteMemory removes fact', async () => {
      await app.addMemory('to delete', { username: 'alice' });
      const mem = await app.getContactMemory('alice');
      await app.deleteMemory(mem.facts[0]!.factId, { username: 'alice' });
      const result = await app.getContactMemory('alice');
      expect(result.facts).toHaveLength(0);
    });

    it('updateMemorySummary sets summary', async () => {
      await app.updateMemorySummary('Alice is my owner', { username: 'alice' });
      const mem = await app.getContactMemory('alice');
      expect(mem.summary).toBe('Alice is my owner');
    });

    it('global memory via loadSessionMemory', async () => {
      backend.addMemoryFact(agent.userId, 'global', 'I am Nova');
      const session = await app.loadSessionMemory();
      expect(session.global.facts).toHaveLength(1);
    });

    it('handoff notes persist', async () => {
      await app.putHandoffNote('conv-1', 'working on task X');
      const note = await app.getHandoffNote('conv-1');
      expect(note).toBe('working on task X');
    });
  });

  describe('cache methods (NewioAppForAgent)', () => {
    it('getConversationInfo returns info', async () => {
      const convId = await app.createGroup('Team', ['alice']);
      const info = await app.getConversationInfo(convId);
      expect(info?.type).toBe('group');
      expect(info?.name).toBe('Team');
    });

    it('isConversationMember checks membership', async () => {
      const convId = await app.createGroup('Team', ['alice']);
      expect(await app.isConversationMember(convId, agent.userId)).toBe(true);
      expect(await app.isConversationMember(convId, 'nonexistent')).toBe(false);
    });

    it('getConversationMemberIds returns all member ids', async () => {
      const convId = await app.createGroup('Team', ['alice']);
      const ids = await app.getConversationMemberIds(convId);
      expect(ids).toContain(agent.userId);
      expect(ids).toContain(owner.userId);
    });

    it('getMemberInfo returns user info', async () => {
      const convId = await app.createGroup('Team', ['alice']);
      const info = await app.getMemberInfo(convId, owner.userId);
      expect(info?.username).toBe('alice');
      expect(info?.displayName).toBe('Alice');
    });

    it('getOrCreateOwnerDmConversationId creates owner DM', async () => {
      const convId = await app.getOrCreateOwnerDmConversationId();
      expect(convId).toBeDefined();
      const info = await app.getConversationInfo(convId);
      expect(info.type).toBe('dm');
    });
  });

  describe('cron', () => {
    it('scheduleCron and listCrons', () => {
      app.scheduleCron({ cronId: 'c1', expression: '0 9 * * *', label: 'morning' });
      expect(app.listCrons()).toHaveLength(1);
      expect(app.listCrons()[0]?.label).toBe('morning');
    });

    it('cancelCron removes job', () => {
      app.scheduleCron({ cronId: 'c1', expression: '0 9 * * *', label: 'morning' });
      expect(app.cancelCron('c1')).toBe('cancelled');
      expect(app.listCrons()).toHaveLength(0);
    });

    it('cancelCron returns not_found for unknown', () => {
      expect(app.cancelCron('nope')).toBe('not_found');
    });
  });

  describe('dispose', () => {
    it('unregisters listener on dispose', async () => {
      const convId = await app.getOrCreateDm('alice');
      const received: IncomingMessage[] = [];
      app.onMessageNew((msg) => received.push(msg));

      app.dispose();
      backend.sendMessage({ conversationId: convId, senderId: owner.userId, text: 'after dispose' });
      expect(received).toHaveLength(0);
    });
  });
});
