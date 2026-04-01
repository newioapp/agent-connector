import { describe, it, expect } from 'vitest';
import { MessageQueue } from '../src/core/instances/message-queue';
import type { IncomingMessage } from '@newio/sdk';

function makeMsg(conversationId: string, text = 'hello'): IncomingMessage {
  return {
    messageId: `msg-${Date.now()}`,
    conversationId,
    conversationType: 'dm',
    senderUserId: 'user-1',
    inContact: true,
    isOwnMessage: false,
    text,
    timestamp: new Date().toISOString(),
  };
}

/** Drain up to `count` batches from the queue, with a timeout to avoid hanging. */
async function drain(
  queue: MessageQueue,
  count: number,
): Promise<Array<readonly [string, readonly IncomingMessage[]]>> {
  const results: Array<readonly [string, readonly IncomingMessage[]]> = [];
  const iter = queue.batches();
  for (let i = 0; i < count; i++) {
    const { value, done } = await iter.next();
    if (done) {
      break;
    }
    results.push(value);
  }
  return results;
}

describe('MessageQueue', () => {
  it('yields a single batch for one conversation', async () => {
    const queue = new MessageQueue();
    queue.enqueue(makeMsg('conv-1', 'a'));
    queue.enqueue(makeMsg('conv-1', 'b'));

    const batches = await drain(queue, 1);
    expect(batches).toHaveLength(1);
    expect(batches[0][0]).toBe('conv-1');
    expect(batches[0][1]).toHaveLength(2);
    expect(batches[0][1][0].text).toBe('a');
    expect(batches[0][1][1].text).toBe('b');
  });

  it('yields batches in FIFO conversation order', async () => {
    const queue = new MessageQueue();
    queue.enqueue(makeMsg('conv-1'));
    queue.enqueue(makeMsg('conv-2'));
    queue.enqueue(makeMsg('conv-3'));

    const batches = await drain(queue, 3);
    expect(batches.map(([id]) => id)).toEqual(['conv-1', 'conv-2', 'conv-3']);
  });

  it('groups messages by conversation', async () => {
    const queue = new MessageQueue();
    queue.enqueue(makeMsg('conv-1', 'a'));
    queue.enqueue(makeMsg('conv-2', 'b'));
    queue.enqueue(makeMsg('conv-1', 'c'));

    // conv-1 was enqueued first, so it yields first with both messages
    const batches = await drain(queue, 2);
    expect(batches[0][0]).toBe('conv-1');
    expect(batches[0][1]).toHaveLength(2);
    expect(batches[1][0]).toBe('conv-2');
    expect(batches[1][1]).toHaveLength(1);
  });

  it('awaits when empty and yields when a message arrives', async () => {
    const queue = new MessageQueue();
    const iter = queue.batches();

    // Start waiting — should not resolve yet
    let resolved = false;
    const promise = iter.next().then((r) => {
      resolved = true;
      return r;
    });

    // Give microtasks a chance to run
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Enqueue a message — should wake the consumer
    queue.enqueue(makeMsg('conv-1', 'wake'));
    const { value, done } = await promise;
    expect(done).toBe(false);
    expect(value[0]).toBe('conv-1');
    expect(value[1][0].text).toBe('wake');
  });

  it('close() terminates the batches() generator', async () => {
    const queue = new MessageQueue();
    const iter = queue.batches();

    // Start waiting
    const promise = iter.next();

    queue.close();
    const { done } = await promise;
    expect(done).toBe(true);
  });

  it('close() terminates generator that is between yields', async () => {
    const queue = new MessageQueue();
    queue.enqueue(makeMsg('conv-1'));

    const iter = queue.batches();
    // Consume the first batch
    await iter.next();

    // Now close while generator would await next message
    const promise = iter.next();
    queue.close();
    const { done } = await promise;
    expect(done).toBe(true);
  });

  it('enqueue is a no-op after close', async () => {
    const queue = new MessageQueue();
    queue.close();
    queue.enqueue(makeMsg('conv-1'));

    const iter = queue.batches();
    const { done } = await iter.next();
    expect(done).toBe(true);
  });
});
