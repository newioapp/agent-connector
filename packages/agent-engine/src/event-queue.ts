/**
 * EventQueue — generalized per-session event queue.
 *
 * Buffers incoming events and yields them for serial processing.
 * Batching rules:
 * - Messages: batched by conversationId (multiple messages to the same conversation grouped)
 * - Contact events: all pending contact events batched into one group
 * - Cron events: no batching, yielded individually
 * - Owner ops: no batching, yielded individually with promise tracking
 */
import type {
  IncomingMessage,
  ContactEvent,
  CronTriggerEvent,
  CompactSessionResponse,
  UpdateMemoryResponse,
  RotateSessionResponse,
} from '@newio/agent-sdk';
import { SessionType } from './types';

/** Owner-initiated lifecycle operations that can run on a slot. */
export type OwnerOpType = 'compact_session' | 'update_memory' | 'rotate_session';

/** Result type for owner-initiated operations. */
export type OwnerOpResult = CompactSessionResponse | UpdateMemoryResponse | RotateSessionResponse;

export interface Callback {
  readonly resolve: (result: OwnerOpResult) => void;
  readonly reject: (err: unknown) => void;
}

/** Union of all event types that flow through the queue. */
export type AgentEvent =
  | { readonly type: 'messages'; readonly conversationId: string; readonly messages: readonly IncomingMessage[] }
  | { readonly type: 'contact'; readonly events: readonly ContactEvent[] }
  | { readonly type: 'cron'; readonly job: CronTriggerEvent }
  | { readonly type: 'compact_session'; readonly callbacks: readonly Callback[] }
  | { readonly type: 'update_memory'; readonly callbacks: readonly Callback[] }
  | {
      readonly type: 'rotate_session';
      readonly sessionType: SessionType;
      readonly externalReferenceId: string;
      readonly callbacks: readonly Callback[];
    };

/** Sentinel value used to signal the consumer to stop. */
const CLOSED = Symbol('closed');

export class EventQueue {
  /** Pending message batches keyed by conversationId. */
  private readonly messageBatches = new Map<string, IncomingMessage[]>();
  /** Pending contact events (batched together). */
  private contactEvents: ContactEvent[] = [];
  private compactSessionCallbacks: Callback[] = [];
  private updateMemoryCallbacks: Callback[] = [];
  private rotateSessionCallbacks: Callback[] = [];

  /** FIFO order of pending keys: conversationId strings, 'contact', CronTriggerEvent objects, or OwnerOpEntry objects. */
  private readonly pending: Array<
    `conv:${string}` | 'contact' | 'compact_session' | `update_memory` | `rotate_session` | CronTriggerEvent
  > = [];
  private resolve: ((value: typeof CLOSED | undefined) => void) | null = null;
  private closed = false;

  constructor(
    readonly sessionType: SessionType,
    readonly externalReferenceId: string,
  ) {}

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
      this.pending.push(`conv:${msg.conversationId}`);
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

  /**
   * Enqueue an owner-initiated operation. Returns a promise that resolves/rejects
   * when the session loop processes the op.
   */
  enqueueOwnerOp(type: OwnerOpType, callback: Callback): void {
    if (this.closed) {
      return callback.reject(new Error('Queue is closed'));
    }
    if (type === 'compact_session') {
      this.compactSessionCallbacks.push(callback);
    } else if (type === 'rotate_session') {
      this.rotateSessionCallbacks.push(callback);
    } else {
      this.updateMemoryCallbacks.push(callback);
    }
    const existing = this.pending.findIndex((p) => p === type);
    if (existing !== -1) {
      this.wake();
      return;
    }
    this.pending.push(type);
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

      // Owner op entry
      if (key === 'compact_session') {
        const callbacks = this.compactSessionCallbacks;
        this.compactSessionCallbacks = [];
        yield { type: 'compact_session', callbacks: callbacks };
        continue;
      } else if (key === 'rotate_session') {
        const callbacks = this.rotateSessionCallbacks;
        this.rotateSessionCallbacks = [];
        yield {
          type: 'rotate_session',
          callbacks: callbacks,
          sessionType: this.sessionType,
          externalReferenceId: this.externalReferenceId,
        };
        continue;
      } else if (key === 'update_memory') {
        const callbacks = this.updateMemoryCallbacks;
        this.updateMemoryCallbacks = [];
        yield { type: 'update_memory', callbacks: callbacks };
        continue;
      } else if (key === 'contact') {
        const events = this.contactEvents;
        this.contactEvents = [];
        if (events.length > 0) {
          yield { type: 'contact', events };
        }
        continue;
      } else if (typeof key === 'string' && key.startsWith('conv:')) {
        // Message batch (key is conversationId)
        const conversationId = key.slice('conv:'.length);
        const messages = this.messageBatches.get(conversationId);
        this.messageBatches.delete(conversationId);
        if (messages && messages.length > 0) {
          yield { type: 'messages', conversationId: conversationId, messages };
        }
        continue;
      }

      // Cron event (object, not string)
      if (typeof key === 'object') {
        yield { type: 'cron', job: key };
        continue;
      }
    }
  }

  /**
   * Reset the queue — clears all pending events and rejects pending owner op promises.
   * Does NOT close the queue; the session loop continues waiting for new events.
   */
  reset(): void {
    // Reject all pending owner ops

    this.compactSessionCallbacks.forEach((callback) => callback.reject(new Error('Operation cancelled')));
    this.updateMemoryCallbacks.forEach((callback) => callback.reject(new Error('Operation cancelled')));
    this.rotateSessionCallbacks.forEach((callback) => callback.reject(new Error('Operation cancelled')));
    this.pending.length = 0;
    this.messageBatches.clear();
    this.contactEvents = [];
    this.compactSessionCallbacks = [];
    this.updateMemoryCallbacks = [];
    this.rotateSessionCallbacks = [];
  }

  /** Close the queue — clears pending events and terminates the events() generator. */
  close(): void {
    this.closed = true;

    this.compactSessionCallbacks.forEach((callback) => callback.reject(new Error('Queue closed')));
    this.updateMemoryCallbacks.forEach((callback) => callback.reject(new Error('Queue closed')));
    this.rotateSessionCallbacks.forEach((callback) => callback.reject(new Error('Queue closed')));
    this.messageBatches.clear();
    this.contactEvents = [];
    this.compactSessionCallbacks = [];
    this.updateMemoryCallbacks = [];
    this.rotateSessionCallbacks = [];
    this.pending.length = 0;
    this.resolve?.(CLOSED);
    this.resolve = null;
  }

  private wake(): void {
    this.resolve?.(undefined);
  }
}
