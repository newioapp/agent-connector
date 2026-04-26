/**
 * EventQueue — generalized per-session event queue.
 *
 * Buffers incoming events and yields them for serial processing.
 * Batching rules:
 * - Messages: batched by conversationId (multiple messages to the same conversation grouped)
 * - Contact events: all pending contact events batched into one group
 * - Cron events: no batching, yielded individually
 */
import type { IncomingMessage, ContactEvent, CronTriggerEvent } from '@newio/agent-sdk';

/** Union of all event types that flow through the queue. */
export type AgentEvent =
  | { readonly type: 'messages'; readonly conversationId: string; readonly messages: readonly IncomingMessage[] }
  | { readonly type: 'contact'; readonly events: readonly ContactEvent[] }
  | { readonly type: 'cron'; readonly job: CronTriggerEvent };

/** Sentinel value used to signal the consumer to stop. */
const CLOSED = Symbol('closed');

export class EventQueue {
  /** Pending message batches keyed by conversationId. */
  private readonly messageBatches = new Map<string, IncomingMessage[]>();
  /** Pending contact events (batched together). */
  private contactEvents: ContactEvent[] = [];
  /** FIFO order of pending keys: conversationId strings, 'contact', or CronTriggerEvent objects. */
  private readonly pending: Array<string | CronTriggerEvent> = [];
  private resolve: ((value: typeof CLOSED | undefined) => void) | null = null;
  private closed = false;

  /** Add a message to the queue. */
  enqueueMessage(msg: IncomingMessage): void {
    if (this.closed) {
      return;
    }
    const existing = this.messageBatches.get(msg.conversationId);
    if (existing) {
      existing.push(msg);
    } else {
      this.messageBatches.set(msg.conversationId, [msg]);
      this.pending.push(msg.conversationId);
    }
    this.wake();
  }

  /** Add a contact event to the queue. */
  enqueueContact(event: ContactEvent): void {
    if (this.closed) {
      return;
    }
    const wasEmpty = this.contactEvents.length === 0;
    this.contactEvents.push(event);
    if (wasEmpty) {
      this.pending.push('contact');
    }
    this.wake();
  }

  /** Add a cron event to the queue (no batching). */
  enqueueCron(job: CronTriggerEvent): void {
    if (this.closed) {
      return;
    }
    this.pending.push(job);
    this.wake();
  }

  /** Async generator that yields AgentEvent items as they become available. */
  async *events(): AsyncGenerator<AgentEvent> {
    for (;;) {
      if (this.pending.length === 0) {
        if (this.closed) {
          return;
        }
        const signal = await new Promise<typeof CLOSED | undefined>((r) => {
          this.resolve = r;
        });
        this.resolve = null;
        if (signal === CLOSED) {
          return;
        }
      }

      const key = this.pending.shift();
      if (key === undefined) {
        continue;
      }

      // Cron event (object, not string)
      if (typeof key === 'object') {
        yield { type: 'cron', job: key };
        continue;
      }

      // Contact batch
      if (key === 'contact') {
        const events = this.contactEvents;
        this.contactEvents = [];
        if (events.length > 0) {
          yield { type: 'contact', events };
        }
        continue;
      }

      // Message batch (key is conversationId)
      const messages = this.messageBatches.get(key);
      this.messageBatches.delete(key);
      if (messages && messages.length > 0) {
        yield { type: 'messages', conversationId: key, messages };
      }
    }
  }

  /** Close the queue — clears pending events and terminates the events() generator. */
  close(): void {
    this.closed = true;
    this.messageBatches.clear();
    this.contactEvents = [];
    this.pending.length = 0;
    this.resolve?.(CLOSED);
    this.resolve = null;
  }

  private wake(): void {
    this.resolve?.(undefined);
  }
}
