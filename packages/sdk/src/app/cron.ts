/**
 * CronScheduler — manages recurring and one-shot cron jobs.
 *
 * Extracted from NewioApp for testability. Owns timer lifecycle,
 * expression parsing, and event emission.
 */
import { NewioError } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import type { CronJobDef, CronTriggerEvent } from './types.js';

const log = getLogger('cron');

/** Callbacks for cron lifecycle events. */
export interface CronEventHandlers {
  readonly onTriggered: (event: CronTriggerEvent) => void;
  readonly onScheduled: (def: CronJobDef) => void;
  readonly onCancelled: (cronId: string) => void;
}

interface CronEntry {
  readonly def: CronJobDef;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly isInterval: boolean;
}

export class CronScheduler {
  private readonly jobs = new Map<string, CronEntry>();
  private readonly handlers: CronEventHandlers;

  constructor(handlers: CronEventHandlers) {
    this.handlers = handlers;
  }

  /** Schedule a cron job. Replaces any existing job with the same cronId. */
  schedule(def: CronJobDef): void {
    if (this.jobs.has(def.cronId)) {
      log.warn(`Cron job ${def.cronId} already exists — replacing.`);
      this.cancel(def.cronId);
    }

    const parsed = parseCronExpression(def.expression);

    const fire = (): void => {
      const event: CronTriggerEvent = {
        cronId: def.cronId,
        newioSessionId: def.newioSessionId,
        label: def.label,
        payload: def.payload,
        triggeredAt: new Date().toISOString(),
      };
      log.debug(`Cron triggered: ${def.cronId} — ${def.label}`);
      this.handlers.onTriggered(event);
    };

    if (parsed.type === 'once') {
      const delayMs = parsed.triggerTime - Date.now();
      if (delayMs <= 0) {
        log.warn(`Cron ${def.cronId} trigger time is in the past — skipping.`);
        return;
      }
      log.info(
        `Scheduling one-shot cron ${def.cronId}: "${def.label}" at ${new Date(parsed.triggerTime).toISOString()} (${String(Math.round(delayMs / 1000))}s from now)`,
      );
      const timer = setTimeout(() => {
        fire();
        this.cancel(def.cronId);
      }, delayMs);
      this.jobs.set(def.cronId, { def, timer, isInterval: false });
    } else {
      log.info(`Scheduling recurring cron ${def.cronId}: "${def.label}" every ${String(parsed.intervalMs)}ms`);
      const timer = setInterval(fire, parsed.intervalMs);
      this.jobs.set(def.cronId, { def, timer, isInterval: true });
    }

    this.handlers.onScheduled(def);
  }

  /** Cancel a scheduled cron job. */
  cancel(cronId: string): void {
    const entry = this.jobs.get(cronId);
    if (entry) {
      if (entry.isInterval) {
        clearInterval(entry.timer);
      } else {
        clearTimeout(entry.timer);
      }
      this.jobs.delete(cronId);
      log.info(`Cron cancelled: ${cronId}`);
      this.handlers.onCancelled(cronId);
    }
  }

  /** List all active cron jobs. */
  list(): readonly CronJobDef[] {
    return [...this.jobs.values()].map((e) => e.def);
  }

  /** Cancel all jobs. Call on shutdown. */
  dispose(): void {
    for (const entry of this.jobs.values()) {
      if (entry.isInterval) {
        clearInterval(entry.timer);
      } else {
        clearTimeout(entry.timer);
      }
    }
    this.jobs.clear();
  }
}

// ---------------------------------------------------------------------------
// Cron expression parser
// ---------------------------------------------------------------------------

interface ParsedCronRecurring {
  readonly type: 'recurring';
  readonly intervalMs: number;
}

interface ParsedCronOnce {
  readonly type: 'once';
  readonly triggerTime: number;
}

type ParsedCron = ParsedCronRecurring | ParsedCronOnce;

/**
 * Parse a cron expression into a typed result.
 *
 * Supported formats:
 *
 * **Recurring** — `"every <N>s|m|h"` or `"<N>s|m|h"`
 *   e.g. `"every 30m"`, `"every 4h"`, `"90s"`
 *
 * **One-shot (ISO-8601)** — `"at <ISO-8601 datetime>"`
 *   e.g. `"at 2026-04-09T12:00:00Z"`, `"at 2026-04-10T10:00:00-04:00"`
 */
export function parseCronExpression(expression: string): ParsedCron {
  const trimmed = expression.trim();

  if (/^at\s+/i.test(trimmed)) {
    const after = trimmed.replace(/^at\s+/i, '').trim();
    const date = new Date(after);
    if (isNaN(date.getTime())) {
      throw new NewioError(
        `Invalid ISO-8601 datetime: "${after}". Example: "at 2026-04-09T12:00:00Z" or "at 2026-04-10T10:00:00-04:00".`,
      );
    }
    return { type: 'once', triggerTime: date.getTime() };
  }

  const cleaned = trimmed.replace(/^every\s+/i, '').trim();
  const match = /^(\d+)\s*(s|m|h)$/i.exec(cleaned);
  if (!match) {
    throw new NewioError(
      `Invalid cron expression: "${expression}". ` +
        'Use "every <N>s|m|h" for recurring, or "at <ISO-8601>" for one-shot. ' +
        'Examples: "every 30m", "at 2026-04-09T12:00:00Z".',
    );
  }
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
  const ms = multipliers[unit ?? ''];
  if (!ms) {
    throw new NewioError(`Unknown time unit: "${String(unit)}"`);
  }
  return { type: 'recurring', intervalMs: value * ms };
}
