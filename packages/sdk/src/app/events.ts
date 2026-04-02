/**
 * WebSocket event wiring for NewioApp.
 *
 * Subscribes to all relevant WebSocket events and updates the store accordingly.
 */
import type { NewioWebSocket } from '../websocket.js';
import type { NewioClient } from '../client.js';
import type { ConversationType, MessageRecord } from '../types.js';
import type { MessageNewEvent } from '../events.js';
import type { NewioAppStore } from './store.js';
import type { MessageHandler, NewioIdentity } from './types.js';

/** Wire all WebSocket event handlers to update the store. */
export function wireEvents(
  ws: NewioWebSocket,
  store: NewioAppStore,
  client: NewioClient,
  identity: NewioIdentity,
  getMessageHandler: () => MessageHandler | null,
): void {
  ws.on('message.new', (event) => {
    void handleIncomingMessage(store, client, identity, getMessageHandler, event.payload);
  });

  ws.on('conversation.new', (event) => {
    store.setConversation({
      conversationId: event.payload.conversationId,
      type: event.payload.type as ConversationType,
      name: event.payload.name,
    });
  });

  ws.on('conversation.updated', (event) => {
    const existing = store.getConversation(event.payload.conversationId);
    if (existing) {
      const { changes } = event.payload;
      store.setConversation({
        ...existing,
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.description !== undefined ? { description: changes.description } : {}),
        ...(changes.avatarUrl !== undefined ? { avatarUrl: changes.avatarUrl } : {}),
        ...(changes.type ? { type: changes.type as ConversationType } : {}),
      });
    }
  });

  ws.on('conversation.member_added', (event) => {
    const { conversationId, members: added } = event.payload;
    store.addMembers(conversationId, added);

    const self = added.find((m) => m.userId === identity.userId);
    if (!self) {
      return;
    }

    if (self.sessionId) {
      store.setSessionId(conversationId, self.sessionId);
    }

    if (!store.hasConversation(conversationId)) {
      void loadConversation(store, client, identity, conversationId);
    }
  });

  ws.on('conversation.member_removed', (event) => {
    store.removeMember(event.payload.conversationId, event.payload.targetUserId);
    if (event.payload.targetUserId === identity.userId) {
      store.removeConversation(event.payload.conversationId);
    }
  });

  ws.on('conversation.member_updated', (event) => {
    if (event.payload.userId !== identity.userId) {
      return;
    }
    if (event.payload.changes.notifyLevel) {
      store.setNotifyLevel(event.payload.conversationId, event.payload.changes.notifyLevel);
    }
    if (event.payload.changes.sessionId) {
      store.setSessionId(event.payload.conversationId, event.payload.changes.sessionId);
    }
  });

  ws.on('contact.request_accepted', (event) => {
    store.indexContact(event.payload.contact);
  });

  ws.on('contact.removed', (event) => {
    store.removeContact(event.payload.contactId);
  });
}

// ---------------------------------------------------------------------------
// Internal — message handling
// ---------------------------------------------------------------------------

async function handleIncomingMessage(
  store: NewioAppStore,
  client: NewioClient,
  identity: NewioIdentity,
  getMessageHandler: () => MessageHandler | null,
  payload: MessageNewEvent['payload'],
): Promise<void> {
  const message = store.toIncomingMessage(identity, payload, payload.conversationId, payload.conversationType);
  const inserted = store.insertMessage(payload.conversationId, message);

  const currentSeq = store.getSequenceNumber(payload.conversationId);
  const incomingSeq = payload.sequenceNumber ?? 0;
  if (incomingSeq > currentSeq) {
    store.setSequenceNumber(payload.conversationId, incomingSeq);
  }

  if (incomingSeq > currentSeq + 1 && currentSeq > 0) {
    const cached = store.getRecentMessages(payload.conversationId);
    if (cached.length > 1) {
      const prev = cached[cached.length - 2];
      if (prev) {
        await backfillGap(
          store,
          client,
          identity,
          getMessageHandler,
          payload.conversationId,
          prev.messageId,
          payload.messageId,
          currentSeq,
        );
      }
    }
  }

  if (inserted && !message.isOwnMessage) {
    const level = store.getNotifyLevel(payload.conversationId) ?? 'all';
    const shouldNotify = level === 'all' || (level === 'mentions' && isMentioned(payload.content, identity.userId));
    if (shouldNotify) {
      getMessageHandler()?.(message);
    }
  }
}

function isMentioned(content: MessageRecord['content'], userId: string): boolean {
  if (!content.mentions) {
    return false;
  }
  return !!(content.mentions.everyone || content.mentions.here || content.mentions.userIds?.includes(userId));
}

async function backfillGap(
  store: NewioAppStore,
  client: NewioClient,
  identity: NewioIdentity,
  getMessageHandler: () => MessageHandler | null,
  conversationId: string,
  afterMessageId: string,
  beforeMessageId: string,
  rollbackSeq: number,
): Promise<void> {
  try {
    let cursor: string | undefined;
    do {
      const resp = await client.listMessages({
        conversationId,
        afterMessageId,
        beforeMessageId,
        limit: 50,
        cursor,
      });
      if (resp.messages.length === 0) {
        break;
      }
      for (const msg of resp.messages) {
        const message = store.toIncomingMessage(identity, msg, conversationId);
        const inserted = store.insertMessage(conversationId, message);
        if (inserted && !message.isOwnMessage) {
          getMessageHandler()?.(message);
        }
      }
      cursor = resp.cursor;
    } while (cursor);
  } catch {
    store.setSequenceNumber(conversationId, rollbackSeq);
  }
}

// ---------------------------------------------------------------------------
// Internal — conversation loading
// ---------------------------------------------------------------------------

async function loadConversation(
  store: NewioAppStore,
  client: NewioClient,
  identity: NewioIdentity,
  conversationId: string,
): Promise<void> {
  try {
    const conv = await client.getConversation({ conversationId });
    store.setConversation({
      conversationId: conv.conversationId,
      type: conv.type,
      name: conv.name,
      description: conv.description,
      avatarUrl: conv.avatarUrl,
      lastMessageAt: conv.lastMessageAt,
    });
    store.setMembers(conversationId, conv.members);

    const self = conv.members.find((m) => m.userId === identity.userId);
    if (self) {
      if (self.notifyLevel) {
        store.setNotifyLevel(conversationId, self.notifyLevel);
      }
      if (self.sessionId) {
        store.setSessionId(conversationId, self.sessionId);
      }
    }
  } catch {
    // Failed to load conversation — non-fatal
  }
}
