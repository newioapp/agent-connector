/**
 * WebSocket event wiring for NewioApp.
 *
 * Subscribes to all relevant WebSocket events and updates the store accordingly.
 */
import type { NewioWebSocket } from '../core/websocket.js';
import type { NewioClient } from '../core/client.js';
import type { ConversationType, MessageRecord } from '../core/types.js';
import type { MessageNewEvent } from '../core/events.js';
import type { NewioAppStore } from './store.js';
import type { AppEventHandlers, NewioIdentity } from './types.js';

/** Wire all WebSocket event handlers to update the store. */
export function wireEvents(
  ws: NewioWebSocket,
  store: NewioAppStore,
  client: NewioClient,
  identity: NewioIdentity,
  getHandlers: () => Partial<AppEventHandlers>,
): void {
  ws.on('message.new', (event) => {
    void handleIncomingMessage(store, client, identity, getHandlers, event.payload);
  });

  ws.on('conversation.new', (event) => {
    store.setConversation({
      conversationId: event.payload.conversationId,
      type: event.payload.type as ConversationType,
      name: event.payload.name,
    });
    void loadConversation(store, client, identity, event.payload.conversationId);
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

  ws.on('contact.request_received', (event) => {
    store.addIncomingRequest(event.payload.contact);
    const c = event.payload.contact;
    getHandlers()['contact.request_received']?.({
      username: c.friendUsername,
      displayName: c.friendDisplayName,
      accountType: c.friendAccountType,
      note: c.note,
    });
  });

  ws.on('contact.request_accepted', (event) => {
    store.removeIncomingRequest(event.payload.contact.contactId);
    store.indexContact(event.payload.contact);
    const c = event.payload.contact;
    getHandlers()['contact.request_accepted']?.({
      username: c.friendUsername,
      displayName: c.friendDisplayName,
      accountType: c.friendAccountType,
    });
  });

  ws.on('contact.request_rejected', (event) => {
    store.removeIncomingRequest(event.payload.contactId);
    const contact = store.getContact(event.payload.contactId);
    getHandlers()['contact.request_rejected']?.(contact?.friendUsername);
  });

  ws.on('contact.request_revoked', (event) => {
    store.removeIncomingRequest(event.payload.contactId);
  });

  ws.on('contact.removed', (event) => {
    store.removeContact(event.payload.contactId);
  });

  ws.on('contact.friend_name_updated', (event) => {
    store.updateContact(event.payload.contactId, { friendName: event.payload.friendName });
  });

  ws.on('message.updated', (event) => {
    const { conversationId, messageId, content } = event.payload;
    const updated = store.updateMessage(conversationId, messageId, content.text ?? '');
    if (updated) {
      getHandlers()['message.updated']?.(updated);
    }
  });

  ws.on('message.deleted', (event) => {
    const { conversationId, messageId } = event.payload;
    const deleted = store.removeMessage(conversationId, messageId);
    if (deleted) {
      getHandlers()['message.deleted']?.(deleted);
    }
  });

  ws.on('block.created', () => {
    // No block cache in store — no-op for now
  });

  ws.on('block.removed', () => {
    // No block cache in store — no-op for now
  });

  ws.on('user.profile_updated', (event) => {
    const { userId, displayName, avatarUrl, username } = event.payload;
    if (store.isContact(userId)) {
      store.updateContact(userId, {
        ...(displayName !== undefined ? { friendDisplayName: displayName } : {}),
        ...(avatarUrl !== undefined ? { friendAvatarUrl: avatarUrl } : {}),
        ...(username !== undefined ? { friendUsername: username } : {}),
      });
    }
  });

  ws.on('agent.settings_updated', () => {
    // Agent settings not cached in store — no-op for now
  });
}

// ---------------------------------------------------------------------------
// Internal — message handling
// ---------------------------------------------------------------------------

async function handleIncomingMessage(
  store: NewioAppStore,
  client: NewioClient,
  identity: NewioIdentity,
  getHandlers: () => Partial<AppEventHandlers>,
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
          getHandlers,
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
      getHandlers()['message.new']?.(message);
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
  getHandlers: () => Partial<AppEventHandlers>,
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
          getHandlers()['message.new']?.(message);
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
