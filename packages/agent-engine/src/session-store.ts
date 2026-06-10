/**
 * SessionStore — persistence interface for the mapping between a logical session
 * key (`sessionType/externalReferenceId`) and the agent-platform correlationId
 * (e.g. ACP sessionId) of the session that last served it.
 *
 * The engine uses this to RESUME an existing agent session (via `session/load`)
 * instead of always creating a fresh one. The mapping survives idle teardown and
 * connector restarts, so the agent's own in-context history is recovered on the
 * next event for that key.
 */
import type { SessionType } from './types';

/** A persisted session mapping value. */
export interface StoredSession {
  /** Agent-platform session id (ACP sessionId) to load on resume. */
  readonly correlationId: string;
  /**
   * Prompt-formatter version the session was created with. Resume is skipped
   * (fresh session created) if this is no longer compatible.
   */
  readonly promptFormatterVersion: string;
}

/** Storage interface for session correlationId persistence. */
export interface SessionStore {
  /** Look up the stored session for a key, or undefined if none. */
  get(key: string): StoredSession | undefined;
  /** Persist (or overwrite) the session mapping for a key. */
  set(key: string, correlationId: string, promptFormatterVersion: string): void;
  /** Remove the mapping for a key. */
  delete(key: string): void;
  /** Close the store and release resources. */
  close(): void;
}

/** Build the canonical store key for a session. */
export function sessionStoreKey(type: SessionType, externalReferenceId: string): string {
  return `${type}:${externalReferenceId}`;
}
