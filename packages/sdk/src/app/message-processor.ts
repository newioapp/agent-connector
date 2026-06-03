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
import type { MessageEventPayload } from '../core/events.js';
import type { NewioAppStore } from './store.js';
import type { IncomingMessage, MessageNewHandler, NewioIdentity } from './types.js';
import type { PendingActions } from './pending-actions.js';

const log = getLogger('message-processor');

export class MessageProcessor {
  constructor(
    private readonly store: NewioAppStore,
    private readonly client: NewioClient,
    private readonly identity: NewioIdentity,
    private readonly getMessageNewHandler: () => MessageNewHandler | undefined,
    private readonly pendingActions: PendingActions,
  ) {}

  /**
   * Process a message.new event.
   * Order: sequence tracking + gap detection → resolve pending actions → filter → notify.
   */
  async handleMessageNew(payload: MessageEventPayload): Promise<void> {
    // 1. Sequence tracking and gap detection (always, for all message types)
    await this.trackSequenceAndBackfill(payload);

    // 2. Resolve pending action requests
    if (payload.content.response) {
      this.pendingActions.resolve(payload.content.response);
    }

    // 3. Skip action messages, ref (edit/delete) messages, and visibleTo-filtered messages
    if (shouldSkipMessage(payload.content, payload.visibleTo, this.identity.userId)) {
      return;
    }

    // 4. Normal message handling
    this.handleIncomingMessage(payload);
  }

  /**
   * Process a message.updated event. Edits arrive as their own ref message carrying
   * a sequenceNumber, so we MUST track the sequence (and run gap detection) exactly
   * like a new message — otherwise the next message would be seen as a gap and trigger
   * a spurious backfill. The edit is applied to the cached target message; it is not
   * surfaced as a new message. Returns the updated cached message, if any.
   */
  async handleMessageUpdated(payload: MessageEventPayload): Promise<IncomingMessage | undefined> {
    await this.trackSequenceAndBackfill(payload);
    const targetMessageId = payload.content.ref?.targetMessageId;
    if (!targetMessageId) {
      return undefined;
    }
    return this.store.updateMessage(payload.conversationId, targetMessageId, payload.content.text ?? '');
  }

  /**
   * Process a message.deleted event. Like edits, deletes arrive as their own ref
   * message with a sequenceNumber that must be tracked for gap detection. The cached
   * target message is marked deleted; it is not surfaced as a new message. Returns the
   * deleted cached message, if any.
   */
  async handleMessageDeleted(payload: MessageEventPayload): Promise<IncomingMessage | undefined> {
    await this.trackSequenceAndBackfill(payload);
    const targetMessageId = payload.content.ref?.targetMessageId;
    if (!targetMessageId) {
      return undefined;
    }
    return this.store.removeMessage(payload.conversationId, targetMessageId);
  }

  /**
   * Advance the conversation's sequence tracker and backfill any gap. Runs for every
   * message event — new, updated, and deleted — because edit/delete ref messages now
   * carry their own sequenceNumber.
   */
  private async trackSequenceAndBackfill(payload: MessageEventPayload): Promise<void> {
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
  }

  private handleIncomingMessage(payload: MessageEventPayload): void {
    const message = this.store.toIncomingMessage(
      this.identity,
      payload,
      payload.conversationId,
      payload.conversationType,
    );
    const inserted = this.store.insertMessage(payload.conversationId, message);

    if (inserted && !message.isOwnMessage) {
      const level = this.store.getConversationControls(payload.conversationId)?.notifyLevel ?? 'all';
      const shouldNotify =
        level === 'all' || (level === 'mentions' && isMentioned(payload.content, this.identity.userId));
      if (shouldNotify) {
        this.getMessageNewHandler()?.(message);
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
            this.getMessageNewHandler()?.(message);
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

/**
 * Returns true if the message should not be surfaced to the agent as a new message:
 * action/response messages, edit/delete ref messages, or messages not visible to the user.
 */
export function shouldSkipMessage(
  content: MessageContent,
  visibleTo: ReadonlyArray<string> | undefined,
  userId: string,
): boolean {
  if (content.response || content.action || content.ref) {
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
