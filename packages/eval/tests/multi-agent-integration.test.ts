import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockBackend } from '../src/mock-backend.js';
import { MockNewioApp } from '../src/mock-newio-app.js';
import type { BackendUser } from '../src/mock-backend.js';
import type { IncomingMessage, ContactEvent } from '@newio/agent-sdk';

describe('Multi-agent integration', () => {
  let backend: MockBackend;
  let owner: BackendUser;
  let agent1: BackendUser;
  let agent2: BackendUser;
  let app1: MockNewioApp;
  let app2: MockNewioApp;

  beforeEach(() => {
    backend = new MockBackend();
    owner = backend.createUser({ username: 'alice', displayName: 'Alice', accountType: 'human' });
    agent1 = backend.createUser({ username: 'nova', displayName: 'Nova', accountType: 'agent', ownerId: owner.userId });
    agent2 = backend.createUser({
      username: 'atlas',
      displayName: 'Atlas',
      accountType: 'agent',
      ownerId: owner.userId,
    });
    backend.addFriendship(owner.userId, agent1.userId);
    backend.addFriendship(owner.userId, agent2.userId);
    backend.addFriendship(agent1.userId, agent2.userId);
    app1 = new MockNewioApp({ backend, userId: agent1.userId });
    app2 = new MockNewioApp({ backend, userId: agent2.userId });
  });

  describe('cross-DM messaging', () => {
    it('agent1 sends DM to agent2, agent2 receives with correct metadata', async () => {
      const received: IncomingMessage[] = [];
      app2.onMessageNew((msg) => received.push(msg));

      await app1.sendDm('atlas', 'hello atlas');

      expect(received).toHaveLength(1);
      expect(received[0]?.text).toBe('hello atlas');
      expect(received[0]?.senderUsername).toBe('nova');
      expect(received[0]?.senderDisplayName).toBe('Nova');
      expect(received[0]?.senderAccountType).toBe('agent');
      expect(received[0]?.relationship).toBe('in-contact');
      expect(received[0]?.conversationType).toBe('dm');
      expect(received[0]?.isOwnMessage).toBe(false);
    });

    it('agent2 can reply back to agent1', async () => {
      await app1.sendDm('atlas', 'hello');

      const received: IncomingMessage[] = [];
      app1.onMessageNew((msg) => received.push(msg));

      await app2.sendDm('nova', 'hi back');

      expect(received).toHaveLength(1);
      expect(received[0]?.text).toBe('hi back');
      expect(received[0]?.senderUsername).toBe('atlas');
    });

    it('both agents share the same DM conversation', async () => {
      const convId1 = await app1.getOrCreateDm('atlas');
      const convId2 = await app2.getOrCreateDm('nova');
      expect(convId1).toBe(convId2);
    });
  });

  describe('group conversation', () => {
    it('owner creates group, agent1 sends message, agent2 receives with group context', async () => {
      const conv = backend.createConversation({
        type: 'group',
        name: 'Team',
        memberUserIds: [owner.userId, agent1.userId, agent2.userId],
        createdBy: owner.userId,
      });

      const received: IncomingMessage[] = [];
      app2.onMessageNew((msg) => received.push(msg));

      await app1.sendMessage(conv.conversationId, 'team update');

      expect(received).toHaveLength(1);
      expect(received[0]?.text).toBe('team update');
      expect(received[0]?.conversationType).toBe('group');
      expect(received[0]?.groupName).toBe('Team');
      expect(received[0]?.senderUsername).toBe('nova');
    });

    it('all members receive messages in group', async () => {
      const conv = backend.createConversation({
        type: 'group',
        name: 'All',
        memberUserIds: [owner.userId, agent1.userId, agent2.userId],
        createdBy: owner.userId,
      });

      const received1: IncomingMessage[] = [];
      const received2: IncomingMessage[] = [];
      app1.onMessageNew((msg) => received1.push(msg));
      app2.onMessageNew((msg) => received2.push(msg));

      // Owner sends via backend directly
      backend.sendMessage({ conversationId: conv.conversationId, senderId: owner.userId, text: 'announcement' });

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received1[0]?.relationship).toBe('owner');
      expect(received2[0]?.relationship).toBe('owner');
    });
  });

  describe('friend request flow', () => {
    it('full flow: request → accept → DM', async () => {
      const human = backend.createUser({ username: 'bob', displayName: 'Bob', accountType: 'human' });

      // Bob sends friend request to agent1
      const contactEvents: ContactEvent[] = [];
      app1.onContactEvent((e) => contactEvents.push(e));
      backend.sendFriendRequest(human.userId, agent1.userId, 'want to chat');

      expect(contactEvents).toHaveLength(1);
      expect(contactEvents[0]?.type).toBe('contact.request_received');
      expect(contactEvents[0]?.username).toBe('bob');

      // Agent1 accepts
      const bobEvents: ContactEvent[] = [];
      const bobApp = new MockNewioApp({ backend, userId: human.userId });
      bobApp.onContactEvent((e) => bobEvents.push(e));

      await app1.acceptFriendRequestByUsername('bob');

      expect(bobEvents).toHaveLength(1);
      expect(bobEvents[0]?.type).toBe('contact.request_accepted');

      // Now they can DM
      await app1.sendDm('bob', 'hi bob');
      const messages = backend.getMessages(await app1.getOrCreateDm('bob'), agent1.userId);
      expect(messages.some((m) => m.content.text === 'hi bob')).toBe(true);

      bobApp.dispose();
    });
  });

  describe('friend removal', () => {
    it('after removal, DM creation fails', async () => {
      const received: ContactEvent[] = [];
      app2.onContactEvent((e) => received.push(e));

      await app1.removeFriendByUsername('atlas');

      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe('contact.removed');
      expect(received[0]?.username).toBe('nova');

      // agent2 can no longer create DM with agent1
      await expect(app2.getOrCreateDm('nova')).rejects.toThrow('not friends');
    });
  });

  describe('own message filtering', () => {
    it('sender receives event with isOwnMessage=true', async () => {
      const convId = await app1.getOrCreateDm('atlas');
      const received: IncomingMessage[] = [];
      app1.onMessageNew((msg) => received.push(msg));

      await app1.sendMessage(convId, 'my own message');

      expect(received).toHaveLength(1);
      expect(received[0]?.isOwnMessage).toBe(true);
      expect(received[0]?.text).toBe('my own message');
    });
  });

  describe('ACL enforcement', () => {
    it('agent cannot send message to conversation it is not a member of', async () => {
      const human = backend.createUser({ username: 'charlie', displayName: 'Charlie', accountType: 'human' });
      backend.addFriendship(owner.userId, human.userId);
      const conv = backend.createConversation({
        type: 'dm',
        memberUserIds: [owner.userId, human.userId],
        createdBy: owner.userId,
      });

      await expect(app1.sendMessage(conv.conversationId, 'sneaky')).rejects.toThrow('not a member');
    });

    it('non-admin cannot add members to group', async () => {
      const conv = backend.createConversation({
        type: 'group',
        name: 'Restricted',
        memberUserIds: [owner.userId, agent1.userId, agent2.userId],
        createdBy: owner.userId,
      });

      const newUser = backend.createUser({ username: 'dan', displayName: 'Dan', accountType: 'human' });
      backend.addFriendship(agent1.userId, newUser.userId);

      // agent1 is a member but not admin
      await expect(app1.addMembersByUsername(conv.conversationId, ['dan'])).rejects.toThrow('not an admin');
    });

    it('agent cannot create DM with non-friend', async () => {
      backend.createUser({ username: 'stranger', displayName: 'Stranger', accountType: 'human' });
      await expect(app1.getOrCreateDm('stranger')).rejects.toThrow('not friends');
    });
  });

  describe('signal delivery', () => {
    it('owner sends rotate_session signal to agent, handler is invoked', async () => {
      const calls: string[] = [];
      app1.onRotateSession(async (req) => {
        calls.push(req.externalReferenceId);
        return { success: true };
      });

      backend.sendSignal(agent1.userId, {
        signalType: 'rotate_session',
        sessionType: 'conversation',
        externalReferenceId: 'conv-123',
      });

      // Allow microtask to resolve
      await new Promise((r) => setTimeout(r, 0));
      expect(calls).toEqual(['conv-123']);
    });

    it('signal is only delivered to target agent', async () => {
      const calls1: string[] = [];
      const calls2: string[] = [];
      app1.onUpdateMemory(async (req) => {
        calls1.push(req.externalReferenceId);
        return { success: true };
      });
      app2.onUpdateMemory(async (req) => {
        calls2.push(req.externalReferenceId);
        return { success: true };
      });

      backend.sendSignal(agent1.userId, {
        signalType: 'update_memory',
        sessionType: 'conversation',
        externalReferenceId: 'conv-abc',
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(calls1).toEqual(['conv-abc']);
      expect(calls2).toEqual([]);
    });
  });

  describe('memory isolation', () => {
    it('agent1 memory is not visible to agent2', async () => {
      await app1.addMemory('secret fact', { username: 'alice' });

      const mem1 = await app1.getContactMemory('alice');
      const mem2 = await app2.getContactMemory('alice');

      expect(mem1.facts).toHaveLength(1);
      expect(mem1.facts[0]?.text).toBe('secret fact');
      expect(mem2.facts).toHaveLength(0);
    });

    it('global memory is isolated per agent', async () => {
      await app1.addMemory('nova global fact');
      await app2.addMemory('atlas global fact');

      const session1 = await app1.loadSessionMemory();
      const session2 = await app2.loadSessionMemory();

      expect(session1.global.facts).toHaveLength(1);
      expect(session1.global.facts[0]?.text).toBe('nova global fact');
      expect(session2.global.facts).toHaveLength(1);
      expect(session2.global.facts[0]?.text).toBe('atlas global fact');
    });
  });

  describe('handoff note isolation', () => {
    it('agent1 handoff notes are not visible to agent2', async () => {
      const convId = await app1.getOrCreateDm('atlas');
      await app1.putHandoffNote(convId, 'working on task X');

      const note1 = await app1.getHandoffNote(convId);
      const note2 = await app2.getHandoffNote(convId);

      expect(note1).toBe('working on task X');
      expect(note2).toBeNull();
    });
  });

  // Cleanup
  afterEach(() => {
    app1.dispose();
    app2.dispose();
  });
});
