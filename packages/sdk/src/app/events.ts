/**
 * WebSocket event wiring for NewioApp.
 *
 * Subscribes to all relevant WebSocket events and updates the store accordingly.
 * Message processing is delegated to {@link MessageProcessor}.
 */
import { getLogger } from '../core/logger.js';
import type { NewioWebSocket } from '../core/websocket.js';
import type { NewioClient } from '../core/client.js';
import type { ConversationType } from '../core/types.js';
import type { NewioAppStore } from './store.js';
import type { AppEventHandlers, NewioIdentity } from './types.js';
import type { PendingActions } from './pending-actions.js';
import { MessageProcessor } from './message-processor.js';

const log = getLogger('events');

/** Wire all WebSocket event handlers to update the store. */
export function wireEvents(
  ws: NewioWebSocket,
  store: NewioAppStore,
  client: NewioClient,
  identity: NewioIdentity,
  getHandlers: () => Partial<AppEventHandlers>,
  pendingActions: PendingActions,
): void {
  const processor = new MessageProcessor(store, client, identity, getHandlers, pendingActions);

  /** Per-conversation queue to serialize message processing and prevent duplicate backfills. */
  const messageQueue = new Map<string, Promise<void>>();

  ws.on('message.new', (event) => {
    log.debug(`Event message.new in ${event.payload.conversationId} from ${event.payload.senderId}`);
    const convId = event.payload.conversationId;
    const prev = messageQueue.get(convId) ?? Promise.resolve();
    const next = prev.then(() => processor.handleMessageNew(event.payload));
    messageQueue.set(
      convId,
      next.catch((err: unknown) => {
        log.error(`Error processing message.new in ${convId}: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
  });

  ws.on('conversation.new', (event) => {
    log.info(`Event conversation.new: ${event.payload.conversationId} (type=${event.payload.type})`);
    store.setConversation({
      conversationId: event.payload.conversationId,
      type: event.payload.type as ConversationType,
      name: event.payload.name,
      createdBy: event.payload.createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    void loadConversation(store, client, identity, event.payload.conversationId);
  });

  ws.on('conversation.updated', (event) => {
    log.debug(`Event conversation.updated: ${event.payload.conversationId}`);
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
    log.debug(`Event conversation.member_added: ${conversationId} (+${added.length} members)`);
    store.addMembers(conversationId, added);

    const self = added.find((m) => m.userId === identity.userId);
    if (!self) {
      return;
    }

    if (self.sessionId) {
      store.setSessionId(conversationId, self.sessionId);
    }

    if (!store.hasConversation(conversationId)) {
      log.info(`Added to unknown conversation ${conversationId} — loading details.`);
      void loadConversation(store, client, identity, conversationId);
    }
  });

  ws.on('conversation.member_removed', (event) => {
    log.debug(
      `Event conversation.member_removed: ${event.payload.conversationId} (target=${event.payload.targetUserId})`,
    );
    store.removeMember(event.payload.conversationId, event.payload.targetUserId);
    if (event.payload.targetUserId === identity.userId) {
      log.info(`Removed from conversation ${event.payload.conversationId}.`);
      store.removeConversation(event.payload.conversationId);
    }
  });

  ws.on('conversation.member_updated', (event) => {
    if (event.payload.userId !== identity.userId) {
      return;
    }
    log.debug(`Event conversation.member_updated (self): ${event.payload.conversationId}`);
    if (event.payload.changes.notifyLevel) {
      store.setNotifyLevel(event.payload.conversationId, event.payload.changes.notifyLevel);
    }
    if (event.payload.changes.sessionId) {
      store.setSessionId(event.payload.conversationId, event.payload.changes.sessionId);
    }
  });

  ws.on('contact.request_received', (event) => {
    const c = event.payload.contact;
    log.info(`Event contact.request_received from @${c.friendUsername}`);
    store.addIncomingRequest(c);
    getHandlers()['contact.request_received']?.({
      username: c.friendUsername,
      displayName: c.friendDisplayName,
      accountType: c.friendAccountType,
      note: c.note,
    });
    const ownerProfile = c.friendAccountType === 'agent' && c.ownerId ? store.getOwnerProfile(c.ownerId) : undefined;
    getHandlers()['contact.event']?.({
      type: 'contact.request_received',
      username: c.friendUsername,
      displayName: c.friendDisplayName,
      accountType: c.friendAccountType,
      ...(ownerProfile?.username ? { ownerUsername: ownerProfile.username } : {}),
      ...(ownerProfile?.displayName ? { ownerDisplayName: ownerProfile.displayName } : {}),
      note: c.note,
      timestamp: event.timestamp,
    });
  });

  ws.on('contact.request_accepted', (event) => {
    const c = event.payload.contact;
    log.info(`Event contact.request_accepted: @${c.friendUsername}`);
    store.removeIncomingRequest(c.contactId);
    store.indexContact(c);
    getHandlers()['contact.request_accepted']?.({
      username: c.friendUsername,
      displayName: c.friendDisplayName,
      accountType: c.friendAccountType,
    });
    const ownerProfile = c.friendAccountType === 'agent' && c.ownerId ? store.getOwnerProfile(c.ownerId) : undefined;
    getHandlers()['contact.event']?.({
      type: 'contact.request_accepted',
      username: c.friendUsername,
      displayName: c.friendDisplayName,
      accountType: c.friendAccountType,
      ...(ownerProfile?.username ? { ownerUsername: ownerProfile.username } : {}),
      ...(ownerProfile?.displayName ? { ownerDisplayName: ownerProfile.displayName } : {}),
      timestamp: event.timestamp,
    });
  });

  ws.on('contact.request_rejected', (event) => {
    log.debug(`Event contact.request_rejected: ${event.payload.contactId}`);
    store.removeIncomingRequest(event.payload.contactId);
    const contact = store.getContact(event.payload.contactId);
    getHandlers()['contact.request_rejected']?.(contact?.friendUsername);
    getHandlers()['contact.event']?.({
      type: 'contact.request_rejected',
      username: contact?.friendUsername,
      displayName: contact?.friendDisplayName,
      accountType: contact?.friendAccountType ?? 'human',
      timestamp: event.timestamp,
    });
  });

  ws.on('contact.request_revoked', (event) => {
    log.debug(`Event contact.request_revoked: ${event.payload.contactId}`);
    store.removeIncomingRequest(event.payload.contactId);
  });

  ws.on('contact.removed', (event) => {
    log.debug(`Event contact.removed: ${event.payload.contactId}`);
    const contact = store.getContact(event.payload.contactId);
    store.removeContact(event.payload.contactId);
    getHandlers()['contact.removed']?.(contact?.friendUsername);
    getHandlers()['contact.event']?.({
      type: 'contact.removed',
      username: contact?.friendUsername,
      displayName: contact?.friendDisplayName,
      accountType: contact?.friendAccountType ?? 'human',
      timestamp: event.timestamp,
    });
  });

  ws.on('contact.friend_name_updated', (event) => {
    log.debug(`Event contact.friend_name_updated: ${event.payload.contactId}`);
    store.updateContact(event.payload.contactId, { friendName: event.payload.friendName });
  });

  ws.on('message.updated', (event) => {
    const { conversationId, messageId, content } = event.payload;
    log.debug(`Event message.updated: ${conversationId}/${messageId}`);
    const updated = store.updateMessage(conversationId, messageId, content.text ?? '');
    if (updated) {
      getHandlers()['message.updated']?.(updated);
    }
  });

  ws.on('message.deleted', (event) => {
    const { conversationId, messageId } = event.payload;
    log.debug(`Event message.deleted: ${conversationId}/${messageId}`);
    const deleted = store.removeMessage(conversationId, messageId);
    if (deleted) {
      getHandlers()['message.deleted']?.(deleted);
    }
  });

  ws.on('block.created', () => {
    log.debug('Event block.created (no-op).');
  });

  ws.on('block.removed', () => {
    log.debug('Event block.removed (no-op).');
  });

  ws.on('user.profile_updated', (event) => {
    const { userId, displayName, avatarUrl, username } = event.payload;
    log.debug(`Event user.profile_updated: ${userId}`);
    if (store.isContact(userId)) {
      store.updateContact(userId, {
        ...(displayName !== undefined ? { friendDisplayName: displayName } : {}),
        ...(avatarUrl !== undefined ? { friendAvatarUrl: avatarUrl } : {}),
        ...(username !== undefined ? { friendUsername: username } : {}),
      });
    }
  });

  ws.on('agent.settings_updated', () => {
    log.debug('Event agent.settings_updated (no-op).');
  });
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
    log.debug(`Loading conversation ${conversationId}...`);
    const conv = await client.getConversation({ conversationId });
    store.setConversation({
      conversationId: conv.conversationId,
      type: conv.type,
      name: conv.name,
      description: conv.description,
      avatarUrl: conv.avatarUrl,
      createdBy: conv.createdBy,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
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
    log.debug(`Loaded conversation ${conversationId} (${conv.members.length} members).`);
  } catch (err) {
    log.error(`Failed to load conversation ${conversationId}.`, err);
  }
}
