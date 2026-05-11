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
    setOnSignal: vi.fn(),
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
    getMemory: vi.fn().mockResolvedValue({
      data: { summary: null, facts: [{ factId: 'f1', text: 'Test', createdAt: 't', updatedAt: 't' }] },
    }),
    batchUpdateMemory: vi.fn().mockResolvedValue({ applied: 1 }),
    touchMemoryScope: vi.fn().mockResolvedValue({}),
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
      expect(received[0].relationship).toBe('in-contact');
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

      app.scheduleCron({ cronId: 'c1', expression: 'every 1s', label: 'Test' });
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

      // Simulate incoming request (userId = sender, contactId = me)
      eventHandlers.get('contact.request_received')?.({
        type: 'contact.request_received',
        timestamp: '2026-01-01T00:00:00Z',
        payload: {
          contact: makeContact({ userId: 'req-bob', contactId: 'me', friendUsername: 'bob', status: 'pending' }),
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
          contact: makeContact({ userId: 'req-bob', contactId: 'me', friendUsername: 'bob', status: 'pending' }),
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
        contacts: [makeContact({ userId: 'req-bob', contactId: 'me', friendUsername: 'bob', status: 'pending' })],
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
      const promise = app.sendActionRequest('conv-1', action, undefined, ['owner-1'], 5000);

      expect(client.sendMessage).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        content: { action, text: undefined },
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

  describe('getOwnerInfo', () => {
    it('returns owner info from contacts', async () => {
      const ownerContact = makeContact({ contactId: 'owner-1', friendUsername: 'nan', friendDisplayName: 'Nan' });
      const { app } = await createApp([ownerContact]);

      const info = app.getOwnerInfo();
      expect(info.username).toBe('nan');
      expect(info.displayName).toBe('Nan');
    });

    it('throws when owner missing displayName', async () => {
      const ownerContact = makeContact({ contactId: 'owner-1', friendUsername: 'nan', friendDisplayName: undefined });
      const { app } = await createApp([ownerContact]);

      expect(() => app.getOwnerInfo()).toThrow('Owner is missing username or display name');
    });

    it('throws when owner not in contacts', async () => {
      const { app } = await createApp();
      expect(() => app.getOwnerInfo()).toThrow('Owner not found in contacts');
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
      app.scheduleCron({ cronId: 'c1', expression: 'every 1s', label: 'Test' });

      app.dispose();

      expect(app.listCrons()).toHaveLength(0);
      expect(ws.disconnect).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('signal handlers', () => {
    it('onLiveSessionInfo registers handler accessible via _getSignalHandlers', async () => {
      const { app } = await createApp();
      const handler = vi.fn().mockReturnValue({
        sessionId: 's1',
        availableModels: [],
        availableModes: [],
        canCancel: true,
        canCompact: false,
      });
      app.onLiveSessionInfo(handler);
      const handlers = app._getSignalHandlers();
      handlers.liveSessionInfo({ sessionId: 's1' });
      expect(handler).toHaveBeenCalledWith({ sessionId: 's1' });
    });

    it('onCancelSession registers handler accessible via _getSignalHandlers', async () => {
      const { app } = await createApp();
      const handler = vi.fn().mockResolvedValue({ success: true });
      app.onCancelSession(handler);
      const handlers = app._getSignalHandlers();
      await handlers.cancelSession({ sessionId: 's1' });
      expect(handler).toHaveBeenCalledWith({ sessionId: 's1' });
    });

    it('onCompactSession registers handler accessible via _getSignalHandlers', async () => {
      const { app } = await createApp();
      const handler = vi.fn().mockResolvedValue({ success: true });
      app.onCompactSession(handler);
      const handlers = app._getSignalHandlers();
      await handlers.compactSession({ sessionId: 's1' });
      expect(handler).toHaveBeenCalledWith({ sessionId: 's1' });
    });

    it('default liveSessionInfo handler returns empty info', async () => {
      const { app } = await createApp();
      const result = app
        ._getSignalHandlers()
        .liveSessionInfo({ sessionType: 'conversation', externalReferenceId: 'c1' });
      expect(result).toEqual({
        sessionType: 'conversation',
        externalReferenceId: 'c1',
        isLive: false,
        availableModels: [],
        availableModes: [],
        canCancel: false,
        canCompact: false,
      });
    });

    it('default cancelSession handler returns error', async () => {
      const { app } = await createApp();
      const result = await app._getSignalHandlers().cancelSession({ sessionId: 's1' });
      expect(result).toEqual({ success: false, errorCode: 'not_implemented', error: 'No handler registered' });
    });

    it('default compactSession handler returns error', async () => {
      const { app } = await createApp();
      const result = await app._getSignalHandlers().compactSession({ sessionId: 's1' });
      expect(result).toEqual({ success: false, errorCode: 'not_implemented', error: 'No handler registered' });
    });

    it('onUpdateMemory registers handler accessible via _getSignalHandlers', async () => {
      const { app } = await createApp();
      const handler = vi.fn().mockResolvedValue({ success: true });
      app.onUpdateMemory(handler);
      const handlers = app._getSignalHandlers();
      await handlers.updateMemory({ sessionType: 'conversation', externalReferenceId: 'c1' });
      expect(handler).toHaveBeenCalledWith({ sessionType: 'conversation', externalReferenceId: 'c1' });
    });

    it('default updateMemory handler returns error', async () => {
      const { app } = await createApp();
      const result = await app
        ._getSignalHandlers()
        .updateMemory({ sessionType: 'conversation', externalReferenceId: 'c1' });
      expect(result).toEqual({ success: false, errorCode: 'not_implemented', error: 'No handler registered' });
    });

    it('onRotateSession registers handler accessible via _getSignalHandlers', async () => {
      const { app } = await createApp();
      const handler = vi.fn().mockResolvedValue({ success: true });
      app.onRotateSession(handler);
      const handlers = app._getSignalHandlers();
      await handlers.rotateSession({ sessionType: 'conversation', externalReferenceId: 'c1' });
      expect(handler).toHaveBeenCalledWith({ sessionType: 'conversation', externalReferenceId: 'c1' });
    });

    it('default rotateSession handler returns error', async () => {
      const { app } = await createApp();
      const result = await app
        ._getSignalHandlers()
        .rotateSession({ sessionType: 'conversation', externalReferenceId: 'c1' });
      expect(result).toEqual({ success: false, errorCode: 'not_implemented', error: 'No handler registered' });
    });
  });

  describe('memory', () => {
    it('getGlobalMemory calls client.getMemory with global scope', async () => {
      const { app, client } = await createApp();
      const result = await app.getGlobalMemory();
      expect(result.facts).toHaveLength(1);
      expect(client.getMemory).toHaveBeenCalledWith({ agentId: 'me', scope: 'global', scopeId: '_' });
    });

    it('getContactMemory resolves username and calls client.getMemory', async () => {
      const { app, client } = await createApp();
      await app.getContactMemory('alice');
      expect(client.getUserByUsername).toHaveBeenCalledWith({ username: 'alice' });
      expect(client.getMemory).toHaveBeenCalledWith({ agentId: 'me', scope: 'user', scopeId: 'resolved-id' });
    });

    it('getConversationMemory calls client.getMemory with conversation scope', async () => {
      const { app, client } = await createApp();
      await app.getConversationMemory('conv-1');
      expect(client.getMemory).toHaveBeenCalledWith({ agentId: 'me', scope: 'conversation', scopeId: 'conv-1' });
    });

    it('addMemory with username resolves and calls batchUpdateMemory', async () => {
      const { app, client } = await createApp();
      await app.addMemory('Likes Python', { username: 'alice' });
      expect(client.batchUpdateMemory).toHaveBeenCalledWith({
        agentId: 'me',
        operations: [{ op: 'add', scope: 'user', scopeId: 'resolved-id', text: 'Likes Python' }],
      });
    });

    it('addMemory with no opts uses global scope', async () => {
      const { app, client } = await createApp();
      await app.addMemory('I prefer concise answers');
      expect(client.batchUpdateMemory).toHaveBeenCalledWith({
        agentId: 'me',
        operations: [{ op: 'add', scope: 'global', scopeId: '_', text: 'I prefer concise answers' }],
      });
    });

    it('updateMemory calls batchUpdateMemory with update op', async () => {
      const { app, client } = await createApp();
      await app.updateMemory('f1', 'Updated fact', { conversationId: 'conv-1' });
      expect(client.batchUpdateMemory).toHaveBeenCalledWith({
        agentId: 'me',
        operations: [{ op: 'update', scope: 'conversation', scopeId: 'conv-1', factId: 'f1', text: 'Updated fact' }],
      });
    });

    it('deleteMemory calls batchUpdateMemory with delete op', async () => {
      const { app, client } = await createApp();
      await app.deleteMemory('f1');
      expect(client.batchUpdateMemory).toHaveBeenCalledWith({
        agentId: 'me',
        operations: [{ op: 'delete', scope: 'global', scopeId: '_', factId: 'f1' }],
      });
    });

    it('updateMemorySummary calls batchUpdateMemory with update_summary op', async () => {
      const { app, client } = await createApp();
      await app.updateMemorySummary('A helpful agent', { username: 'alice' });
      expect(client.batchUpdateMemory).toHaveBeenCalledWith({
        agentId: 'me',
        operations: [{ op: 'update_summary', scope: 'user', scopeId: 'resolved-id', text: 'A helpful agent' }],
      });
    });

    it('resolveMemoryScope throws if both username and conversationId provided', async () => {
      const { app } = await createApp();
      await expect(app.addMemory('test', { username: 'alice', conversationId: 'conv-1' })).rejects.toThrow(
        'Provide either username or conversationId, not both',
      );
    });
  });
});
