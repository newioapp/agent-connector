/**
 * ActivityThrottle — deduplicates and throttles activity status emissions
 * across multiple conversations.
 *
 * Raw status updates (typing, thinking, tool_calling) can fire dozens of
 * times per second during streaming. This class ensures:
 * - Status *changes* emit immediately.
 * - Duplicate statuses are suppressed within a throttle window.
 * - A heartbeat re-emits the current status periodically so the receiver's
 *   auto-expiry timer doesn't fire (desktop expires after 8s of silence).
 * - `idle` is always emitted immediately and cleans up state.
 */
import type { ActivityStatus } from './types';

/** Suppress duplicate emissions within this window. */
const THROTTLE_MS = 3_000;

/** Re-emit the current status at this interval to keep the receiver alive. */
const HEARTBEAT_MS = 5_000;

interface ConversationState {
  status: ActivityStatus;
  lastEmitAt: number;
  heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
}

export class ActivityThrottle {
  private readonly emit: (conversationId: string, status: ActivityStatus) => void;
  private readonly conversations = new Map<string, ConversationState>();

  constructor(emit: (conversationId: string, status: ActivityStatus) => void) {
    this.emit = emit;
  }

  /** Call on every raw status update. */
  update(conversationId: string, status: ActivityStatus): void {
    if (status === 'idle') {
      this.flush(conversationId);
      return;
    }

    const now = Date.now();
    let state = this.conversations.get(conversationId);

    if (!state) {
      state = { status: 'idle', lastEmitAt: 0, heartbeatTimer: undefined };
      this.conversations.set(conversationId, state);
    }

    const changed = status !== state.status;

    if (changed || now - state.lastEmitAt >= THROTTLE_MS) {
      state.status = status;
      state.lastEmitAt = now;
      this.emit(conversationId, status);
      this.scheduleHeartbeat(conversationId, state);
    }
  }

  /** Force emit idle for a conversation and clean up its state. */
  flush(conversationId: string): void {
    const state = this.conversations.get(conversationId);
    if (!state) {
      return;
    }
    this.clearHeartbeat(state);
    if (state.status !== 'idle') {
      this.emit(conversationId, 'idle');
    }
    this.conversations.delete(conversationId);
  }

  /** Clean up all timers. */
  dispose(): void {
    for (const state of this.conversations.values()) {
      this.clearHeartbeat(state);
    }
    this.conversations.clear();
  }

  private scheduleHeartbeat(conversationId: string, state: ConversationState): void {
    this.clearHeartbeat(state);
    state.heartbeatTimer = setTimeout(() => {
      if (state.status !== 'idle') {
        state.lastEmitAt = Date.now();
        this.emit(conversationId, state.status);
        this.scheduleHeartbeat(conversationId, state);
      }
    }, HEARTBEAT_MS);
  }

  private clearHeartbeat(state: ConversationState): void {
    if (state.heartbeatTimer !== undefined) {
      clearTimeout(state.heartbeatTimer);
      state.heartbeatTimer = undefined;
    }
  }
}
