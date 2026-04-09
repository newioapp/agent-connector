import { describe, it, expect, vi } from 'vitest';
import { MessageProcessor, shouldSkipMessage, isMentioned } from '../src/app/message-processor.js';
import { NewioAppStore } from '../src/app/store.js';
import { PendingActions } from '../src/app/pending-actions.js';
import type { NewioClient } from '../src/core/client.js';
import type { AppEventHandlers, NewioIdentity } from '../src/app/types.js';
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

function createProcessor(
  opts: {
    store?: NewioAppStore;
    client?: NewioClient;
    handlers?: Partial<AppEventHandlers>;
    pendingActions?: PendingActions;
  } = {},
) {
  const store = opts.store ?? new NewioAppStore();
  const client = opts.client ?? mockClient();
  const handlers = opts.handlers ?? {};
  const pendingActions = opts.pendingActions ?? new PendingActions();
  const processor = new MessageProcessor(store, client, identity, () => handlers, pendingActions);
  return { processor, store, client, handlers, pendingActions };
}

describe('MessageProcessor', () => {
  describe('handleMessageNew — basic delivery', () => {
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

      await processor.handleMessageNew(makePayload());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].text).toBe('hello');
      expect(handler.mock.calls[0][0].senderUsername).toBe('other');
    });

    it('does not deliver own messages', async () => {
      const handler = vi.fn();
      const { processor } = createProcessor({ handlers: { 'message.new': handler } });

      await processor.handleMessageNew(makePayload({ senderId: 'me' }));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('handleMessageNew — sequence tracking', () => {
    it('updates sequence number on incoming message', async () => {
      const { processor, store } = createProcessor();

      await processor.handleMessageNew(makePayload({ sequenceNumber: 5 }));

      expect(store.getSequenceNumber('conv-1')).toBe(5);
    });

    it('does not decrease sequence number', async () => {
      const { processor, store } = createProcessor();
      store.setSequenceNumber('conv-1', 10);

      await processor.handleMessageNew(makePayload({ sequenceNumber: 5 }));

      expect(store.getSequenceNumber('conv-1')).toBe(10);
    });
  });

  describe('handleMessageNew — gap detection and backfill', () => {
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
        inContact: true,
        text: 'old',
        timestamp: new Date().toISOString(),
        status: 'new',
      });

      // Incoming seq=5 with current=1 → gap
      await processor.handleMessageNew(makePayload({ sequenceNumber: 5, messageId: 'msg-5' }));

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
        inContact: false,
        text: '',
        timestamp: new Date().toISOString(),
        status: 'new',
      });

      await processor.handleMessageNew(makePayload({ sequenceNumber: 5 }));

      // Should roll back to the pre-gap value
      expect(store.getSequenceNumber('conv-1')).toBe(1);
    });
  });

  describe('handleMessageNew — action resolution', () => {
    it('resolves pending action when response arrives', async () => {
      const pendingActions = new PendingActions();
      const { processor } = createProcessor({ pendingActions });

      const promise = pendingActions.create('req-1', 5000);

      await processor.handleMessageNew(
        makePayload({
          content: { response: { requestId: 'req-1', selectedOptionId: 'allow' } },
        }),
      );

      const result = await promise;
      expect(result.selectedOptionId).toBe('allow');
    });
  });

  describe('handleMessageNew — notify level filtering', () => {
    it('suppresses message when notifyLevel is nothing', async () => {
      const handler = vi.fn();
      const { processor, store } = createProcessor({ handlers: { 'message.new': handler } });
      store.setNotifyLevel('conv-1', 'nothing');

      await processor.handleMessageNew(makePayload());

      expect(handler).not.toHaveBeenCalled();
    });

    it('suppresses message when notifyLevel is mentions and user is not mentioned', async () => {
      const handler = vi.fn();
      const { processor, store } = createProcessor({ handlers: { 'message.new': handler } });
      store.setNotifyLevel('conv-1', 'mentions');

      await processor.handleMessageNew(makePayload({ content: { text: 'no mentions here' } }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('delivers message when notifyLevel is mentions and user IS mentioned', async () => {
      const handler = vi.fn();
      const { processor, store } = createProcessor({ handlers: { 'message.new': handler } });
      store.setNotifyLevel('conv-1', 'mentions');

      await processor.handleMessageNew(
        makePayload({
          content: { text: 'hey', mentions: { userIds: ['me'] } },
        }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('delivers message when notifyLevel is mentions and @everyone is used', async () => {
      const handler = vi.fn();
      const { processor, store } = createProcessor({ handlers: { 'message.new': handler } });
      store.setNotifyLevel('conv-1', 'mentions');

      await processor.handleMessageNew(
        makePayload({
          content: { text: 'hey', mentions: { everyone: true } },
        }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleMessageNew — skip filtering', () => {
    it('skips action request messages', async () => {
      const handler = vi.fn();
      const { processor } = createProcessor({ handlers: { 'message.new': handler } });

      await processor.handleMessageNew(
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

      await processor.handleMessageNew(makePayload({ visibleTo: ['someone-else'] }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('delivers messages visible to the agent', async () => {
      const handler = vi.fn();
      const { processor } = createProcessor({ handlers: { 'message.new': handler } });

      await processor.handleMessageNew(makePayload({ visibleTo: ['me'] }));

      expect(handler).toHaveBeenCalledTimes(1);
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
