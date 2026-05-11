/**
 * SQLite-backed CronStore implementation using better-sqlite3.
 */
import Database from 'better-sqlite3';
import type { CronStore, CronJobRow } from '@newio/agent-engine';
import { Logger } from '../shared/logger';

const log = new Logger('sqlite-cron-store');

export class SqliteCronStore implements CronStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        cronId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        expression TEXT NOT NULL,
        label TEXT NOT NULL,
        payload TEXT
      )
    `);
    log.info(`Opened cron store: ${dbPath}`);
  }

  saveCron(agentId: string, def: CronJobRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO cron_jobs (cronId, agentId, expression, label, payload) VALUES (?, ?, ?, ?, ?)')
      .run(def.cronId, agentId, def.expression, def.label, def.payload ? JSON.stringify(def.payload) : null);
  }

  deleteCron(cronId: string): void {
    this.db.prepare('DELETE FROM cron_jobs WHERE cronId = ?').run(cronId);
  }

  listCrons(agentId: string): CronJobRow[] {
    const rows = this.db
      .prepare('SELECT cronId, expression, label, payload FROM cron_jobs WHERE agentId = ?')
      .all(agentId) as Array<{ cronId: string; expression: string; label: string; payload: string | null }>;
    const result: CronJobRow[] = [];
    for (const r of rows) {
      // Skip expired one-shot jobs
      if (/^at\s+/i.test(r.expression)) {
        const after = r.expression.replace(/^at\s+/i, '').trim();
        const triggerTime = new Date(after).getTime();
        if (!isNaN(triggerTime) && triggerTime <= Date.now()) {
          this.deleteCron(r.cronId);
          continue;
        }
      }
      result.push({
        cronId: r.cronId,
        expression: r.expression,
        label: r.label,
        ...(r.payload ? { payload: JSON.parse(r.payload) as unknown } : {}),
      });
    }
    return result;
  }

  close(): void {
    this.db.close();
    log.info('Cron store closed');
  }
}
