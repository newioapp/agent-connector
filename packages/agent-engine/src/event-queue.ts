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

/** Owner-initiated lifecycle operations that can run on a slot. */
export type OwnerOpType = 'compact_session' | 'update_memory' | 'rotate_session';

/** Result type for owner-initiated operations. */
export type OwnerOpResult = CompactSessionResponse | UpdateMemoryResponse | RotateSessionResponse;

/** Union of all event types that flow through the queue. */
export type AgentEvent =
  | { readonly type: 'messages'; readonly conversationId: string; readonly messages: readonly IncomingMessage[] }
  | { readonly type: 'contact'; readonly events: readonly ContactEvent[] }
  | { readonly type: 'cron'; readonly job: CronTriggerEvent }
  | {
      readonly type: 'owner_op';
      readonly opType: OwnerOpType;
      readonly resolve: (result: OwnerOpResult) => void;
      readonly reject: (err: Error) => void;
    };

/** Sentinel value used to signal the consumer to stop. */
const CLOSED = Symbol('closed');

export class EventQueue {
  /** Pending message batches keyed by conversationId. */
  private readonly messageBatches = new Map<string, IncomingMessage[]>();
  /** Pending contact events (batched together). */
  private contactEvents: ContactEvent[] = [];
  /** FIFO order of pending keys: conversationId strings, 'contact', CronTriggerEvent objects, or OwnerOpEntry objects. */
  private readonly pending: Array<string | CronTriggerEvent | OwnerOpEntry> = [];
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

  /**
   * Enqueue an owner-initiated operation. Returns a promise that resolves/rejects
   * when the session loop processes the op.
   */
  enqueueOwnerOp(opType: OwnerOpType): Promise<OwnerOpResult> {
    if (this.closed) {
      return Promise.reject(new Error('Queue is closed'));
    }
    const existing = this.getPendingOwnerOp(opType);
    if (existing) {
      return existing;
    }
    let resolve!: (result: OwnerOpResult) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<OwnerOpResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: OwnerOpEntry = { kind: 'owner_op', opType, resolve, reject, promise };
    this.pending.push(entry);
    this.wake();
    return promise;
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
      if (isOwnerOpEntry(key)) {
        yield { type: 'owner_op', opType: key.opType, resolve: key.resolve, reject: key.reject };
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

  /** Get the promise of a pending owner op of the given type, if one exists. */
  getPendingOwnerOp(opType: OwnerOpType): Promise<OwnerOpResult> | undefined {
    const entry = this.pending.find((e) => isOwnerOpEntry(e) && e.opType === opType) as OwnerOpEntry | undefined;
    return entry?.promise;
  }

  /**
   * Reset the queue — clears all pending events and rejects pending owner op promises.
   * Does NOT close the queue; the session loop continues waiting for new events.
   */
  reset(): void {
    // Reject all pending owner ops
    for (const entry of this.pending) {
      if (isOwnerOpEntry(entry)) {
        entry.reject(new Error('Operation cancelled'));
      }
    }
    this.pending.length = 0;
    this.messageBatches.clear();
    this.contactEvents = [];
  }

  /** Close the queue — clears pending events and terminates the events() generator. */
  close(): void {
    this.closed = true;
    // Reject pending owner ops before clearing
    for (const entry of this.pending) {
      if (isOwnerOpEntry(entry)) {
        entry.reject(new Error('Queue closed'));
      }
    }
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

/** Internal entry type for owner ops in the pending array. */
interface OwnerOpEntry {
  readonly kind: 'owner_op';
  readonly opType: OwnerOpType;
  readonly resolve: (result: OwnerOpResult) => void;
  readonly reject: (err: Error) => void;
  readonly promise: Promise<OwnerOpResult>;
}

function isOwnerOpEntry(value: unknown): value is OwnerOpEntry {
  return (
    typeof value === 'object' && value !== null && 'kind' in value && (value as { kind: unknown }).kind === 'owner_op'
  );
}
