/**
 * MessageProcessor — handles incoming message events.
 *
 * Extracted from events.ts for testability. Owns:
 * - Sequence number tracking and gap detection
 * - Backfill of missed messages
 * - Action response resolution
 * - Notify level filtering
 * - Message insertion into the store
 */
import { getLogger } from '../core/logger.js';
import type { NewioClient } from '../core/client.js';
import type { MessageContent, MessageRecord } from '../core/types.js';
import type { MessageNewEvent } from '../core/events.js';
import type { NewioAppStore } from './store.js';
import type { AppEventHandlers, NewioIdentity } from './types.js';
import type { PendingActions } from './pending-actions.js';

const log = getLogger('message-processor');

export class MessageProcessor {
  constructor(
    private readonly store: NewioAppStore,
    private readonly client: NewioClient,
    private readonly identity: NewioIdentity,
    private readonly getHandlers: () => Partial<AppEventHandlers>,
    private readonly pendingActions: PendingActions,
  ) {}

  /**
   * Process a message.new event.
   * Order: sequence tracking + gap detection → resolve pending actions → filter → notify.
   */
  async handleMessageNew(payload: MessageNewEvent['payload']): Promise<void> {
    // 1. Sequence tracking and gap detection (always, for all message types)
    const currentSeq = this.store.getSequenceNumber(payload.conversationId);
    const incomingSeq = payload.sequenceNumber;
    if (incomingSeq > currentSeq) {
      this.store.setSequenceNumber(payload.conversationId, incomingSeq);
    }

    if (incomingSeq > currentSeq + 1 && currentSeq > 0) {
      log.warn(
        `Sequence gap in ${payload.conversationId}: expected ${currentSeq + 1}, got ${incomingSeq}. Backfilling...`,
      );
      const cached = this.store.getRecentMessages(payload.conversationId);
      if (cached.length > 0) {
        const prev = cached[cached.length - 1];
        if (prev) {
          await this.backfillGap(payload.conversationId, prev.messageId, payload.messageId, currentSeq);
        }
      }
    }

    // 2. Resolve pending action requests
    if (payload.content.response) {
      this.pendingActions.resolve(payload.content.response);
    }

    // 3. Skip action messages and visibleTo-filtered messages
    if (shouldSkipMessage(payload.content, payload.visibleTo, this.identity.userId)) {
      return;
    }

    // 4. Normal message handling
    this.handleIncomingMessage(payload);
  }

  private handleIncomingMessage(payload: MessageNewEvent['payload']): void {
    const message = this.store.toIncomingMessage(
      this.identity,
      payload,
      payload.conversationId,
      payload.conversationType,
    );
    const inserted = this.store.insertMessage(payload.conversationId, message);

    if (inserted && !message.isOwnMessage) {
      const level = this.store.getNotifyLevel(payload.conversationId) ?? 'all';
      const shouldNotify =
        level === 'all' || (level === 'mentions' && isMentioned(payload.content, this.identity.userId));
      if (shouldNotify) {
        this.getHandlers()['message.new']?.(message);
      }
    }
  }

  private async backfillGap(
    conversationId: string,
    afterMessageId: string,
    beforeMessageId: string,
    rollbackSeq: number,
  ): Promise<void> {
    try {
      let count = 0;
      let cursor: string | undefined;
      do {
        const resp = await this.client.listMessages({
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
          if (msg.messageId === afterMessageId || msg.messageId === beforeMessageId) {
            continue;
          }
          if (msg.content.response) {
            this.pendingActions.resolve(msg.content.response);
          }
          if (shouldSkipMessage(msg.content, msg.visibleTo, this.identity.userId)) {
            count++;
            continue;
          }
          const message = this.store.toIncomingMessage(this.identity, msg, conversationId);
          const inserted = this.store.insertMessage(conversationId, message);
          if (inserted && !message.isOwnMessage) {
            this.getHandlers()['message.new']?.(message);
          }
          count++;
        }
        cursor = resp.cursor;
      } while (cursor);
      log.info(`Backfilled ${count} messages in ${conversationId}.`);
    } catch (err) {
      log.error(`Failed to backfill messages in ${conversationId}. Rolling back sequence number.`, err);
      this.store.setSequenceNumber(conversationId, rollbackSeq);
    }
  }
}

/** Returns true if the message is an action message or not visible to the current user. */
export function shouldSkipMessage(
  content: MessageContent,
  visibleTo: ReadonlyArray<string> | undefined,
  userId: string,
): boolean {
  if (content.response || content.action) {
    return true;
  }
  if (visibleTo && !visibleTo.includes(userId)) {
    return true;
  }
  return false;
}

/** Check if the user is mentioned in the message content. */
export function isMentioned(content: MessageRecord['content'], userId: string): boolean {
  if (!content.mentions) {
    return false;
  }
  return !!(content.mentions.everyone || content.mentions.here || content.mentions.userIds?.includes(userId));
}
