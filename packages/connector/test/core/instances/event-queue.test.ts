import { describe, it, expect } from 'vitest';
import { EventQueue } from '../../../src/core/instances/event-queue';
import type { AgentEvent } from '../../../src/core/instances/event-queue';
import type { IncomingMessage, ContactEvent, CronTriggerEvent } from '@newio/sdk';

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    conversationType: 'dm',
    senderUserId: 'user-1',
    senderUsername: 'alice',
    senderDisplayName: 'Alice',
    senderAccountType: 'human',
    relationship: 'in-contact' as const,
    isOwnMessage: false,
    text: 'hello',
    timestamp: '2026-03-17T22:55:41Z',
    status: 'new',
    ...overrides,
  };
}

function makeContactEvent(overrides: Partial<ContactEvent> = {}): ContactEvent {
  return {
    type: 'contact.request_received',
    username: 'alice',
    displayName: 'Alice',
    accountType: 'human',
    timestamp: '2026-04-04T10:00:00Z',
    ...overrides,
  };
}

function makeCronEvent(overrides: Partial<CronTriggerEvent> = {}): CronTriggerEvent {
  return {
    cronId: 'cron-1',
    newioSessionId: 'session-1',
    label: 'Test cron',
    triggeredAt: '2026-04-05T09:00:00Z',
    ...overrides,
  };
}

/** Collect the next N events from the queue (with a timeout to prevent hanging). */
async function collectEvents(queue: EventQueue, count: number, timeoutMs = 500): Promise<AgentEvent[]> {
  const results: AgentEvent[] = [];
  const gen = queue.events();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs));

  for (let i = 0; i < count; i++) {
    const next = await Promise.race([gen.next(), timeout]);
    if (next.done) {
      break;
    }
    results.push(next.value);
  }
  return results;
}

describe('EventQueue', () => {
  // ---------------------------------------------------------------------------
  // Message batching
  // ---------------------------------------------------------------------------

  describe('message batching', () => {
    it('batches messages by conversationId', async () => {
      const queue = new EventQueue();
      queue.enqueueMessage(makeMsg({ conversationId: 'conv-1', text: 'first' }));
      queue.enqueueMessage(makeMsg({ conversationId: 'conv-1', text: 'second', messageId: 'msg-2' }));

      const events = await collectEvents(queue, 1);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('messages');
      if (events[0].type === 'messages') {
        expect(events[0].conversationId).toBe('conv-1');
        expect(events[0].messages).toHaveLength(2);
      }
      queue.close();
    });

    it('yields separate batches for different conversations', async () => {
      const queue = new EventQueue();
      queue.enqueueMessage(makeMsg({ conversationId: 'conv-1' }));
      queue.enqueueMessage(makeMsg({ conversationId: 'conv-2', messageId: 'msg-2' }));

      const events = await collectEvents(queue, 2);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('messages');
      expect(events[1].type).toBe('messages');
      if (events[0].type === 'messages' && events[1].type === 'messages') {
        expect(events[0].conversationId).toBe('conv-1');
        expect(events[1].conversationId).toBe('conv-2');
      }
      queue.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Contact batching
  // ---------------------------------------------------------------------------

  describe('contact batching', () => {
    it('batches all pending contact events together', async () => {
      const queue = new EventQueue();
      queue.enqueueContact(makeContactEvent({ type: 'contact.request_received', username: 'alice' }));
      queue.enqueueContact(makeContactEvent({ type: 'contact.request_accepted', username: 'bob' }));

      const events = await collectEvents(queue, 1);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('contact');
      if (events[0].type === 'contact') {
        expect(events[0].events).toHaveLength(2);
        expect(events[0].events[0].username).toBe('alice');
        expect(events[0].events[1].username).toBe('bob');
      }
      queue.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Cron — no batching
  // ---------------------------------------------------------------------------

  describe('cron events', () => {
    it('yields cron events individually', async () => {
      const queue = new EventQueue();
      queue.enqueueCron(makeCronEvent({ cronId: 'cron-1' }));
      queue.enqueueCron(makeCronEvent({ cronId: 'cron-2' }));

      const events = await collectEvents(queue, 2);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('cron');
      expect(events[1].type).toBe('cron');
      if (events[0].type === 'cron' && events[1].type === 'cron') {
        expect(events[0].job.cronId).toBe('cron-1');
        expect(events[1].job.cronId).toBe('cron-2');
      }
      queue.close();
    });
  });

  // ---------------------------------------------------------------------------
  // FIFO ordering across types
  // ---------------------------------------------------------------------------

  describe('FIFO ordering', () => {
    it('preserves insertion order across event types', async () => {
      const queue = new EventQueue();
      queue.enqueueMessage(makeMsg({ conversationId: 'conv-1' }));
      queue.enqueueContact(makeContactEvent());
      queue.enqueueCron(makeCronEvent());

      const events = await collectEvents(queue, 3);
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('messages');
      expect(events[1].type).toBe('contact');
      expect(events[2].type).toBe('cron');
      queue.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Close behavior
  // ---------------------------------------------------------------------------

  describe('close', () => {
    it('terminates the events generator', async () => {
      const queue = new EventQueue();
      queue.enqueueMessage(makeMsg());
      queue.close();

      const events: AgentEvent[] = [];
      for await (const event of queue.events()) {
        events.push(event);
      }
      expect(events).toHaveLength(0);
    });

    it('ignores enqueues after close', async () => {
      const queue = new EventQueue();
      queue.close();
      queue.enqueueMessage(makeMsg());
      queue.enqueueContact(makeContactEvent());
      queue.enqueueCron(makeCronEvent());

      const events: AgentEvent[] = [];
      for await (const event of queue.events()) {
        events.push(event);
      }
      expect(events).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Async wake behavior
  // ---------------------------------------------------------------------------

  describe('async wake', () => {
    it('wakes consumer when event is enqueued after consumer starts waiting', async () => {
      const queue = new EventQueue();

      // Start consuming (will block waiting for events)
      const eventPromise = collectEvents(queue, 1, 2000);

      // Enqueue after a short delay
      setTimeout(() => {
        queue.enqueueMessage(makeMsg());
      }, 50);

      const events = await eventPromise;
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('messages');
      queue.close();
    });
  });
});
