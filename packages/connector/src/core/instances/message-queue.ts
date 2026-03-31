/**
 * Per-conversation message queue with FIFO ordering across conversations.
 * Buffers incoming messages and yields conversation batches for serial processing.
 */
import type { IncomingMessage } from '../newio-app';

/** Sentinel value used to signal the consumer to stop. */
const CLOSED = Symbol('closed');

export class MessageQueue {
  private readonly queue = new Map<string, IncomingMessage[]>();
  private readonly pending: string[] = [];
  private resolve: ((value: typeof CLOSED | undefined) => void) | null = null;
  private closed = false;

  /** Add a message to the queue. Wakes the consumer if it's awaiting. */
  enqueue(msg: IncomingMessage): void {
    if (this.closed) {
      return;
    }
    const existing = this.queue.get(msg.conversationId);
    if (existing) {
      existing.push(msg);
    } else {
      this.queue.set(msg.conversationId, [msg]);
      this.pending.push(msg.conversationId);
    }
    this.resolve?.(undefined);
  }

  /** Async generator that yields [conversationId, messages] batches as they arrive. */
  async *batches(): AsyncGenerator<readonly [string, readonly IncomingMessage[]]> {
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

      const conversationId = this.pending.shift();
      if (!conversationId) {
        continue;
      }

      const messages = this.queue.get(conversationId);
      this.queue.delete(conversationId);

      if (messages === undefined || messages.length === 0) {
        continue;
      }

      yield [conversationId, messages] as const;
    }
  }

  /** Close the queue — clears pending messages and terminates the batches() generator. */
  close(): void {
    this.closed = true;
    this.queue.clear();
    this.pending.length = 0;
    this.resolve?.(CLOSED);
    this.resolve = null;
  }
}
