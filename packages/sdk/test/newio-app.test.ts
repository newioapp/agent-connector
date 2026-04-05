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
      app.onMessage((msg) => received.push(msg));

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

      expect(received).toHaveLength(1);
      expect(received[0].text).toBe('hello');
      expect(received[0].senderUsername).toBe('alice');
      expect(received[0].inContact).toBe(true);
    });

    it('ignores own messages', async () => {
      const { app } = await createApp();

      const received: IncomingMessage[] = [];
      app.onMessage((msg) => received.push(msg));

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

      expect(received).toHaveLength(0);
    });

    it('delivers messages without text with empty string', async () => {
      const contact = makeContact({ contactId: 'other' });
      const { app } = await createApp([contact]);

      const received: IncomingMessage[] = [];
      app.onMessage((msg) => received.push(msg));

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
});
