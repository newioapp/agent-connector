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
    log.info(`Opened session store: ${dbPath}`);
  }

  /** Get the correlation ID for a Newio session. */
  get(newioSessionId: string): string | undefined {
    const row = this.db.prepare('SELECT correlationId FROM session_mapping WHERE newioSessionId = ?').get(newioSessionId) as
      | { correlationId: string }
      | undefined;
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

  /** Close the database. */
  close(): void {
    this.db.close();
    log.info('Session store closed');
  }
}
