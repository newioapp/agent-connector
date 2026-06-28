import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wireEvents } from '../src/app/events.js';
import { NewioAppStore } from '../src/app/store.js';
import type { NewioWebSocket } from '@newio/agent-sdk';
import type { NewioClient } from '@newio/agent-sdk';
import type { EventMap } from '@newio/agent-sdk';
import type {
  AppEventHandlers,
  NewioIdentity,
  LiveSessionInfoHandler,
  CancelSessionHandler,
  CompactSessionHandler,
  StartSessionHandler,
  UpdateMemoryHandler,
  RotateSessionHandler,
} from '../src/app/types.js';
import type { MessageProcessor } from '../src/app/message-processor.js';
import type { ContactRecord } from '@newio/agent-sdk';

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
  let processor: MessageProcessor;
  let signalHandlers: {
    liveSessionInfo: LiveSessionInfoHandler;
    cancelSession: CancelSessionHandler;
    compactSession: CompactSessionHandler;
    startSession: StartSessionHandler;
    updateMemory: UpdateMemoryHandler;
    rotateSession: RotateSessionHandler;
  };

  beforeEach(() => {
    ws = createMockWs();
    store = new NewioAppStore();
    client = createMockClient();
    handlers = {};
    processor = { handleMessage: vi.fn().mockResolvedValue(undefined) } as unknown as MessageProcessor;
    signalHandlers = {
      liveSessionInfo: vi.fn().mockResolvedValue({
        sessionId: 's1',
        availableModels: [],
        availableModes: [],
        canCancel: true,
        canCompact: false,
      }),
      cancelSession: vi.fn().mockResolvedValue({ success: true }),
      compactSession: vi.fn().mockResolvedValue({ success: true }),
      startSession: vi.fn().mockResolvedValue({ success: true, info: null }),
      updateMemory: vi.fn().mockResolvedValue({ success: true }),
      rotateSession: vi.fn().mockResolvedValue({ success: true }),
    };

    wireEvents(
      ws,
      store,
      client,
      identity,
      () => handlers,
      processor,
      () => signalHandlers,
    );
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
    await vi.waitFor(() => expect(processor.handleMessage).toHaveBeenCalledWith(payload));
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
    store.setConversation({
      conversationId: 'c1',
      type: 'dm',
      name: 'Old',
      createdBy: 'u1',
      createdAt: ts,
      updatedAt: ts,
    });
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
        members: [{ userId: 'u2', displayName: 'U2', accountType: 'human', role: 'member', joinedAt: ts }],
      },
    });
    expect(store.getMembers('c1')?.has('u2')).toBe(true);
  });

  it('loads conversation when self is added to unknown conversation', async () => {
    ws.fire('conversation.member_added', {
      type: 'conversation.member_added',
      timestamp: ts,
      payload: {
        conversationId: 'c-unknown',
        addedBy: 'u1',
        members: [{ userId: 'me', role: 'member', accountType: 'human', joinedAt: ts }],
      },
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
    store.setConversation({ conversationId: 'c1', type: 'dm', createdBy: 'u1', createdAt: ts, updatedAt: ts });
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

  it('updates notifyLevel for self', () => {
    ws.fire('conversation.member_updated', {
      type: 'conversation.member_updated',
      timestamp: ts,
      payload: { conversationId: 'c1', userId: 'me', changes: { notifyLevel: 'nothing' } },
    });
    expect(store.getConversationControls('c1')?.notifyLevel).toBe('nothing');
  });

  it('ignores member_updated for other users', () => {
    ws.fire('conversation.member_updated', {
      type: 'conversation.member_updated',
      timestamp: ts,
      payload: { conversationId: 'c1', userId: 'other', changes: { notifyLevel: 'nothing' } },
    });
    expect(store.getConversationControls('c1')).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // forward-compat: unknown enum values
  //
  // A newer backend may ship a value for a string-literal field that this
  // connector predates (conversationType, notifyLevel, role). The connector
  // must store it without throwing and never crash the agent.
  // -----------------------------------------------------------------------

  it('stores an unknown conversation type from conversation.new without throwing', () => {
    expect(() =>
      ws.fire('conversation.new', {
        type: 'conversation.new',
        timestamp: ts,
        payload: { conversationId: 'c-future', type: 'channel', name: 'Future', createdBy: 'u1' },
      }),
    ).not.toThrow();
    expect(store.getConversation('c-future')?.type).toBe('channel');
  });

  it('stores an unknown conversation type from conversation.updated without throwing', () => {
    store.setConversation({ conversationId: 'c1', type: 'group', createdBy: 'u1', createdAt: ts, updatedAt: ts });
    expect(() =>
      ws.fire('conversation.updated', {
        type: 'conversation.updated',
        timestamp: ts,
        payload: { conversationId: 'c1', updatedBy: 'u1', changes: { type: 'channel' } as never },
      }),
    ).not.toThrow();
    expect(store.getConversation('c1')?.type).toBe('channel');
  });

  it('stores an unknown notifyLevel from member_updated without throwing', () => {
    expect(() =>
      ws.fire('conversation.member_updated', {
        type: 'conversation.member_updated',
        timestamp: ts,
        payload: { conversationId: 'c1', userId: 'me', changes: { notifyLevel: 'digest_daily' } as never },
      }),
    ).not.toThrow();
    expect(store.getConversationControls('c1')?.notifyLevel).toBe('digest_daily');
  });

  it('stores an unknown member role from member_updated without throwing', () => {
    expect(() =>
      ws.fire('conversation.member_updated', {
        type: 'conversation.member_updated',
        timestamp: ts,
        payload: { conversationId: 'c1', userId: 'me', changes: { role: 'moderator' } as never },
      }),
    ).not.toThrow();
    expect(store.getConversationControls('c1')?.role).toBe('moderator');
  });

  // -----------------------------------------------------------------------
  // contact events
  // -----------------------------------------------------------------------

  it('handles contact.request_received', () => {
    const contact: ContactRecord = {
      userId: 'me',
      contactId: 'u2',
      requesterId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
    };
    const eventHandler = vi.fn();
    handlers['contact.event'] = eventHandler;

    ws.fire('contact.request_received', { type: 'contact.request_received', timestamp: ts, payload: { contact } });

    expect(store.findIncomingRequestByUsername('alice')).toBeDefined();
    expect(eventHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contact.request_received', username: 'alice' }),
    );
  });

  it('ignores contact.request_received for self-initiated requests', () => {
    const contact: ContactRecord = {
      userId: 'me',
      contactId: 'u2',
      requesterId: 'me', // agent sent this request
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
    };
    const eventHandler = vi.fn();
    handlers['contact.event'] = eventHandler;

    ws.fire('contact.request_received', { type: 'contact.request_received', timestamp: ts, payload: { contact } });

    expect(store.findIncomingRequestByUsername('alice')).toBeUndefined();
    expect(eventHandler).not.toHaveBeenCalled();
  });

  it('handles contact.request_accepted', () => {
    // Incoming request: userId = sender, contactId = me (recipient)
    store.addIncomingRequest({
      userId: 'u2',
      contactId: 'me',
      requesterId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
    });
    // Accepted contact: agent's own view — userId = me, contactId = other party
    const acceptedContact: ContactRecord = {
      userId: 'me',
      contactId: 'u2',
      requesterId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'accepted',
      createdAt: ts,
      updatedAt: ts,
    };
    const eventHandler = vi.fn();
    handlers['contact.event'] = eventHandler;

    ws.fire('contact.request_accepted', {
      type: 'contact.request_accepted',
      timestamp: ts,
      payload: { contact: acceptedContact },
    });

    expect(store.getIncomingRequests()).toHaveLength(0);
    expect(store.isContact('u2')).toBe(true);
    expect(eventHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'contact.request_accepted', username: 'alice' }),
    );
  });

  it('handles contact.request_rejected', () => {
    store.addIncomingRequest({
      userId: 'u2',
      contactId: 'me',
      requesterId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
    });
    const eventHandler = vi.fn();
    handlers['contact.event'] = eventHandler;

    ws.fire('contact.request_rejected', {
      type: 'contact.request_rejected',
      timestamp: ts,
      payload: { userId: 'me', contactId: 'u2' },
    });

    expect(store.getIncomingRequests()).toHaveLength(0);
    expect(eventHandler).toHaveBeenCalledWith(expect.objectContaining({ type: 'contact.request_rejected' }));
  });

  it('handles contact.request_revoked', () => {
    store.addIncomingRequest({
      userId: 'u2',
      contactId: 'me',
      requesterId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
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
      userId: 'me',
      contactId: 'u2',
      requesterId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'accepted',
      createdAt: ts,
      updatedAt: ts,
    });
    const eventHandler = vi.fn();
    handlers['contact.event'] = eventHandler;

    ws.fire('contact.removed', { type: 'contact.removed', timestamp: ts, payload: { userId: 'me', contactId: 'u2' } });

    expect(store.isContact('u2')).toBe(false);
    expect(eventHandler).toHaveBeenCalledWith(expect.objectContaining({ type: 'contact.removed', username: 'alice' }));
  });

  it('handles contact.friend_name_updated', () => {
    store.indexContact({
      userId: 'me',
      contactId: 'u2',
      requesterId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'accepted',
      createdAt: ts,
      updatedAt: ts,
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

  it('delegates message.updated to the processor (delivery handled inside the queue)', async () => {
    // Ref message: its own messageId/sequenceNumber, with content.ref pointing at the target.
    const payload = {
      conversationId: 'c1',
      messageId: 'ref1',
      senderId: 'u1',
      content: { text: 'new', ref: { type: 'edit' as const, targetMessageId: 'm1' } },
      sequenceNumber: 5,
      createdAt: ts,
      senderDisplayName: 'U1',
      conversationType: 'dm' as const,
    };
    ws.fire('message.updated', { type: 'message.updated', timestamp: ts, payload });

    await vi.waitFor(() => expect(processor.handleMessage).toHaveBeenCalledWith(payload));
  });

  it('delegates message.deleted to the processor (delivery handled inside the queue)', async () => {
    const payload = {
      conversationId: 'c1',
      messageId: 'ref1',
      senderId: 'u1',
      content: { ref: { type: 'delete' as const, targetMessageId: 'm1' } },
      sequenceNumber: 6,
      createdAt: ts,
      senderDisplayName: 'U1',
      conversationType: 'dm' as const,
    };
    ws.fire('message.deleted', { type: 'message.deleted', timestamp: ts, payload });

    await vi.waitFor(() => expect(processor.handleMessage).toHaveBeenCalledWith(payload));
  });

  // -----------------------------------------------------------------------
  // user.profile_updated
  // -----------------------------------------------------------------------

  it('updates contact on user.profile_updated', () => {
    store.indexContact({
      userId: 'me',
      contactId: 'u2',
      requesterId: 'u2',
      friendUsername: 'alice',
      friendDisplayName: 'Alice',
      friendAccountType: 'human',
      status: 'accepted',
      createdAt: ts,
      updatedAt: ts,
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
      userId: 'me',
      contactId: 'agent-1',
      requesterId: 'agent-1',
      friendUsername: 'agentbot',
      friendDisplayName: 'AgentBot',
      friendAccountType: 'agent',
      ownerId: 'owner-1',
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
    };
    const eventHandler = vi.fn();
    handlers['contact.event'] = eventHandler;

    ws.fire('contact.request_received', { type: 'contact.request_received', timestamp: ts, payload: { contact } });

    expect(eventHandler).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUsername: 'nan', ownerDisplayName: 'Nan' }),
    );
  });

  // -----------------------------------------------------------------------
  // signal — capabilities request/response
  // -----------------------------------------------------------------------

  it('dispatches live_session_info to handler and sends response', async () => {
    const sendSignal = vi.fn().mockResolvedValue({ requestId: 'req-1' });
    (client as unknown as Record<string, unknown>).sendSignal = sendSignal;

    ws.fire('signal', {
      type: 'signal',
      timestamp: ts,
      payload: {
        senderId: 'owner-1',
        requestId: 'req-1',
        intent: 'request',
        type: 'live_session_info',
        payload: { sessionType: 'conversation', externalReferenceId: 's1' },
      },
    });

    await vi.waitFor(() => {
      expect(sendSignal).toHaveBeenCalled();
    });

    expect(signalHandlers.liveSessionInfo).toHaveBeenCalledWith({
      sessionType: 'conversation',
      externalReferenceId: 's1',
    });
    expect(sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: 'owner-1',
        requestId: 'req-1',
        intent: 'response',
        type: 'live_session_info_response',
      }),
    );
  });

  it('dispatches cancel_session to handler and sends response', async () => {
    const sendSignal = vi.fn().mockResolvedValue({ requestId: 'req-2' });
    (client as unknown as Record<string, unknown>).sendSignal = sendSignal;

    ws.fire('signal', {
      type: 'signal',
      timestamp: ts,
      payload: {
        senderId: 'owner-1',
        requestId: 'req-2',
        intent: 'request',
        type: 'cancel_session',
        payload: { sessionType: 'conversation', externalReferenceId: 's1' },
      },
    });

    await vi.waitFor(() => {
      expect(sendSignal).toHaveBeenCalled();
    });

    expect(signalHandlers.cancelSession).toHaveBeenCalledWith({
      sessionType: 'conversation',
      externalReferenceId: 's1',
    });
    expect(sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: 'owner-1',
        requestId: 'req-2',
        intent: 'response',
        type: 'cancel_session_response',
      }),
    );
  });

  it('dispatches update_memory to handler and sends response', async () => {
    const sendSignal = vi.fn().mockResolvedValue({ requestId: 'req-4' });
    (client as unknown as Record<string, unknown>).sendSignal = sendSignal;

    ws.fire('signal', {
      type: 'signal',
      timestamp: ts,
      payload: {
        senderId: 'owner-1',
        requestId: 'req-4',
        intent: 'request',
        type: 'update_memory',
        payload: { sessionType: 'conversation', externalReferenceId: 'conv-1' },
      },
    });

    await vi.waitFor(() => {
      expect(sendSignal).toHaveBeenCalled();
    });

    expect(signalHandlers.updateMemory).toHaveBeenCalledWith({
      sessionType: 'conversation',
      externalReferenceId: 'conv-1',
    });
    expect(sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: 'owner-1',
        requestId: 'req-4',
        intent: 'response',
        type: 'update_memory_response',
      }),
    );
  });

  it('dispatches rotate_session to handler and sends response', async () => {
    const sendSignal = vi.fn().mockResolvedValue({ requestId: 'req-5' });
    (client as unknown as Record<string, unknown>).sendSignal = sendSignal;

    ws.fire('signal', {
      type: 'signal',
      timestamp: ts,
      payload: {
        senderId: 'owner-1',
        requestId: 'req-5',
        intent: 'request',
        type: 'rotate_session',
        payload: { sessionType: 'conversation', externalReferenceId: 'conv-1' },
      },
    });

    await vi.waitFor(() => {
      expect(sendSignal).toHaveBeenCalled();
    });

    expect(signalHandlers.rotateSession).toHaveBeenCalledWith({
      sessionType: 'conversation',
      externalReferenceId: 'conv-1',
    });
    expect(sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: 'owner-1',
        requestId: 'req-5',
        intent: 'response',
        type: 'rotate_session_response',
      }),
    );
  });

  it('ignores non-request signal intents', () => {
    const sendSignal = vi.fn();
    (client as unknown as Record<string, unknown>).sendSignal = sendSignal;

    ws.fire('signal', {
      type: 'signal',
      timestamp: ts,
      payload: {
        senderId: 'owner-1',
        requestId: 'req-3',
        intent: 'notification',
        type: 'capabilities_report',
        payload: { sessionType: 'conversation', externalReferenceId: 'x' },
      },
    });

    expect(sendSignal).not.toHaveBeenCalled();
  });

  // Forward-compat: a newer backend may send a request signal type this connector
  // predates. It must not crash — it replies with a structured unknown_signal_type error.
  it('replies with an error for an unknown signal request type', async () => {
    const sendSignal = vi.fn().mockResolvedValue({ requestId: 'req-future' });
    (client as unknown as Record<string, unknown>).sendSignal = sendSignal;

    ws.fire('signal', {
      type: 'signal',
      timestamp: ts,
      payload: {
        senderId: 'owner-1',
        requestId: 'req-future',
        intent: 'request',
        type: 'future_signal' as never,
        payload: {} as never,
      },
    });

    await vi.waitFor(() => expect(sendSignal).toHaveBeenCalled());
    expect(sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: 'owner-1',
        requestId: 'req-future',
        intent: 'response',
        type: 'future_signal_response',
        payload: expect.objectContaining({ success: false, error: 'unknown_signal_type' }),
      }),
    );
  });
});
