import type { SessionStore, StoredSession } from '@newio/agent-engine';

/**
 * In-memory SessionStore for evals.
 *
 * Holds the session mapping only in memory for the lifetime of the run and never
 * writes it to disk. Each eval process therefore starts with an empty store, so
 * the agent always creates fresh ACP sessions instead of RESUMING a stale session
 * persisted by a previous run/process (a real connector resumes via `session/load`
 * keyed off a JSON file under dataDir — undesirable in a deterministic eval).
 *
 * Within-run injection-state tracking still works (it's kept in the Map); resume
 * never triggers in practice because eval runs don't hit idle teardown.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly entries = new Map<string, StoredSession>();

  get(key: string): StoredSession | undefined {
    return this.entries.get(key);
  }

  set(key: string, correlationId: string, promptFormatterVersion: string): void {
    this.entries.set(key, { correlationId, promptFormatterVersion });
  }

  setInjectionState(key: string, conversationIds: readonly string[], userIds: readonly string[]): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.set(key, {
        ...existing,
        injectedConversationIds: conversationIds,
        injectedUserIds: userIds,
      });
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  close(): void {
    this.entries.clear();
  }
}
