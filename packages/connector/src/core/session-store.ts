/**
 * SessionStore — SQLite-backed mapping between Newio session IDs and
 * agent-platform-specific correlation IDs.
 *
 * One database for the entire app. The `newioSessionId` is globally unique
 * (currently the conversationId, will become a real session ID when the
 * backend adds session support).
 */
import Database from 'better-sqlite3';
import { Logger } from './logger';

const log = new Logger('session-store');

/** Shape of a persisted cron job (matches CronJobDef minus the agentId). */
export interface CronJobRow {
  readonly cronId: string;
  readonly expression: string;
  readonly newioSessionId: string;
  readonly label: string;
  readonly payload?: unknown;
  readonly type?: 'recurring' | 'once';
  readonly triggerAt?: string;
}

export class SessionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_mapping (
        newioSessionId TEXT PRIMARY KEY,
        correlationId TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        cronId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        expression TEXT NOT NULL,
        newioSessionId TEXT NOT NULL,
        label TEXT NOT NULL,
        payload TEXT,
        type TEXT,
        triggerAt TEXT
      )
    `);
    log.info(`Opened session store: ${dbPath}`);

    // Migrate: add columns if missing (for existing databases)
    this.migrateAddColumn('cron_jobs', 'type', 'TEXT');
    this.migrateAddColumn('cron_jobs', 'triggerAt', 'TEXT');
  }

  /** Add a column to a table if it doesn't already exist. */
  private migrateAddColumn(table: string, column: string, type: string): void {
    const cols = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  /** Get the correlation ID for a Newio session. */
  get(newioSessionId: string): string | undefined {
    const row = this.db
      .prepare('SELECT correlationId FROM session_mapping WHERE newioSessionId = ?')
      .get(newioSessionId) as { correlationId: string } | undefined;
    return row?.correlationId;
  }

  /** Store a mapping. */
  set(newioSessionId: string, correlationId: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO session_mapping (newioSessionId, correlationId) VALUES (?, ?)')
      .run(newioSessionId, correlationId);
  }

  /** Remove a mapping. */
  delete(newioSessionId: string): void {
    this.db.prepare('DELETE FROM session_mapping WHERE newioSessionId = ?').run(newioSessionId);
  }

  // ---------------------------------------------------------------------------
  // Cron jobs
  // ---------------------------------------------------------------------------

  /** Persist a cron job definition. */
  saveCron(agentId: string, def: CronJobRow): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO cron_jobs (cronId, agentId, expression, newioSessionId, label, payload, type, triggerAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        def.cronId,
        agentId,
        def.expression,
        def.newioSessionId,
        def.label,
        def.payload ? JSON.stringify(def.payload) : null,
        def.type ?? null,
        def.triggerAt ?? null,
      );
  }

  /** Delete a persisted cron job. */
  deleteCron(cronId: string): void {
    this.db.prepare('DELETE FROM cron_jobs WHERE cronId = ?').run(cronId);
  }

  /** List all persisted cron jobs for an agent. Filters out expired one-shot jobs. */
  listCrons(agentId: string): CronJobRow[] {
    const rows = this.db
      .prepare(
        'SELECT cronId, expression, newioSessionId, label, payload, type, triggerAt FROM cron_jobs WHERE agentId = ?',
      )
      .all(agentId) as Array<{
      cronId: string;
      expression: string;
      newioSessionId: string;
      label: string;
      payload: string | null;
      type: string | null;
      triggerAt: string | null;
    }>;
    const result: CronJobRow[] = [];
    for (const r of rows) {
      // Skip expired one-shot jobs and clean them up
      if (r.type === 'once' && r.triggerAt && new Date(r.triggerAt).getTime() <= Date.now()) {
        this.deleteCron(r.cronId);
        continue;
      }
      result.push({
        cronId: r.cronId,
        expression: r.expression,
        newioSessionId: r.newioSessionId,
        label: r.label,
        ...(r.payload ? { payload: JSON.parse(r.payload) as unknown } : {}),
        ...(r.type ? { type: r.type as 'recurring' | 'once' } : {}),
        ...(r.triggerAt ? { triggerAt: r.triggerAt } : {}),
      });
    }
    return result;
  }

  /** Close the database. */
  close(): void {
    this.db.close();
    log.info('Session store closed');
  }
}
