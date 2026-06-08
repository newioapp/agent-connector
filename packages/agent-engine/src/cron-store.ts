/**
 * CronStore — persistence interface for cron job definitions.
 *
 * The engine uses this to persist and restore scheduled cron jobs across restarts.
 * Consumers (CLI, Electron app) provide their own implementation backed by
 * their preferred storage (e.g. better-sqlite3, node:sqlite, etc.).
 */

/** Shape of a persisted cron job. */
export interface CronJobRow {
  readonly cronId: string;
  readonly expression: string;
  readonly label: string;
  readonly payload?: unknown;
}

/** Storage interface for cron job persistence. */
export interface CronStore {
  /** Persist a cron job definition. */
  saveCron(agentId: string, def: CronJobRow): void;
  /** Delete a persisted cron job. */
  deleteCron(cronId: string): void;
  /** List all persisted cron jobs for an agent. */
  listCrons(agentId: string): CronJobRow[];
  /** Close the store and release resources. */
  close(): void;
}

/**
 * Builds a CronStore for a single agent. The runtime manager calls this when an
 * agent starts, so each agent gets a store scoped to its own directory
 * (`agents/<agentId>/cron.json`) — no shared file, hence no cross-agent write
 * contention, and removing an agent's directory takes its crons with it.
 */
export type CronStoreFactory = (agentId: string) => CronStore;
