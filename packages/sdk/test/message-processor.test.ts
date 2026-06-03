import { describe, it, expect, vi } from 'vitest';
import { MessageProcessor, shouldSkipMessage, isMentioned } from '../src/app/message-processor.js';
import { NewioAppStore } from '../src/app/store.js';
import { PendingActions } from '../src/app/pending-actions.js';
import type { NewioClient } from '../src/core/client.js';
import type {
  MessageDeletedHandler,
  MessageNewHandler,
  MessageUpdatedHandler,
  NewioIdentity,
} from '../src/app/types.js';
import type { MessageNewEvent } from '../src/core/events.js';

const identity: NewioIdentity = { userId: 'me', username: 'myagent', displayName: 'My Agent' };

function mockClient(overrides: Partial<NewioClient> = {}): NewioClient {
  return {
    listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    ...overrides,
  } as unknown as NewioClient;
}

function makePayload(overrides: Partial<MessageNewEvent['payload']> = {}): MessageNewEvent['payload'] {
  return {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    senderId: 'other-user',
    senderDisplayName: 'Other',
    conversationType: 'dm',
    content: { text: 'hello' },
    sequenceNumber: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

type MessageHandlers = Partial<{
  'message.new': MessageNewHandler;
  'message.updated': MessageUpdatedHandler;
  'message.deleted': MessageDeletedHandler;
}>;

function createProcessor(
  opts: {
    store?: NewioAppStore;
    client?: NewioClient;
    handlers?: MessageHandlers;
    pendingActions?: PendingActions;
  } = {},
) {
  const store = opts.store ?? new NewioAppStore();
  const client = opts.client ?? mockClient();
  const handlers: MessageHandlers = opts.handlers ?? {};
  const pendingActions = opts.pendingActions ?? new PendingActions();
  const processor = new MessageProcessor(
    store,
    client,
    identity,
    () => handlers['message.new'],
    () => handlers['message.updated'],
    () => handlers['message.deleted'],
    pendingActions,
  );
  return { processor, store, client, handlers, pendingActions };
}

describe('MessageProcessor', () => {
  describe('handleMessage — basic delivery', () => {
    it('delivers a message from another user to the handler', async () => {
      const handler = vi.fn();
      const { processor, store } = createProcessor({ handlers: { 'message.new': handler } });
      // Seed a contact so the store can resolve sender info
      store.indexContact({
        userId: 'me',
        contactId: 'other-user',
        status: 'accepted',
        requesterId: 'me',
        friendAccountType: 'human',
        friendUsername: 'other',
        friendDisplayName: 'Other',
        createdAt: '',
        updatedAt: '',
      });

      await processor.handleMessage(makePayload());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].text).toBe('hello');
      expect(handler.mock.calls[0][0].senderUsername).toBe('other');
    });

    it('does not deliver own messages', async () => {
      const handler = vi.fn();
      const { processor } = createProcessor({ handlers: { 'message.new': handler } });

      await processor.handleMessage(makePayload({ senderId: 'me' }));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('handleMessage — sequence tracking', () => {
    it('updates sequence number on incoming message', async () => {
      const { processor, store } = createProcessor();

      await processor.handleMessage(makePayload({ sequenceNumber: 5 }));

      expect(store.getSequenceNumber('conv-1')).toBe(5);
    });

    it('does not decrease sequence number', async () => {
      const { processor, store } = createProcessor();
      store.setSequenceNumber('conv-1', 10);

      await processor.handleMessage(makePayload({ sequenceNumber: 5 }));

      expect(store.getSequenceNumber('conv-1')).toBe(10);
    });
  });

  describe('handleMessage — gap detection and backfill', () => {
    it('triggers backfill when sequence gap detected', async () => {
      const listMessages = vi.fn().mockResolvedValue({
        messages: [
          {
            conversationId: 'conv-1',
            messageId: 'msg-gap',
            senderId: 'other-user',
            content: { text: 'missed' },
            sequenceNumber: 2,
            createdAt: new Date().toISOString(),
          },
        ],
      });
      const handler = vi.fn();
      const { processor, store } = createProcessor({
        client: mockClient({ listMessages }),
        handlers: { 'message.new': handler },
      });
      store.indexContact({
        userId: 'me',
        contactId: 'other-user',
        status: 'accepted',
        requesterId: 'me',
        friendAccountType: 'human',
        friendUsername: 'other',
        createdAt: '',
        updatedAt: '',
      });

      // Set current seq to 1, insert a cached message so backfill has an anchor
      store.setSequenceNumber('conv-1', 1);
      store.insertMessage('conv-1', {
        messageId: 'msg-0',
        conversationId: 'conv-1',
        conversationType: 'dm',
        senderUserId: 'other-user',
        isOwnMessage: false,
        relationship: 'in-contact' as const,
        text: 'old',
        timestamp: new Date().toISOString(),
        status: 'new',
      });

      // Incoming seq=5 with current=1 → gap
      await processor.handleMessage(makePayload({ sequenceNumber: 5, messageId: 'msg-5' }));

      expect(listMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          afterMessageId: 'msg-0',
          beforeMessageId: 'msg-5',
        }),
      );
    });

    it('rolls back sequence number on backfill failure', async () => {
      const listMessages = vi.fn().mockRejectedValue(new Error('network error'));
      const { processor, store } = createProcessor({ client: mockClient({ listMessages }) });

      store.setSequenceNumber('conv-1', 1);
      store.insertMessage('conv-1', {
        messageId: 'msg-0',
        conversationId: 'conv-1',
        conversationType: 'dm',
        senderUserId: 'x',
        isOwnMessage: false,
        relationship: 'other' as const,
        text: '',
        timestamp: new Date().toISOString(),
        status: 'new',
      });

      await processor.handleMessage(makePayload({ sequenceNumber: 5 }));

      // Should roll back to the pre-gap value
      expect(store.getSequenceNumber('conv-1')).toBe(1);
    });
  });

  describe('handleMessage — action resolution', () => {
    it('resolves pending action when response arrives', async () => {
      const pendingActions = new PendingActions();
      const { processor } = createProcessor({ pendingActions });

      const promise = pendingActions.create('req-1', 5000);

      await processor.handleMessage(
        makePayload({
          content: { response: { requestId: 'req-1', selectedOptionId: 'allow' } },
        }),
      );

      const result = await promise;
      expect(result.selectedOptionId).toBe('allow');
    });
  });

  describe('handleMessage — notify level filtering', () => {
    it('suppresses message when notifyLevel is nothing', async () => {
      const handler = vi.fn();
      const { processor, store } = createProcessor({ handlers: { 'message.new': handler } });
      store.setConversationControls('conv-1', { notifyLevel: 'nothing' });

      await processor.handleMessage(makePayload());

      expect(handler).not.toHaveBeenCalled();
    });

    it('suppresses message when notifyLevel is mentions and user is not mentioned', async () => {
      const handler = vi.fn();
      const { processor, store } = createProcessor({ handlers: { 'message.new': handler } });
      store.setConversationControls('conv-1', { notifyLevel: 'mentions' });

      await processor.handleMessage(makePayload({ content: { text: 'no mentions here' } }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('delivers message when notifyLevel is mentions and user IS mentioned', async () => {
      const handler = vi.fn();
      const { processor, store } = createProcessor({ handlers: { 'message.new': handler } });
      store.setConversationControls('conv-1', { notifyLevel: 'mentions' });

      await processor.handleMessage(
        makePayload({
          content: { text: 'hey', mentions: { userIds: ['me'] } },
        }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('delivers message when notifyLevel is mentions and @everyone is used', async () => {
      const handler = vi.fn();
      const { processor, store } = createProcessor({ handlers: { 'message.new': handler } });
      store.setConversationControls('conv-1', { notifyLevel: 'mentions' });

      await processor.handleMessage(
        makePayload({
          content: { text: 'hey', mentions: { everyone: true } },
        }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleMessage — skip filtering', () => {
    it('skips action request messages', async () => {
      const handler = vi.fn();
      const { processor } = createProcessor({ handlers: { 'message.new': handler } });

      await processor.handleMessage(
        makePayload({
          content: {
            action: {
              requestId: 'r1',
              type: 'permission',
              title: 'Allow?',
              options: [{ optionId: 'a', label: 'Yes' }],
            },
          },
        }),
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it('skips messages not visible to the agent', async () => {
      const handler = vi.fn();
      const { processor } = createProcessor({ handlers: { 'message.new': handler } });

      await processor.handleMessage(makePayload({ visibleTo: ['someone-else'] }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('delivers messages visible to the agent', async () => {
      const handler = vi.fn();
      const { processor } = createProcessor({ handlers: { 'message.new': handler } });

      await processor.handleMessage(makePayload({ visibleTo: ['me'] }));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleMessage — edit / delete ref messages', () => {
    function seedCachedMessage(store: NewioAppStore, messageId = 'msg-1'): void {
      store.insertMessage('conv-1', {
        messageId,
        conversationId: 'conv-1',
        conversationType: 'dm',
        senderUserId: 'other-user',
        isOwnMessage: false,
        relationship: 'in-contact' as const,
        text: 'original',
        timestamp: new Date().toISOString(),
        status: 'new',
      });
    }

    function editPayload(targetMessageId: string, text = 'edited!') {
      return makePayload({
        messageId: 'ref-edit',
        sequenceNumber: 2,
        content: { text, ref: { type: 'edit', targetMessageId } },
      });
    }

    function deletePayload(targetMessageId: string) {
      return makePayload({
        messageId: 'ref-del',
        sequenceNumber: 2,
        content: { ref: { type: 'delete', targetMessageId } },
      });
    }

    it('applies the edit to the cached target, advances the sequence, and delivers to the updated handler', async () => {
      const onUpdated = vi.fn();
      const onNew = vi.fn();
      const { processor, store } = createProcessor({
        handlers: { 'message.new': onNew, 'message.updated': onUpdated },
      });
      seedCachedMessage(store);
      store.setSequenceNumber('conv-1', 1);

      await processor.handleMessage(editPayload('msg-1'));

      expect(store.getRecentMessages('conv-1')[0]).toMatchObject({
        messageId: 'msg-1',
        text: 'edited!',
        status: 'edited',
      });
      expect(store.getSequenceNumber('conv-1')).toBe(2);
      expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-1', text: 'edited!' }));
      // An edit must not be surfaced as a new message.
      expect(onNew).not.toHaveBeenCalled();
    });

    it('marks the cached target deleted, advances the sequence, and delivers to the deleted handler', async () => {
      const onDeleted = vi.fn();
      const onNew = vi.fn();
      const { processor, store } = createProcessor({
        handlers: { 'message.new': onNew, 'message.deleted': onDeleted },
      });
      seedCachedMessage(store);
      store.setSequenceNumber('conv-1', 1);

      await processor.handleMessage(deletePayload('msg-1'));

      expect(store.getRecentMessages('conv-1')[0]).toMatchObject({ messageId: 'msg-1', status: 'deleted' });
      expect(store.getSequenceNumber('conv-1')).toBe(2);
      expect(onDeleted).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-1', status: 'deleted' }));
      expect(onNew).not.toHaveBeenCalled();
    });

    it('still advances the sequence when the edit targets an uncached message', async () => {
      const onUpdated = vi.fn();
      const { processor, store } = createProcessor({ handlers: { 'message.updated': onUpdated } });
      store.setSequenceNumber('conv-1', 1);

      await processor.handleMessage(editPayload('gone'));

      // Nothing to mutate, but the sequence still advances so the next message isn't a gap.
      expect(store.getSequenceNumber('conv-1')).toBe(2);
      expect(onUpdated).not.toHaveBeenCalled();
    });

    // Regression: edit/delete ref messages carry their own sequenceNumber, so tracking
    // them must prevent the *next* real message from being seen as a gap.
    it('does not trigger backfill on the next message after an edit', async () => {
      const listMessages = vi.fn().mockResolvedValue({ messages: [] });
      const { processor, store } = createProcessor({ client: mockClient({ listMessages }) });
      seedCachedMessage(store);
      store.setSequenceNumber('conv-1', 1);

      await processor.handleMessage(editPayload('msg-1')); // seq 2
      await processor.handleMessage(makePayload({ messageId: 'msg-3', sequenceNumber: 3 })); // contiguous → no gap

      expect(listMessages).not.toHaveBeenCalled();
      expect(store.getSequenceNumber('conv-1')).toBe(3);
    });

    // Regression for the backfill path: a missed edit/delete that arrives via backfill
    // must be applied to its cached target, not silently skipped.
    it('applies a backfilled edit ref to its cached target', async () => {
      const onUpdated = vi.fn();
      const listMessages = vi.fn().mockResolvedValue({
        messages: [
          {
            conversationId: 'conv-1',
            messageId: 'ref-edit',
            senderId: 'other-user',
            content: { text: 'backfilled edit', ref: { type: 'edit', targetMessageId: 'msg-1' } },
            sequenceNumber: 2,
            createdAt: new Date().toISOString(),
          },
        ],
      });
      const { processor, store } = createProcessor({
        client: mockClient({ listMessages }),
        handlers: { 'message.updated': onUpdated },
      });
      seedCachedMessage(store);
      store.setSequenceNumber('conv-1', 1);

      // Incoming seq 3 with current 1 → gap → backfill returns the missed edit (seq 2).
      await processor.handleMessage(makePayload({ messageId: 'msg-3', sequenceNumber: 3 }));

      expect(listMessages).toHaveBeenCalled();
      expect(store.getRecentMessages('conv-1').find((m) => m.messageId === 'msg-1')).toMatchObject({
        text: 'backfilled edit',
        status: 'edited',
      });
      expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-1', text: 'backfilled edit' }));
    });
  });
});

describe('shouldSkipMessage', () => {
  it('skips action requests', () => {
    expect(shouldSkipMessage({ action: { requestId: 'r', type: 't', title: 'T', options: [] } }, undefined, 'me')).toBe(
      true,
    );
  });

  it('skips action responses', () => {
    expect(shouldSkipMessage({ response: { requestId: 'r', selectedOptionId: 'a' } }, undefined, 'me')).toBe(true);
  });

  it('skips when user not in visibleTo', () => {
    expect(shouldSkipMessage({ text: 'hi' }, ['other'], 'me')).toBe(true);
  });

  it('does not skip normal messages', () => {
    expect(shouldSkipMessage({ text: 'hi' }, undefined, 'me')).toBe(false);
  });

  it('does not skip when user is in visibleTo', () => {
    expect(shouldSkipMessage({ text: 'hi' }, ['me'], 'me')).toBe(false);
  });
});

describe('isMentioned', () => {
  it('returns false when no mentions', () => {
    expect(isMentioned({ text: 'hi' }, 'me')).toBe(false);
  });

  it('returns true for @everyone', () => {
    expect(isMentioned({ text: 'hi', mentions: { everyone: true } }, 'me')).toBe(true);
  });

  it('returns true for @here', () => {
    expect(isMentioned({ text: 'hi', mentions: { here: true } }, 'me')).toBe(true);
  });

  it('returns true when userId is in mentions', () => {
    expect(isMentioned({ text: 'hi', mentions: { userIds: ['me'] } }, 'me')).toBe(true);
  });

  it('returns false when userId is not in mentions', () => {
    expect(isMentioned({ text: 'hi', mentions: { userIds: ['other'] } }, 'me')).toBe(false);
  });
});
