/**
 * JSON-file-backed CronStore implementation.
 *
 * The default, dependency-free CronStore — no native module, no prebuilds, no
 * ABI drift. Suitable because the dataset is tiny (a handful of cron jobs per
 * agent) and all access is synchronous.
 *
 * On-disk shape keys on cronId (the primary key):
 *   { "version": 1, "crons": { "<cronId>": { agentId, expression, label, payload? } } }
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can't corrupt
 * the store.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { dirname, basename, join } from 'path';
import { getLogger } from '@newio/agent-sdk';
import type { CronStore, CronJobRow } from './cron-store';

const log = getLogger('json-cron-store');

const STORE_VERSION = 1;

/** A stored cron entry: the public row plus its owning agent. */
interface StoredCron {
  readonly agentId: string;
  readonly expression: string;
  readonly label: string;
  readonly payload?: unknown;
}

interface CronFile {
  readonly version: number;
  readonly crons: Record<string, StoredCron>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Validate and narrow a single parsed entry; returns undefined if malformed. */
function parseStoredCron(value: unknown): StoredCron | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { agentId, expression, label, payload } = value;
  if (typeof agentId !== 'string' || typeof expression !== 'string' || typeof label !== 'string') {
    return undefined;
  }
  return { agentId, expression, label, ...(payload === undefined ? {} : { payload }) };
}

export class JsonCronStore implements CronStore {
  private readonly filePath: string;
  /** cronId → entry. Mirrors the SQLite primary-key layout. */
  private readonly crons = new Map<string, StoredCron>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
    log.info(`Opened cron store: ${filePath} (${this.crons.size} jobs)`);
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      log.warn(`Failed to read cron store, starting empty: ${this.filePath}`, err);
      return;
    }
    if (!isRecord(parsed) || !isRecord(parsed.crons)) {
      log.warn(`Cron store has unexpected shape, starting empty: ${this.filePath}`);
      return;
    }
    for (const [cronId, raw] of Object.entries(parsed.crons)) {
      const entry = parseStoredCron(raw);
      if (entry) {
        this.crons.set(cronId, entry);
      } else {
        log.warn(`Skipping malformed cron entry: ${cronId}`);
      }
    }
  }

  /** Atomically persist the current in-memory state. */
  private persist(): void {
    const data: CronFile = { version: STORE_VERSION, crons: Object.fromEntries(this.crons) };
    const tmpPath = join(dirname(this.filePath), `.${basename(this.filePath)}.${process.pid}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmpPath, this.filePath);
  }

  saveCron(agentId: string, def: CronJobRow): void {
    this.crons.set(def.cronId, {
      agentId,
      expression: def.expression,
      label: def.label,
      ...(def.payload === undefined ? {} : { payload: def.payload }),
    });
    this.persist();
  }

  deleteCron(cronId: string): void {
    if (this.crons.delete(cronId)) {
      this.persist();
    }
  }

  listCrons(agentId: string): CronJobRow[] {
    const result: CronJobRow[] = [];
    let mutated = false;
    for (const [cronId, entry] of this.crons) {
      if (entry.agentId !== agentId) {
        continue;
      }
      // Skip (and prune) expired one-shot "at <time>" jobs.
      if (/^at\s+/i.test(entry.expression)) {
        const triggerTime = new Date(entry.expression.replace(/^at\s+/i, '').trim()).getTime();
        if (!isNaN(triggerTime) && triggerTime <= Date.now()) {
          this.crons.delete(cronId);
          mutated = true;
          continue;
        }
      }
      result.push({
        cronId,
        expression: entry.expression,
        label: entry.label,
        ...(entry.payload === undefined ? {} : { payload: entry.payload }),
      });
    }
    if (mutated) {
      this.persist();
    }
    return result;
  }

  close(): void {
    // Nothing to flush — every mutation persists eagerly.
    log.info('Cron store closed');
  }
}
