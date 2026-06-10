/**
 * JSON-file-backed SessionStore implementation.
 *
 * The default, dependency-free SessionStore — no native module, no prebuilds.
 * The dataset is tiny (a handful of live session keys per agent) and all access
 * is synchronous.
 *
 * On-disk shape keys on the session key (`<type>:<externalReferenceId>`):
 *   { "version": 1, "sessions": { "conversation:<id>": { correlationId, promptFormatterVersion } } }
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can't corrupt
 * the store.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { dirname, basename, join } from 'path';
import { getLogger } from '@newio/agent-sdk';
import type { SessionStore, StoredSession } from './session-store';

const log = getLogger('json-session-store');

const STORE_VERSION = 1;

interface SessionFile {
  readonly version: number;
  readonly sessions: Record<string, StoredSession>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Narrow an unknown to a string[]; non-arrays and non-string entries are dropped. */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((v): v is string => typeof v === 'string');
}

/** Validate and narrow a single parsed entry; returns undefined if malformed. */
function parseStoredSession(value: unknown): StoredSession | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { correlationId, promptFormatterVersion } = value;
  if (typeof correlationId !== 'string' || typeof promptFormatterVersion !== 'string') {
    return undefined;
  }
  const injectedConversationIds = asStringArray(value.injectedConversationIds);
  const injectedUserIds = asStringArray(value.injectedUserIds);
  return {
    correlationId,
    promptFormatterVersion,
    ...(injectedConversationIds ? { injectedConversationIds } : {}),
    ...(injectedUserIds ? { injectedUserIds } : {}),
  };
}

export class JsonSessionStore implements SessionStore {
  private readonly filePath: string;
  /** session key → stored mapping. */
  private readonly sessions = new Map<string, StoredSession>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
    log.info(`Opened session store: ${filePath} (${this.sessions.size} sessions)`);
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      log.warn(`Failed to read session store, starting empty: ${this.filePath}`, err);
      return;
    }
    if (!isRecord(parsed) || !isRecord(parsed.sessions)) {
      log.warn(`Session store has unexpected shape, starting empty: ${this.filePath}`);
      return;
    }
    for (const [key, raw] of Object.entries(parsed.sessions)) {
      const entry = parseStoredSession(raw);
      if (entry) {
        this.sessions.set(key, entry);
      } else {
        log.warn(`Skipping malformed session entry: ${key}`);
      }
    }
  }

  /** Atomically persist the current in-memory state. */
  private persist(): void {
    const data: SessionFile = { version: STORE_VERSION, sessions: Object.fromEntries(this.sessions) };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.${basename(this.filePath)}.${process.pid}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmpPath, this.filePath);
  }

  get(key: string): StoredSession | undefined {
    return this.sessions.get(key);
  }

  set(key: string, correlationId: string, promptFormatterVersion: string): void {
    // A fresh mapping resets injection state — a new session has injected nothing.
    this.sessions.set(key, { correlationId, promptFormatterVersion });
    this.persist();
  }

  setInjectionState(key: string, conversationIds: readonly string[], userIds: readonly string[]): void {
    const existing = this.sessions.get(key);
    if (!existing) {
      return;
    }
    this.sessions.set(key, {
      correlationId: existing.correlationId,
      promptFormatterVersion: existing.promptFormatterVersion,
      injectedConversationIds: [...conversationIds],
      injectedUserIds: [...userIds],
    });
    this.persist();
  }

  delete(key: string): void {
    if (this.sessions.delete(key)) {
      this.persist();
    }
  }

  close(): void {
    // Nothing to flush — every mutation persists eagerly.
    log.info('Session store closed');
  }
}
