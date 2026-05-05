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
}

export interface SessionMetadata {
  readonly correlationId: string;
  readonly promptFormatterVersion: string;
}

export class SessionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_mapping (
        newioSessionId TEXT PRIMARY KEY,
        correlationId TEXT NOT NULL,
        promptFormatterVersion TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        cronId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        expression TEXT NOT NULL,
        newioSessionId TEXT NOT NULL,
        label TEXT NOT NULL,
        payload TEXT
      )
    `);
    log.info(`Opened session store: ${dbPath}`);
  }

  /** Get the session metadata for a Newio session. */
  get(newioSessionId: string): SessionMetadata | undefined {
    const row = this.db
      .prepare('SELECT correlationId, promptFormatterVersion FROM session_mapping WHERE newioSessionId = ?')
      .get(newioSessionId) as { correlationId: string; promptFormatterVersion: string } | undefined;
    if (!row) {
      return undefined;
    }
    return { correlationId: row.correlationId, promptFormatterVersion: row.promptFormatterVersion };
  }

  /** Store a mapping. */
  set(newioSessionId: string, correlationId: string, promptFormatterVersion: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO session_mapping (newioSessionId, correlationId, promptFormatterVersion) VALUES (?, ?, ?)',
      )
      .run(newioSessionId, correlationId, promptFormatterVersion);
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
        'INSERT OR REPLACE INTO cron_jobs (cronId, agentId, expression, newioSessionId, label, payload) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        def.cronId,
        agentId,
        def.expression,
        def.newioSessionId,
        def.label,
        def.payload ? JSON.stringify(def.payload) : null,
      );
  }

  /** Delete a persisted cron job. */
  deleteCron(cronId: string): void {
    this.db.prepare('DELETE FROM cron_jobs WHERE cronId = ?').run(cronId);
  }

  /** List all persisted cron jobs for an agent. Skips expired one-shot jobs. */
  listCrons(agentId: string): CronJobRow[] {
    const rows = this.db
      .prepare('SELECT cronId, expression, newioSessionId, label, payload FROM cron_jobs WHERE agentId = ?')
      .all(agentId) as Array<{
      cronId: string;
      expression: string;
      newioSessionId: string;
      label: string;
      payload: string | null;
    }>;
    const result: CronJobRow[] = [];
    for (const r of rows) {
      // Skip expired one-shot jobs: parse the ISO-8601 time from the expression
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
        newioSessionId: r.newioSessionId,
        label: r.label,
        ...(r.payload ? { payload: JSON.parse(r.payload) as unknown } : {}),
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
