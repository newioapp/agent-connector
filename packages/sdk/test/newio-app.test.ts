import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewioApp } from '../src/app/newio-app.js';
import type { IncomingMessage } from '../src/app/types.js';
import type { AuthManager } from '../src/core/auth.js';
import type { NewioClient } from '../src/core/client.js';
import type { NewioWebSocket } from '../src/core/websocket.js';
import type { ContactRecord, ConversationListItem } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContact(overrides: Partial<ContactRecord> = {}): ContactRecord {
  return {
    userId: 'me',
    contactId: overrides.contactId ?? 'contact-1',
    status: 'accepted',
    requesterId: 'me',
    friendAccountType: 'human',
    friendUsername: 'alice',
    friendDisplayName: 'Alice',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    conversationId: overrides.conversationId ?? 'conv-1',
    type: 'dm',
    createdBy: 'me',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const eventHandlers = new Map<string, (event: unknown) => void>();

function mockWs(): NewioWebSocket {
  return {
    on: vi.fn((type: string, handler: (event: unknown) => void) => {
      eventHandlers.set(type, handler);
    }),
    off: vi.fn(),
    onStateChange: vi.fn(),
    offStateChange: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as NewioWebSocket;
}

function mockClient(contacts: ContactRecord[] = [], conversations: ConversationListItem[] = []): NewioClient {
  return {
    listFriends: vi.fn().mockResolvedValue({ contacts, cursor: undefined }),
    listConversations: vi.fn().mockResolvedValue({ conversations, cursor: undefined }),
    sendMessage: vi.fn().mockResolvedValue({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      senderId: 'me',
      content: {},
      createdAt: '2026-01-01T00:00:00Z',
    }),
    getUserByUsername: vi.fn().mockResolvedValue({ userId: 'resolved-id' }),
    createConversation: vi.fn().mockResolvedValue({
      conversationId: 'new-conv',
      type: 'dm',
      createdBy: 'me',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      members: [],
    }),
    getConversation: vi.fn().mockResolvedValue({
      conversationId: 'conv-1',
      type: 'dm',
      createdBy: 'me',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      members: [{ userId: 'me', role: 'member', accountType: 'agent', joinedAt: '2026-01-01T00:00:00Z' }],
    }),
    listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    listIncomingRequests: vi.fn().mockResolvedValue({ contacts: [] }),
    sendFriendRequest: vi.fn().mockResolvedValue({}),
    acceptFriendRequest: vi.fn().mockResolvedValue({}),
    rejectFriendRequest: vi.fn().mockResolvedValue({}),
    removeFriend: vi.fn().mockResolvedValue(undefined),
    getUserSummaries: vi.fn().mockResolvedValue({ users: [] }),
  } as unknown as NewioClient;
}

function mockAuth(): AuthManager {
  return {
    getAccessToken: vi.fn().mockReturnValue('token'),
    getRefreshToken: vi.fn().mockReturnValue('refresh'),
    tokenProvider: vi.fn().mockReturnValue('token'),
    dispose: vi.fn(),
    revoke: vi.fn(),
  } as unknown as AuthManager;
}

const identity = { userId: 'me', username: 'myagent', displayName: 'My Agent', ownerId: 'owner-1' };

async function createApp(
  contacts: ContactRecord[] = [],
  conversations: ConversationListItem[] = [],
): Promise<{ app: NewioApp; client: NewioClient; ws: NewioWebSocket }> {
  eventHandlers.clear();
  const client = mockClient(contacts, conversations);
  const ws = mockWs();
  const app = NewioApp.createFromComponents(identity, mockAuth(), client, ws);
  await app.init();
  return { app, client, ws };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NewioApp', () => {
  beforeEach(() => {
    eventHandlers.clear();
  });

  describe('init', () => {
    it('loads contacts and conversations on creation', async () => {
      const contact = makeContact();
      const conv = makeConversation();
      const { app } = await createApp([contact], [conv]);

      expect(app.getAllContacts()).toHaveLength(1);
      expect(app.getAllConversations()).toHaveLength(1);
    });

    it('indexes contacts by username (case-insensitive)', async () => {
      const contact = makeContact({ contactId: 'user-alice', friendUsername: 'Alice' });
      const { app } = await createApp([contact]);

      expect(app.isContact('Alice')).toBe(true);
      expect(app.isContact('alice')).toBe(true);
      expect(app.isContact('nonexistent')).toBe(false);
      expect(app.getContact('alice')).toBeDefined();
      expect(app.getContact('alice')?.username).toBe('Alice');
    });
  });

  describe('resolveUsername', () => {
    it('resolves from contact cache', async () => {
      const contact = makeContact({ contactId: 'user-bob', friendUsername: 'bob' });
      const { app } = await createApp([contact]);

      const userId = await app.resolveUsername('bob');
      expect(userId).toBe('user-bob');
    });

    it('resolves case-insensitively', async () => {
      const contact = makeContact({ contactId: 'user-bob', friendUsername: 'Bob' });
      const { app } = await createApp([contact]);

      const userId = await app.resolveUsername('bob');
      expect(userId).toBe('user-bob');
    });

    it('falls back to API when not in contacts', async () => {
      const { app, client } = await createApp();

      const userId = await app.resolveUsername('stranger');
      expect(userId).toBe('resolved-id');
      expect(client.getUserByUsername).toHaveBeenCalledWith({ username: 'stranger' });
    });
  });

  describe('sendMessage', () => {
    it('sends message without client-side sequenceNumber', async () => {
      const { app, client } = await createApp();

      await app.sendMessage('conv-1', 'hello');
      await app.sendMessage('conv-1', 'world');

      expect(client.sendMessage).toHaveBeenCalledTimes(2);
      expect(client.sendMessage).toHaveBeenNthCalledWith(1, {
        conversationId: 'conv-1',
        content: { text: 'hello' },
      });
      expect(client.sendMessage).toHaveBeenNthCalledWith(2, {
        conversationId: 'conv-1',
        content: { text: 'world' },
      });
    });
  });

  describe('incoming messages', () => {
    it('delivers messages to handler', async () => {
      const contact = makeContact({ contactId: 'sender-1', friendUsername: 'alice', friendDisplayName: 'Alice' });
      const conv = makeConversation({ conversationId: 'conv-1' });
      const { app } = await createApp([contact], [conv]);

      const received: IncomingMessage[] = [];
      app.on('message.new', (msg) => received.push(msg));

      const handler = eventHandlers.get('message.new');
      handler?.({
        type: 'message.new',
        timestamp: '2026-01-01T00:00:00Z',
        payload: {
          conversationId: 'conv-1',
          messageId: 'msg-1',
          senderId: 'sender-1',
          content: { text: 'hello' },
          sequenceNumber: 1,
          createdAt: '2026-01-01T00:00:00Z',
          conversationType: 'dm',
        },
      });

      // Wait for the per-conversation message queue to process
      await new Promise((r) => setTimeout(r, 0));

      expect(received).toHaveLength(1);
      expect(received[0].text).toBe('hello');
      expect(received[0].senderUsername).toBe('alice');
      expect(received[0].inContact).toBe(true);
    });

    it('ignores own messages', async () => {
      const { app } = await createApp();

      const received: IncomingMessage[] = [];
      app.on('message.new', (msg) => received.push(msg));

      eventHandlers.get('message.new')?.({
        type: 'message.new',
        timestamp: '2026-01-01T00:00:00Z',
        payload: {
          conversationId: 'conv-1',
          messageId: 'msg-1',
          senderId: 'me',
          content: { text: 'my own message' },
          sequenceNumber: 1,
          createdAt: '2026-01-01T00:00:00Z',
          conversationType: 'dm',
        },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(received).toHaveLength(0);
    });

    it('delivers messages without text with empty string', async () => {
      const contact = makeContact({ contactId: 'other' });
      const { app } = await createApp([contact]);

      const received: IncomingMessage[] = [];
      app.on('message.new', (msg) => received.push(msg));

      eventHandlers.get('message.new')?.({
        type: 'message.new',
        timestamp: '2026-01-01T00:00:00Z',
        payload: {
          conversationId: 'conv-1',
          messageId: 'msg-1',
          senderId: 'other',
          content: {},
          sequenceNumber: 1,
          createdAt: '2026-01-01T00:00:00Z',
          conversationType: 'dm',
        },
      });

      // Wait for the per-conversation message queue to process
      await new Promise((r) => setTimeout(r, 0));

      expect(received).toHaveLength(1);
      expect(received[0].text).toBe('');
    });
  });

  describe('WebSocket event handling', () => {
    it('updates contacts on friend accepted', async () => {
      const { app } = await createApp();

      expect(app.isContact('newfriend')).toBe(false);

      eventHandlers.get('contact.request_accepted')?.({
        type: 'contact.request_accepted',
        timestamp: '2026-01-01T00:00:00Z',
        payload: { contact: makeContact({ contactId: 'new-friend', friendUsername: 'newfriend' }) },
      });

      expect(app.isContact('newfriend')).toBe(true);
    });

    it('removes contacts on friend removed', async () => {
      const contact = makeContact({ contactId: 'user-alice', friendUsername: 'alice' });
      const { app } = await createApp([contact]);

      expect(app.isContact('alice')).toBe(true);

      eventHandlers.get('contact.removed')?.({
        type: 'contact.removed',
        timestamp: '2026-01-01T00:00:00Z',
        payload: { userId: 'me', contactId: 'user-alice' },
      });

      expect(app.isContact('alice')).toBe(false);
    });

    it('adds new conversations', async () => {
      const { app } = await createApp();

      eventHandlers.get('conversation.new')?.({
        type: 'conversation.new',
        timestamp: '2026-01-01T00:00:00Z',
        payload: makeConversation({ conversationId: 'new-conv', type: 'group', name: 'New Group' }),
      });

      expect(app.getConversation('new-conv')).toBeDefined();
      expect(app.getConversation('new-conv')?.name).toBe('New Group');
    });
  });

  describe('cron scheduling (smoke — detailed tests in cron.test.ts)', () => {
    it('delegates to CronScheduler', async () => {
      vi.useFakeTimers();
      const { app } = await createApp();
      const triggered: string[] = [];
      app.on('cron.triggered', (e) => triggered.push(e.cronId));

      app.scheduleCron({ cronId: 'c1', expression: 'every 1s', newioSessionId: 's1', label: 'Test' });
      expect(app.listCrons()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1100);
      expect(triggered).toEqual(['c1']);

      app.cancelCron('c1');
      expect(app.listCrons()).toHaveLength(0);
      vi.useRealTimers();
    });
  });

  describe('sendDm', () => {
    it('resolves username and creates DM', async () => {
      const { app, client } = await createApp();

      await app.sendDm('stranger', 'hello');

      expect(client.getUserByUsername).toHaveBeenCalledWith({ username: 'stranger' });
      expect(client.createConversation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'dm', memberIds: ['resolved-id'] }),
      );
      expect(client.sendMessage).toHaveBeenCalled();
    });

    it('reuses existing DM when found in store', async () => {
      const conv = makeConversation({ conversationId: 'dm-existing', type: 'dm' });
      const contact = makeContact({ contactId: 'user-alice', friendUsername: 'alice' });
      const client = mockClient([contact], [conv]);
      // Mock getConversation to return members including alice
      (client.getConversation as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...conv,
        members: [
          { userId: 'me', role: 'member', accountType: 'agent', joinedAt: '' },
          { userId: 'user-alice', role: 'member', accountType: 'human', joinedAt: '' },
        ],
      });
      const ws = mockWs();
      const app = NewioApp.createFromComponents(identity, mockAuth(), client, ws);
      await app.init();

      await app.sendDm('alice', 'hi');

      // Should NOT create a new conversation
      expect(client.createConversation).not.toHaveBeenCalled();
      expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'dm-existing' }));
    });
  });

  describe('dmOwner', () => {
    it('sends DM to owner', async () => {
      const { app, client } = await createApp();

      await app.dmOwner('hello owner');

      expect(client.createConversation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'dm', memberIds: ['owner-1'] }),
      );
      expect(client.sendMessage).toHaveBeenCalled();
    });

    it('is a no-op when no ownerId', async () => {
      const client = mockClient();
      const ws = mockWs();
      const noOwnerIdentity = { userId: 'me', username: 'myagent', displayName: 'My Agent' };
      const app = NewioApp.createFromComponents(noOwnerIdentity, mockAuth(), client, ws);
      await app.init();

      await app.dmOwner('hello');

      expect(client.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('getOwnerDmConversationId', () => {
    it('returns undefined when no ownerId', async () => {
      const client = mockClient();
      const ws = mockWs();
      const noOwnerIdentity = { userId: 'me', username: 'myagent', displayName: 'My Agent' };
      const app = NewioApp.createFromComponents(noOwnerIdentity, mockAuth(), client, ws);
      await app.init();

      expect(await app.getOwnerDmConversationId()).toBeUndefined();
    });
  });

  describe('contact methods', () => {
    it('sendFriendRequestByUsername resolves username then sends', async () => {
      const { app, client } = await createApp();

      await app.sendFriendRequestByUsername('stranger', 'Hi!');

      expect(client.getUserByUsername).toHaveBeenCalledWith({ username: 'stranger' });
      expect(client.sendFriendRequest).toHaveBeenCalledWith({ contactId: 'resolved-id', note: 'Hi!' });
    });

    it('removeFriendByUsername resolves and removes', async () => {
      const contact = makeContact({ contactId: 'user-alice', friendUsername: 'alice' });
      const { app, client } = await createApp([contact]);

      await app.removeFriendByUsername('alice');

      expect(client.removeFriend).toHaveBeenCalledWith({ userId: 'user-alice' });
    });

    it('listIncomingFriendRequests returns summaries from store', async () => {
      const { app } = await createApp();

      // Simulate a friend request arriving via WebSocket
      eventHandlers.get('contact.request_received')?.({
        type: 'contact.request_received',
        timestamp: '2026-01-01T00:00:00Z',
        payload: {
          contact: makeContact({
            contactId: 'req-1',
            friendUsername: 'bob',
            friendDisplayName: 'Bob',
            status: 'pending',
            note: 'Hey!',
          }),
        },
      });

      const requests = app.listIncomingFriendRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].username).toBe('bob');
      expect(requests[0].note).toBe('Hey!');
    });

    it('acceptFriendRequestByUsername accepts and indexes contact', async () => {
      const { app, client } = await createApp();

      // Simulate incoming request
      eventHandlers.get('contact.request_received')?.({
        type: 'contact.request_received',
        timestamp: '2026-01-01T00:00:00Z',
        payload: {
          contact: makeContact({ contactId: 'req-bob', friendUsername: 'bob', status: 'pending' }),
        },
      });

      (client.acceptFriendRequest as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await app.acceptFriendRequestByUsername('bob');

      expect(client.acceptFriendRequest).toHaveBeenCalledWith({ requestId: 'req-bob' });
      expect(app.isContact('bob')).toBe(true);
      expect(app.listIncomingFriendRequests()).toHaveLength(0);
    });

    it('rejectFriendRequestByUsername rejects and removes from store', async () => {
      const { app, client } = await createApp();

      eventHandlers.get('contact.request_received')?.({
        type: 'contact.request_received',
        timestamp: '2026-01-01T00:00:00Z',
        payload: {
          contact: makeContact({ contactId: 'req-bob', friendUsername: 'bob', status: 'pending' }),
        },
      });

      (client.rejectFriendRequest as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await app.rejectFriendRequestByUsername('bob');

      expect(client.rejectFriendRequest).toHaveBeenCalledWith({ requestId: 'req-bob' });
      expect(app.listIncomingFriendRequests()).toHaveLength(0);
    });

    it('acceptFriendRequestByUsername backfills from API when not in cache', async () => {
      const { app, client } = await createApp();

      // No request in cache — should call listIncomingRequests
      (client.listIncomingRequests as ReturnType<typeof vi.fn>).mockResolvedValue({
        contacts: [makeContact({ contactId: 'req-bob', friendUsername: 'bob', status: 'pending' })],
      });
      (client.acceptFriendRequest as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await app.acceptFriendRequestByUsername('bob');

      expect(client.listIncomingRequests).toHaveBeenCalled();
      expect(client.acceptFriendRequest).toHaveBeenCalledWith({ requestId: 'req-bob' });
    });
  });

  describe('createGroup', () => {
    it('resolves usernames and creates group', async () => {
      const { app, client } = await createApp();

      const convId = await app.createGroup('My Group', ['stranger1', 'stranger2']);

      expect(convId).toBe('new-conv');
      expect(client.createConversation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'group', name: 'My Group' }),
      );
    });

    it('filters out self from member list', async () => {
      const { app, client } = await createApp();

      await app.createGroup('My Group', ['myagent', 'stranger1']);

      const call = (client.createConversation as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.memberIds).toHaveLength(1); // myagent filtered out
    });
  });

  describe('createWorkSession', () => {
    it('creates temp_group conversation', async () => {
      const { app, client } = await createApp();

      await app.createWorkSession('Session', ['stranger1']);

      expect(client.createConversation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'temp_group', name: 'Session' }),
      );
    });
  });

  describe('getRecentMessages', () => {
    it('returns empty array for unknown conversation', async () => {
      const { app } = await createApp();
      expect(app.getRecentMessages('unknown')).toEqual([]);
    });
  });

  describe('getSessionId', () => {
    it('returns undefined for unknown conversation', async () => {
      const { app } = await createApp();
      expect(app.getSessionId('unknown')).toBeUndefined();
    });
  });

  describe('resolveSessionId', () => {
    it('returns cached sessionId', async () => {
      const conv = makeConversation({ conversationId: 'c1', sessionId: 's1' });
      const { app } = await createApp([], [conv]);

      const sessionId = await app.resolveSessionId('c1');
      expect(sessionId).toBe('s1');
    });

    it('fetches from API when not cached', async () => {
      const { app, client } = await createApp();
      (client.getConversation as ReturnType<typeof vi.fn>).mockResolvedValue({
        conversationId: 'c2',
        type: 'dm',
        members: [{ userId: 'me', sessionId: 's-from-api' }],
      });

      const sessionId = await app.resolveSessionId('c2');
      expect(sessionId).toBe('s-from-api');
      expect(client.getConversation).toHaveBeenCalledWith({ conversationId: 'c2' });
    });

    it('throws when no sessionId exists', async () => {
      const { app, client } = await createApp();
      (client.getConversation as ReturnType<typeof vi.fn>).mockResolvedValue({
        conversationId: 'c3',
        type: 'dm',
        members: [{ userId: 'me' }],
      });

      await expect(app.resolveSessionId('c3')).rejects.toThrow('No session ID found');
    });
  });

  describe('getMembers', () => {
    it('returns member summaries with contact info', async () => {
      const contact = makeContact({ contactId: 'user-alice', friendUsername: 'alice', friendDisplayName: 'Alice' });
      const { app, client } = await createApp([contact]);
      (client.getConversation as ReturnType<typeof vi.fn>).mockResolvedValue({
        conversationId: 'c1',
        type: 'dm',
        members: [
          { userId: 'me', role: 'member', accountType: 'agent' },
          { userId: 'user-alice', role: 'member', accountType: 'human' },
        ],
      });

      const members = await app.getMembers('c1');
      expect(members).toHaveLength(2);

      const self = members.find((m) => m.username === 'myagent');
      expect(self?.displayName).toBe('My Agent');

      const alice = members.find((m) => m.username === 'alice');
      expect(alice?.displayName).toBe('Alice');
    });
  });

  describe('sendActionRequest', () => {
    it('sends action message and returns response on resolve', async () => {
      const { app, client } = await createApp();

      const action = {
        requestId: 'req-1',
        type: 'permission',
        title: 'Allow?',
        options: [{ optionId: 'yes', label: 'Yes' }],
      };
      const promise = app.sendActionRequest('conv-1', action, ['owner-1'], 5000);

      expect(client.sendMessage).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        content: { action },
        visibleTo: ['owner-1'],
      });

      // Simulate response arriving via WebSocket
      eventHandlers.get('message.new')?.({
        type: 'message.new',
        timestamp: '2026-01-01T00:00:00Z',
        payload: {
          conversationId: 'conv-1',
          messageId: 'resp-1',
          senderId: 'owner-1',
          content: { response: { requestId: 'req-1', selectedOptionId: 'yes' } },
          sequenceNumber: 2,
          createdAt: '2026-01-01T00:00:00Z',
          conversationType: 'dm',
        },
      });

      const response = await promise;
      expect(response.selectedOptionId).toBe('yes');
    });
  });

  describe('getOwnerDisplayName', () => {
    it('returns owner display name from contacts', async () => {
      const ownerContact = makeContact({ contactId: 'owner-1', friendUsername: 'nan', friendDisplayName: 'Nan' });
      const { app } = await createApp([ownerContact]);

      expect(app.getOwnerDisplayName()).toBe('Nan');
    });

    it('falls back to username when no displayName', async () => {
      const ownerContact = makeContact({ contactId: 'owner-1', friendUsername: 'nan', friendDisplayName: undefined });
      const { app } = await createApp([ownerContact]);

      expect(app.getOwnerDisplayName()).toBe('nan');
    });

    it('returns undefined when owner not in contacts', async () => {
      const { app } = await createApp();
      expect(app.getOwnerDisplayName()).toBeUndefined();
    });
  });

  describe('getConversation', () => {
    it('returns conversation summary', async () => {
      const conv = makeConversation({ conversationId: 'c1', type: 'group', name: 'Team' });
      const { app } = await createApp([], [conv]);

      const result = app.getConversation('c1');
      expect(result?.name).toBe('Team');
      expect(result?.type).toBe('group');
    });

    it('returns undefined for unknown conversation', async () => {
      const { app } = await createApp();
      expect(app.getConversation('unknown')).toBeUndefined();
    });
  });

  describe('getAllConversations', () => {
    it('returns all conversations as summaries', async () => {
      const convs = [makeConversation({ conversationId: 'c1' }), makeConversation({ conversationId: 'c2' })];
      const { app } = await createApp([], convs);

      expect(app.getAllConversations()).toHaveLength(2);
    });
  });

  describe('getAllContacts', () => {
    it('returns all contacts as summaries', async () => {
      const contacts = [makeContact({ contactId: 'u1' }), makeContact({ contactId: 'u2' })];
      const { app } = await createApp(contacts);

      expect(app.getAllContacts()).toHaveLength(2);
    });
  });

  describe('dispose', () => {
    it('cancels cron jobs and disconnects', async () => {
      vi.useFakeTimers();
      const { app, ws } = await createApp();
      app.scheduleCron({ cronId: 'c1', expression: 'every 1s', newioSessionId: 's1', label: 'Test' });

      app.dispose();

      expect(app.listCrons()).toHaveLength(0);
      expect(ws.disconnect).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
