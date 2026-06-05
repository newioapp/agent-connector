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
import { getLogger } from '@newio/agent-sdk';
import type { NewioClient } from '@newio/agent-sdk';
import type { ConversationType, MessageContent, MessageRecord } from '@newio/agent-sdk';
import type { MessageEventPayload } from '@newio/agent-sdk';
import type { NewioAppStore } from './store.js';
import type { MessageDeletedHandler, MessageNewHandler, MessageUpdatedHandler, NewioIdentity } from './types.js';
import type { PendingActions } from './pending-actions.js';

const log = getLogger('message-processor');

export class MessageProcessor {
  constructor(
    private readonly store: NewioAppStore,
    private readonly client: NewioClient,
    private readonly identity: NewioIdentity,
    private readonly getMessageNewHandler: () => MessageNewHandler | undefined,
    private readonly getMessageUpdatedHandler: () => MessageUpdatedHandler | undefined,
    private readonly getMessageDeletedHandler: () => MessageDeletedHandler | undefined,
    private readonly pendingActions: PendingActions,
  ) {}

  /**
   * Process a message event (new, edit, or delete). All three arrive as a message with
   * its own sequenceNumber — edits/deletes are append-only "ref" messages whose
   * `content.ref` points at the target. Order: sequence tracking + gap detection
   * (backfill) → resolve pending actions → apply to the store + deliver to the matching
   * handler. Edits/deletes carry a sequenceNumber too, so tracking them is what keeps the
   * next message from being mistaken for a gap.
   */
  async handleMessage(payload: MessageEventPayload): Promise<void> {
    await this.trackSequenceAndBackfill(payload);

    if (payload.content.response) {
      this.pendingActions.resolve(payload.content.response);
    }

    this.applyMessage(payload.conversationId, payload, payload.conversationType);
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

  /**
   * Apply one message to the store and deliver it to the matching handler. Used by both
   * the live path and backfill, so edit/delete ref messages are handled identically
   * however they arrive:
   *   - edit ref   → update the cached target, deliver to the message.updated handler
   *   - delete ref → mark the cached target deleted, deliver to the message.deleted handler
   *   - otherwise  → insert and deliver to the message.new handler (notify-level filtered)
   */
  private applyMessage(conversationId: string, msg: MessageRecord, conversationType?: ConversationType): void {
    const ref = msg.content.ref;
    if (ref?.type === 'edit') {
      const updated = this.store.updateMessage(conversationId, ref.targetMessageId, msg.content.text ?? '');
      if (updated) {
        this.getMessageUpdatedHandler()?.(updated);
      }
      return;
    }
    if (ref?.type === 'delete') {
      const deleted = this.store.removeMessage(conversationId, ref.targetMessageId);
      if (deleted) {
        this.getMessageDeletedHandler()?.(deleted);
      }
      return;
    }

    // Action requests/responses and not-visible messages are not surfaced as new messages.
    if (shouldSkipMessage(msg.content, msg.visibleTo, this.identity.userId)) {
      return;
    }

    const message = this.store.toIncomingMessage(this.identity, msg, conversationId, conversationType);
    const inserted = this.store.insertMessage(conversationId, message);
    if (inserted && !message.isOwnMessage) {
      const level = this.store.getConversationControls(conversationId)?.notifyLevel ?? 'all';
      const shouldNotify = level === 'all' || (level === 'mentions' && isMentioned(msg.content, this.identity.userId));
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
      // Collect the whole gap first. listMessages returns newest-first (and the gap may
      // span pages), so we can't apply as we go: an edit/delete ref could be processed
      // before its target is cached, leaving the target stale/undeleted.
      const collected: MessageRecord[] = [];
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
          collected.push(msg);
        }
        cursor = resp.cursor;
      } while (cursor);

      // Apply oldest-first so a target message is always cached before any edit/delete
      // ref that points at it. Routes through the same path as live events.
      collected.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      for (const msg of collected) {
        if (msg.content.response) {
          this.pendingActions.resolve(msg.content.response);
        }
        this.applyMessage(conversationId, msg);
      }
      log.info(`Backfilled ${collected.length} messages in ${conversationId}.`);
    } catch (err) {
      log.error(`Failed to backfill messages in ${conversationId}. Rolling back sequence number.`, err);
      this.store.setSequenceNumber(conversationId, rollbackSeq);
    }
  }
}

/**
 * Returns true if the message should not be surfaced to the agent as a new message:
 * action/response messages, or messages not visible to the user. Edit/delete ref
 * messages are routed by `applyMessage`, not filtered here.
 */
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
