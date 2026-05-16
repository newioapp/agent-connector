/**
 * EventQueue — generalized per-session event queue.
 *
 * Buffers incoming events and yields them for serial processing.
 * Batching rules:
 * - Messages: batched by conversationId (multiple messages to the same conversation grouped)
 * - Contact events: all pending contact events batched into one group
 * - Cron events: no batching, yielded individually
 * - Owner ops: batched by op type, all waiting callbacks resolved together
 */
import type {
  IncomingMessage,
  ContactEvent,
  CronTriggerEvent,
  CompactSessionResponse,
  UpdateMemoryResponse,
  RotateSessionResponse,
} from '@newio/agent-sdk';
import type { SessionType } from './types';

/** Owner-initiated lifecycle operations that can run on a slot. */
export type OwnerOpType = 'compact_session' | 'update_memory' | 'rotate_session';

/** Result type for owner-initiated operations. */
export type OwnerOpResult = CompactSessionResponse | UpdateMemoryResponse | RotateSessionResponse;

export interface OwnerOpCallback {
  readonly resolve: (result: OwnerOpResult) => void;
  readonly reject: (err: unknown) => void;
}

/** Union of all event types that flow through the queue. */
export type AgentEvent =
  | { readonly type: 'messages'; readonly conversationId: string; readonly messages: readonly IncomingMessage[] }
  | { readonly type: 'contact'; readonly events: readonly ContactEvent[] }
  | { readonly type: 'cron'; readonly job: CronTriggerEvent }
  | { readonly type: 'initiate_conversation'; readonly conversationId: string; readonly context: string }
  | { readonly type: 'compact_session'; readonly callbacks: readonly OwnerOpCallback[] }
  | { readonly type: 'update_memory'; readonly callbacks: readonly OwnerOpCallback[] }
  | {
      readonly type: 'rotate_session';
      readonly sessionType: SessionType;
      readonly externalReferenceId: string;
      readonly callbacks: readonly OwnerOpCallback[];
    };

/** Sentinel value used to signal the consumer to stop. */
const CLOSED = Symbol('closed');

interface InitiateConversation {
  readonly __tag: 'initiate_conversation';
  readonly conversationId: string;
  readonly context: string;
}

interface CronPendingKey {
  readonly __tag: 'cron';
  readonly job: CronTriggerEvent;
}

/** Pending key types in the FIFO array. */
type PendingKey =
  | `conv:${string}`
  | 'contact'
  | 'compact_session'
  | 'update_memory'
  | 'rotate_session'
  | CronPendingKey
  | InitiateConversation;

export class EventQueue {
  /** Pending message batches keyed by conversationId. */
  private readonly messageBatches = new Map<string, IncomingMessage[]>();
  /** Pending contact events (batched together). */
  private contactEvents: ContactEvent[] = [];
  private compactSessionCallbacks: OwnerOpCallback[] = [];
  private updateMemoryCallbacks: OwnerOpCallback[] = [];
  private rotateSessionCallbacks: OwnerOpCallback[] = [];

  /** FIFO order of pending event keys. */
  private readonly pending: PendingKey[] = [];
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
    this.pending.push({ __tag: 'cron', job });
    this.wake();
  }

  enqueueInitiatingConversation(conversationId: string, context: string): void {
    if (this.closed) {
      return;
    }
    this.pending.push({ __tag: 'initiate_conversation', conversationId, context });
    this.wake();
  }

  /**
   * Enqueue an owner-initiated operation. The callback is resolved/rejected
   * when the session loop processes the op.
   */
  enqueueOwnerOp(type: OwnerOpType, callback: OwnerOpCallback): void {
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
    if (this.pending.includes(type)) {
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

      if (key === 'compact_session') {
        const callbacks = this.compactSessionCallbacks;
        this.compactSessionCallbacks = [];
        yield { type: 'compact_session', callbacks };
        continue;
      } else if (key === 'rotate_session') {
        const callbacks = this.rotateSessionCallbacks;
        this.rotateSessionCallbacks = [];
        yield {
          type: 'rotate_session',
          callbacks,
          sessionType: this.sessionType,
          externalReferenceId: this.externalReferenceId,
        };
        continue;
      } else if (key === 'update_memory') {
        const callbacks = this.updateMemoryCallbacks;
        this.updateMemoryCallbacks = [];
        yield { type: 'update_memory', callbacks };
        continue;
      } else if (key === 'contact') {
        const events = this.contactEvents;
        this.contactEvents = [];
        if (events.length > 0) {
          yield { type: 'contact', events };
        }
        continue;
      } else if (typeof key === 'string' && key.startsWith('conv:')) {
        const conversationId = key.slice('conv:'.length);
        const messages = this.messageBatches.get(conversationId);
        this.messageBatches.delete(conversationId);
        if (messages && messages.length > 0) {
          yield { type: 'messages', conversationId, messages };
        }
        continue;
      }

      // Tagged object types — discriminated by __tag
      if (typeof key === 'object') {
        if (key.__tag === 'initiate_conversation') {
          yield { type: 'initiate_conversation', conversationId: key.conversationId, context: key.context };
        } else {
          yield { type: 'cron', job: key.job };
        }
        continue;
      }
    }
  }

  /**
   * Reset the queue — clears all pending events and rejects pending owner op callbacks.
   * Does NOT close the queue; the session loop continues waiting for new events.
   */
  reset(): void {
    this.rejectAllCallbacks(new Error('Operation cancelled'));
    this.pending.length = 0;
    this.messageBatches.clear();
    this.contactEvents = [];
  }

  /** Close the queue — clears pending events and terminates the events() generator. */
  close(): void {
    this.closed = true;
    this.rejectAllCallbacks(new Error('Queue closed'));
    this.messageBatches.clear();
    this.contactEvents = [];
    this.pending.length = 0;
    this.resolve?.(CLOSED);
    this.resolve = null;
  }

  private rejectAllCallbacks(err: Error): void {
    for (const cb of this.compactSessionCallbacks) {
      cb.reject(err);
    }
    for (const cb of this.updateMemoryCallbacks) {
      cb.reject(err);
    }
    for (const cb of this.rotateSessionCallbacks) {
      cb.reject(err);
    }
    this.compactSessionCallbacks = [];
    this.updateMemoryCallbacks = [];
    this.rotateSessionCallbacks = [];
  }

  private wake(): void {
    this.resolve?.(undefined);
  }
}
