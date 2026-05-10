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
import { SessionType } from './types';

const log = new Logger('acp-session-context-window-handler');

const MIN_INTERVAL_MS = 5_000;
const MIN_PERCENTAGE_CHANGE = 1;
const CONTEXT_PRESSURE_THRESHOLD = 80;

export interface ContextWindow {
  readonly size: number;
  readonly used: number;
}

export class AcpSessionContextWindowHandler {
  private size = 0;
  private used = 0;
  private lastNotifiedPercentage = -1;
  private lastNotifiedAt = 0;
  private pressureFired = false;
  private onPressureCallback?: () => void;

  constructor(
    private readonly sessionType: SessionType,
    private readonly externalReferenceId: string,
    private readonly ownerId: string,
    private readonly client: NewioClient,
  ) {}

  /** Register a one-shot callback that fires when context usage crosses the pressure threshold. */
  onContextPressure(cb: () => void): void {
    this.onPressureCallback = cb;
  }

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
    log.debug(
      `[${this.sessionType}/${this.externalReferenceId}] Context window update: size=${update.size}, used=${update.used}`,
    );
    this.size = update.size;
    this.used = update.used;
    this.maybeSendNotification();
    return true;
  }

  /** Handle a vendor-specific ext notification (e.g. kiro-cli metadata). */
  handleExtNotification(method: string, params: Record<string, unknown>): void {
    if (method === '_kiro.dev/metadata') {
      const percentage = params.contextUsagePercentage;
      if (typeof percentage === 'number') {
        log.debug(`[${this.sessionType}/${this.externalReferenceId}] Ext context usage: ${percentage}%`);
        this.size = 100;
        this.used = percentage;
        this.maybeSendNotification();
      }
    }
  }

  private maybeSendNotification(): void {
    if (this.size === 0) {
      return;
    }

    const currentPercentage = Math.round((this.used / this.size) * 100);

    // Fire context pressure callback once when threshold is crossed
    if (!this.pressureFired && currentPercentage >= CONTEXT_PRESSURE_THRESHOLD && this.onPressureCallback) {
      this.pressureFired = true;
      log.info(
        `[${this.sessionType}/${this.externalReferenceId}] Context pressure threshold reached: ${currentPercentage}%`,
      );
      this.onPressureCallback();
    }

    const percentageChange = Math.abs(currentPercentage - this.lastNotifiedPercentage);
    const elapsed = Date.now() - this.lastNotifiedAt;

    if (percentageChange < MIN_PERCENTAGE_CHANGE || elapsed < MIN_INTERVAL_MS) {
      return;
    }

    this.lastNotifiedPercentage = currentPercentage;
    this.lastNotifiedAt = Date.now();

    log.debug(
      `[${this.sessionType}/${this.externalReferenceId}] Sending context window notification to owner: ${currentPercentage}% (size=${this.size}, used=${this.used})`,
    );

    this.client
      .sendSignal({
        targetUserId: this.ownerId,
        requestId: crypto.randomUUID(),
        intent: 'notification',
        type: 'context_window_update',
        payload: {
          sessionType: this.sessionType,
          externalReferenceId: this.externalReferenceId,
          contextWindowSize: this.size,
          contextWindowUsed: this.used,
        },
      })
      .catch((err: unknown) => {
        log.warn(`[${this.sessionType}/${this.externalReferenceId}] Failed to send context window notification`, err);
      });
  }
}
