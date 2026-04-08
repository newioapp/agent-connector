/**
 * PendingActions — correlates action requests with their responses.
 *
 * When an agent sends an action message (e.g. permission request), it registers
 * a pending promise keyed by `requestId`. When a `message.new` event arrives
 * with `content.response`, the matching promise is resolved.
 *
 * Handles timeout: if no response arrives before the deadline, the promise
 * rejects with an ActionTimeoutError.
 */
import type { ActionResponse } from '../core/types.js';
import { getLogger } from '../core/logger.js';

const log = getLogger('pending-actions');

/** Error thrown when an action request times out without a response. */
export class ActionTimeoutError extends Error {
  constructor(readonly requestId: string) {
    super(`Action request ${requestId} timed out`);
    this.name = 'ActionTimeoutError';
  }
}

interface PendingEntry {
  readonly resolve: (response: ActionResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks in-flight action requests and resolves them when responses arrive.
 * Used by {@link NewioApp} and wired into WebSocket event handling.
 */
export class PendingActions {
  private readonly pending = new Map<string, PendingEntry>();

  /** Register a pending action request. Returns a promise that resolves on response or rejects on timeout. */
  create(requestId: string, timeoutMs: number): Promise<ActionResponse> {
    return new Promise<ActionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        log.warn(`Action request ${requestId} timed out after ${timeoutMs}ms`);
        reject(new ActionTimeoutError(requestId));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  /** Resolve a pending action request with the given response. Returns true if matched. */
  resolve(response: ActionResponse): boolean {
    const entry = this.pending.get(response.requestId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(response.requestId);
    log.info(`Action request ${response.requestId} resolved with option ${response.selectedOptionId}`);
    entry.resolve(response);
    return true;
  }

  /** Clean up all pending actions (e.g. on disconnect). */
  dispose(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Action request ${requestId} cancelled — app disposed`));
    }
    this.pending.clear();
  }
}
