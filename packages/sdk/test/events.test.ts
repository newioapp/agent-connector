import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wireEvents } from '../src/app/events.js';
import { NewioAppStore } from '../src/app/store.js';
import { PendingActions } from '../src/app/pending-actions.js';
import type { NewioWebSocket } from '../src/core/websocket.js';
import type { NewioClient } from '../src/core/client.js';
import type { EventMap } from '../src/core/events.js';
import type { AppEventHandlers, NewioIdentity } from '../src/app/types.js';
import type { MessageProcessor } from '../src/app/message-processor.js';
import type { ContactRecord } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HandlerMap = { [K in keyof EventMap]?: (event: EventMap[K]) => void };

function createMockWs(): NewioWebSocket & {
  handlers: HandlerMap;
  fire: <K extends keyof EventMap>(type: K, event: EventMap[K]) => void;
} {
  const handlers: HandlerMap = {};
  return {
    handlers,
    on: vi.fn((type: string, handler: (event: never) => void) => {
      (handlers as Record<string, unknown>)[type] = handler;
    }),
    fire<K extends keyof EventMap>(type: K, event: EventMap[K]) {
      const h = handlers[type] as ((event: EventMap[K]) => void) | undefined;
      h?.(event);
    },
  } as unknown as NewioWebSocket & {
    handlers: HandlerMap;
    fire: <K extends keyof EventMap>(type: K, event: EventMap[K]) => void;
  };
}

function createMockClient(overrides: Partial<NewioClient> = {}): NewioClient {
  return {
    getConversation: vi.fn().mockResolvedValue({
      conversationId: 'c1',
      type: 'dm',
      name: undefined,
      createdBy: 'u1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      members: [{ userId: 'me', notifyLevel: 'all', sessionId: 's1' }],
    }),
    ...overrides,
  } as unknown as NewioClient;
}

const identity: NewioIdentity = { userId: 'me', username: 'bot', displayName: 'Bot' };

