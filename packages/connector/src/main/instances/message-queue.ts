/**
 * Per-conversation message queue with FIFO ordering across conversations.
 * Buffers incoming messages and yields conversation batches for serial processing.
 */
import type { IncomingMessage } from '../newio-app';

export class MessageQueue {
  private readonly queue = new Map<string, IncomingMessage[]>();
  private readonly pending: string[] = [];
  private resolve: (() => void) | null = null;

  /** Add a message to the queue. Wakes the consumer if it's awaiting. */
  enqueue(msg: IncomingMessage): void {
    const existing = this.queue.get(msg.conversationId);
    if (existing) {
      existing.push(msg);
    } else {
      this.queue.set(msg.conversationId, [msg]);
      this.pending.push(msg.conversationId);
    }
    this.resolve?.();
  }

  /** Async generator that yields [conversationId, messages] batches as they arrive. */
  async *batches(): AsyncGenerator<readonly [string, readonly IncomingMessage[]]> {
    for (;;) {
      if (this.pending.length === 0) {
        await new Promise<void>((r) => {
          this.resolve = r;
        });
        this.resolve = null;
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

  /** Clear all queued messages and wake any pending consumer. */
  clear(): void {
    this.queue.clear();
    this.pending.length = 0;
    this.resolve?.();
    this.resolve = null;
  }
}
