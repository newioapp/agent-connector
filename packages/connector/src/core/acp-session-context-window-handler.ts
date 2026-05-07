/**
 * AcpSessionContextWindowHandler — tracks context window usage and sends
 * throttled notifications to the owner via signal protocol.
 *
 * Throttling: notifications are sent only when the percentage changes by ≥1%
 * AND at least 5 seconds have elapsed since the last notification.
 */
import type * as acp from '@agentclientprotocol/sdk';
import type { NewioClient } from '@newio/agent-sdk';
import { Logger } from './logger';

const log = new Logger('acp-session-context-window-handler');

const MIN_INTERVAL_MS = 5_000;
const MIN_PERCENTAGE_CHANGE = 1;

export interface ContextWindow {
  readonly size: number;
  readonly used: number;
}

export class AcpSessionContextWindowHandler {
  private size = 0;
  private used = 0;
  private lastNotifiedPercentage = -1;
  private lastNotifiedAt = 0;

  constructor(
    private readonly newioSessionId: string,
    private readonly ownerId: string,
    private readonly client: NewioClient,
  ) {}

  /** Get the current context window state. */
  getContextWindow(): ContextWindow | undefined {
    if (this.size === 0) {
      return undefined;
    }
    return { size: this.size, used: this.used };
  }

  /** Handle a usage_update session update from ACP. */
  handleSessionUpdate(update: acp.SessionUpdate): boolean {
    if (update.sessionUpdate !== 'usage_update') {
      return false;
    }
    const { size, used } = update as acp.SessionUpdate & { size: number; used: number };
    this.size = size;
    this.used = used;
    this.maybeSendNotification();
    return true;
  }

  private maybeSendNotification(): void {
    if (this.size === 0) {
      return;
    }

    const currentPercentage = Math.round((this.used / this.size) * 100);
    const percentageChange = Math.abs(currentPercentage - this.lastNotifiedPercentage);
    const elapsed = Date.now() - this.lastNotifiedAt;

    if (percentageChange < MIN_PERCENTAGE_CHANGE || elapsed < MIN_INTERVAL_MS) {
      return;
    }

    this.lastNotifiedPercentage = currentPercentage;
    this.lastNotifiedAt = Date.now();

    this.client
      .sendSignal({
        targetUserId: this.ownerId,
        requestId: crypto.randomUUID(),
        intent: 'notification',
        type: 'context_window_update',
        payload: {
          sessionId: this.newioSessionId,
          contextWindowSize: this.size,
          contextWindowUsed: this.used,
        },
      })
      .catch((err: unknown) => {
        log.warn(`[${this.newioSessionId}] Failed to send context window notification`, err);
      });
  }
}