const ts = '2026-01-01T00:00:00Z';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wireEvents', () => {
  let ws: ReturnType<typeof createMockWs>;
  let store: NewioAppStore;
  let client: NewioClient;
  let handlers: Partial<AppEventHandlers>;
  let pendingActions: PendingActions;
  let processor: MessageProcessor;

  beforeEach(() => {
    ws = createMockWs();
    store = new NewioAppStore();
    client = createMockClient();
    handlers = {};
    pendingActions = new PendingActions();
    processor = { handleMessageNew: vi.fn().mockResolvedValue(undefined) } as unknown as MessageProcessor;

    wireEvents(ws, store, client, identity, () => handlers, pendingActions, processor);
  });

  // -----------------------------------------------------------------------
  // message.new
  // -----------------------------------------------------------------------

  it('delegates message.new to processor', async () => {
    const payload = {
      conversationId: 'c1',
      messageId: 'm1',
      senderId: 'u1',
      content: { text: 'hi' },
      sequenceNumber: 1,
      createdAt: ts,
      senderDisplayName: 'U1',
      conversationType: 'dm' as const,
    };
    ws.fire('message.new', { type: 'message.new', timestamp: ts, payload });
    // Let the microtask queue flush
    await vi.waitFor(() => expect(processor.handleMessageNew).toHaveBeenCalledWith(payload));
  });

  // -----------------------------------------------------------------------
  // conversation.new
  // -----------------------------------------------------------------------

  it('stores new conversation and loads details', async () => {
    ws.fire('conversation.new', {
      type: 'conversation.new',
      timestamp: ts,
      payload: { conversationId: 'c-new', type: 'group', name: 'Team', createdBy: 'u1' },
    });
    expect(store.hasConversation('c-new')).toBe(true);
    // loadConversation is async — wait for it
    await vi.waitFor(() => expect(client.getConversation).toHaveBeenCalled());
  });

  // -----------------------------------------------------------------------
  // conversation.updated
  // -----------------------------------------------------------------------

  it('updates existing conversation fields', () => {
    store.setConversation({ conversationId: 'c1', type: 'dm', name: 'Old', createdAt: ts, updatedAt: ts });
    ws.fire('conversation.updated', {
      type: 'conversation.updated',
      timestamp: ts,
      payload: { conversationId: 'c1', updatedBy: 'u1', changes: { name: 'New', description: 'desc' } },
    });
    expect(store.getConversation('c1')?.name).toBe('New');
    expect(store.getConversation('c1')?.description).toBe('desc');
  });

  it('ignores conversation.updated for unknown conversation', () => {
    ws.fire('conversation.updated', {
      type: 'conversation.updated',
      timestamp: ts,
      payload: { conversationId: 'unknown', updatedBy: 'u1', changes: { name: 'x' } },
    });
    expect(store.getConversation('unknown')).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // conversation.member_added
  // -----------------------------------------------------------------------

  it('adds members to store', () => {
    store.setMembers('c1', []);
    ws.fire('conversation.member_added', {
      type: 'conversation.member_added',
      timestamp: ts,
      payload: {
        conversationId: 'c1',
        addedBy: 'u1',
        members: [{ userId: 'u2', displayName: 'U2', accountType: 'human' }],
      },
    });
    expect(store.getMembers('c1')?.has('u2')).toBe(true);
  });

  it('sets sessionId when self is added with sessionId', () => {
    store.setMembers('c1', []);
    ws.fire('conversation.member_added', {
      type: 'conversation.member_added',
      timestamp: ts,
      payload: { conversationId: 'c1', addedBy: 'u1', members: [{ userId: 'me', sessionId: 's99' }] },
    });
    expect(store.getSessionId('c1')).toBe('s99');
  });

  it('loads conversation when self is added to unknown conversation', async () => {
    ws.fire('conversation.member_added', {
      type: 'conversation.member_added',
      timestamp: ts,
      payload: { conversationId: 'c-unknown', addedBy: 'u1', members: [{ userId: 'me' }] },
    });
    await vi.waitFor(() => expect(client.getConversation).toHaveBeenCalledWith({ conversationId: 'c-unknown' }));
  });

  // -----------------------------------------------------------------------
  // conversation.member_removed
  // -----------------------------------------------------------------------

  it('removes member from store', () => {
    store.setMembers('c1', [{ userId: 'u2' } as never]);
    ws.fire('conversation.member_removed', {
      type: 'conversation.member_removed',
      timestamp: ts,
      payload: { conversationId: 'c1', removedBy: 'u1', targetUserId: 'u2' },
    });
    expect(store.getMembers('c1')?.has('u2')).toBe(false);
  });

  it('removes conversation when self is removed', () => {
    store.setConversation({ conversationId: 'c1', type: 'dm', createdAt: ts, updatedAt: ts });
    ws.fire('conversation.member_removed', {
      type: 'conversation.member_removed',
      timestamp: ts,
      payload: { conversationId: 'c1', removedBy: 'u1', targetUserId: 'me' },
    });
    expect(store.hasConversation('c1')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // conversation.member_updated
  // -----------------------------------------------------------------------

  it('updates notifyLevel and sessionId for self', () => {
    ws.fire('conversation.member_updated', {
      type: 'conversation.member_updated',
      timestamp: ts,
      payload: { conversationId: 'c1', userId: 'me', changes: { notifyLevel: 'nothing', sessionId: 's2' } },
    });
    expect(store.getNotifyLevel('c1')).toBe('nothing');
    expect(store.getSessionId('c1')).toBe('s2');
  });

  it('ignores member_updated for other users', () => {
    ws.fire('conversation.member_updated', {
      type: 'conversation.member_updated',
      timestamp: ts,
      payload: { conversationId: 'c1', userId: 'other', changes: { notifyLevel: 'nothing' } },
    });
    expect(store.getNotifyLevel('c1')).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // contact events
  // -----------------------------------------------------------------------

  it('handles contact.request_received', () => {
    const contact: ContactRecord = {
      contactId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'pending',
      createdAt: ts,
    };
    const handler = vi.fn();
    const eventHandler = vi.fn();
    handlers['contact.request_received'] = handler;
    handlers['contact.event'] = eventHandler;

    ws.fire('contact.request_received', { type: 'contact.request_received', timestamp: ts, payload: { contact } });

    expect(store.findIncomingRequestByUsername('alice')).toBeDefined();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }));
    expect(eventHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contact.request_received', username: 'alice' }),
    );
  });

  it('handles contact.request_accepted', () => {
    // Incoming request: userId = sender, contactId = me (recipient)
    store.addIncomingRequest({
      userId: 'u2',
      contactId: 'me',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'pending',
      createdAt: ts,
    });
    // Accepted contact: agent's own view — userId = me, contactId = other party
    const acceptedContact: ContactRecord = {
      userId: 'me',
      contactId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'accepted',
      createdAt: ts,
    };
    const handler = vi.fn();
    handlers['contact.request_accepted'] = handler;

    ws.fire('contact.request_accepted', {
      type: 'contact.request_accepted',
      timestamp: ts,
      payload: { contact: acceptedContact },
    });

    expect(store.getIncomingRequests()).toHaveLength(0);
    expect(store.isContact('u2')).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it('handles contact.request_rejected', () => {
    store.addIncomingRequest({
      userId: 'u2',
      contactId: 'me',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'pending',
      createdAt: ts,
    });
    const handler = vi.fn();
    handlers['contact.request_rejected'] = handler;

    ws.fire('contact.request_rejected', {
      type: 'contact.request_rejected',
      timestamp: ts,
      payload: { userId: 'me', contactId: 'u2' },
    });

    expect(store.getIncomingRequests()).toHaveLength(0);
    expect(handler).toHaveBeenCalled();
  });

  it('handles contact.request_revoked', () => {
    store.addIncomingRequest({
      userId: 'u2',
      contactId: 'me',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'pending',
      createdAt: ts,
    });

    ws.fire('contact.request_revoked', {
      type: 'contact.request_revoked',
      timestamp: ts,
      payload: { userId: 'u2', contactId: 'me' },
    });

    expect(store.getIncomingRequests()).toHaveLength(0);
  });

  it('handles contact.removed', () => {
    store.indexContact({
      contactId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'accepted',
      createdAt: ts,
    });
    const handler = vi.fn();
    handlers['contact.removed'] = handler;

    ws.fire('contact.removed', { type: 'contact.removed', timestamp: ts, payload: { userId: 'me', contactId: 'u2' } });

    expect(store.isContact('u2')).toBe(false);
    expect(handler).toHaveBeenCalledWith('alice');
  });

  it('handles contact.friend_name_updated', () => {
    store.indexContact({
      contactId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'accepted',
      createdAt: ts,
    });

    ws.fire('contact.friend_name_updated', {
      type: 'contact.friend_name_updated',
      timestamp: ts,
      payload: { userId: 'me', contactId: 'u2', friendName: 'Ally' },
    });

    expect(store.getContact('u2')?.friendName).toBe('Ally');
  });

  // -----------------------------------------------------------------------
  // message.updated / message.deleted
  // -----------------------------------------------------------------------

  it('handles message.updated', () => {
    store.insertMessage('c1', {
      messageId: 'm1',
      conversationId: 'c1',
      conversationType: 'dm',
      senderUserId: 'u1',
      text: 'old',
      timestamp: new Date().toISOString(),
      isOwnMessage: false,
      inContact: true,
      status: 'new',
    });
    const handler = vi.fn();
    handlers['message.updated'] = handler;

    ws.fire('message.updated', {
      type: 'message.updated',
      timestamp: ts,
      payload: { conversationId: 'c1', messageId: 'm1', senderId: 'u1', content: { text: 'new' }, updatedAt: ts },
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: 'new', status: 'edited' }));
  });

  it('handles message.deleted', () => {
    store.insertMessage('c1', {
      messageId: 'm1',
      conversationId: 'c1',
      conversationType: 'dm',
      senderUserId: 'u1',
      text: 'hi',
      timestamp: new Date().toISOString(),
      isOwnMessage: false,
      inContact: true,
      status: 'new',
    });
    const handler = vi.fn();
    handlers['message.deleted'] = handler;

    ws.fire('message.deleted', {
      type: 'message.deleted',
      timestamp: ts,
      payload: { conversationId: 'c1', messageId: 'm1', senderId: 'u1', deletedAt: ts },
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ status: 'deleted' }));
  });

  // -----------------------------------------------------------------------
  // user.profile_updated
  // -----------------------------------------------------------------------

  it('updates contact on user.profile_updated', () => {
    store.indexContact({
      contactId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'accepted',
      createdAt: ts,
    });

    ws.fire('user.profile_updated', {
      type: 'user.profile_updated',
      timestamp: ts,
      payload: { userId: 'u2', displayName: 'Alice2', username: 'alice2' },
    });

    expect(store.getContact('u2')?.friendDisplayName).toBe('Alice2');
    expect(store.getContact('u2')?.friendUsername).toBe('alice2');
  });

  it('ignores user.profile_updated for non-contacts', () => {
    ws.fire('user.profile_updated', {
      type: 'user.profile_updated',
      timestamp: ts,
      payload: { userId: 'stranger', displayName: 'X' },
    });
    expect(store.getContact('stranger')).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // no-op events
  // -----------------------------------------------------------------------

  it('handles block.created without error', () => {
    ws.fire('block.created', { type: 'block.created', timestamp: ts, payload: { userId: 'me', blockedUserId: 'u2' } });
  });

  it('handles block.removed without error', () => {
    ws.fire('block.removed', {
      type: 'block.removed',
      timestamp: ts,
      payload: { userId: 'me', unblockedUserId: 'u2' },
    });
  });

  it('handles agent.settings_updated without error', () => {
    ws.fire('agent.settings_updated', {
      type: 'agent.settings_updated',
      timestamp: ts,
      payload: { agentId: 'me', settings: {} },
    });
  });

  // -----------------------------------------------------------------------
  // contact.request_received with agent owner profile
  // -----------------------------------------------------------------------

  it('includes owner info in contact.event for agent contacts', () => {
    store.setOwnerProfile('owner-1', { username: 'nan', displayName: 'Nan' });
    const contact: ContactRecord = {
      contactId: 'agent-1',
      friendUsername: 'agentbot',
      friendDisplayName: 'AgentBot',
      friendAccountType: 'agent',
      ownerId: 'owner-1',
      status: 'pending',
      createdAt: ts,
    };
    const eventHandler = vi.fn();
    handlers['contact.event'] = eventHandler;

    ws.fire('contact.request_received', { type: 'contact.request_received', timestamp: ts, payload: { contact } });

    expect(eventHandler).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUsername: 'nan', ownerDisplayName: 'Nan' }),
    );
  });
});
