/**
 * Mock utilities for eval scenarios.
 *
 * Provides:
 * - Deterministic UUID helpers for predictable conversationIds
 * - ToolInterceptor: captures MCP tool calls for assertion
 * - MockMemoryStore: in-memory memory store that records operations
 */
import { createHash } from 'crypto';
import type { ToolCallRecord } from './types.js';

// ---------------------------------------------------------------------------
// Deterministic UUID helper — derives a UUID v4-shaped ID from a stable key.
// Scenario authors use the same function to predict conversationIds.
// ---------------------------------------------------------------------------

/** Generate a deterministic UUID from a key string. Exported for use in scenario fixtures. */
export function deterministicUuid(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash.charAt(16), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

/** Deterministic conversationId for a DM with a given username. */
export function dmConversationId(username: string): string {
  return deterministicUuid(`dm:${username}`);
}

/** Deterministic conversationId for a work session with a given name. */
export function workSessionConversationId(name: string): string {
  return deterministicUuid(`work_session:${name}`);
}

/** Deterministic conversationId for a group with a given name. */
export function groupConversationId(name: string): string {
  return deterministicUuid(`group:${name}`);
}

// ---------------------------------------------------------------------------
// ToolInterceptor — captures tool calls for assertions
// ---------------------------------------------------------------------------

export class ToolInterceptor {
  private readonly calls: ToolCallRecord[] = [];
  private currentEventIndex: number | undefined;

  setEventIndex(index: number | undefined): void {
    this.currentEventIndex = index;
  }

  record(tool: string, args: Record<string, unknown>, result?: unknown): void {
    this.calls.push({ tool, args, timestamp: Date.now(), eventIndex: this.currentEventIndex, result });
  }

  getAll(): readonly ToolCallRecord[] {
    return this.calls;
  }

  getSince(startIndex: number): readonly ToolCallRecord[] {
    return this.calls.slice(startIndex);
  }

  get count(): number {
    return this.calls.length;
  }

  clear(): void {
    this.calls.length = 0;
  }
}

// ---------------------------------------------------------------------------
// MockMemoryStore — records memory operations for assertions
// ---------------------------------------------------------------------------

export interface MemoryOperation {
  readonly op: 'add' | 'update' | 'delete' | 'update_summary' | 'get';
  readonly scope: 'global' | 'user' | 'conversation';
  readonly scopeId?: string;
  readonly factId?: string;
  readonly text?: string;
  readonly timestamp: number;
}

export class MockMemoryStore {
  private readonly operations: MemoryOperation[] = [];
  private readonly facts = new Map<string, { text: string; scope: string; scopeId: string }>();
  private readonly summaries = new Map<string, string>();
  private nextFactId = 1;

  recordGet(scope: 'global' | 'user' | 'conversation', scopeId?: string): void {
    this.operations.push({ op: 'get', scope, scopeId, timestamp: Date.now() });
  }

  recordAdd(text: string, scope: 'global' | 'user' | 'conversation', scopeId?: string): string {
    const factId = `fact_${this.nextFactId++}`;
    this.facts.set(factId, { text, scope, scopeId: scopeId ?? '_' });
    this.operations.push({ op: 'add', scope, scopeId, text, timestamp: Date.now() });
    return factId;
  }

  recordUpdate(factId: string, text: string, scope: 'global' | 'user' | 'conversation', scopeId?: string): void {
    const existing = this.facts.get(factId);
    if (existing) {
      this.facts.set(factId, { ...existing, text });
    }
    this.operations.push({ op: 'update', scope, scopeId, factId, text, timestamp: Date.now() });
  }

  recordDelete(factId: string, scope: 'global' | 'user' | 'conversation', scopeId?: string): void {
    this.facts.delete(factId);
    this.operations.push({ op: 'delete', scope, scopeId, factId, timestamp: Date.now() });
  }

  recordUpdateSummary(text: string, scope: 'global' | 'user' | 'conversation', scopeId?: string): void {
    const key = `${scope}:${scopeId ?? '_'}`;
    this.summaries.set(key, text);
    this.operations.push({ op: 'update_summary', scope, scopeId, text, timestamp: Date.now() });
  }

  getOperations(): readonly MemoryOperation[] {
    return this.operations;
  }

  getOperationsByType(op: MemoryOperation['op']): readonly MemoryOperation[] {
    return this.operations.filter((o) => o.op === op);
  }

  clear(): void {
    this.operations.length = 0;
    this.facts.clear();
    this.summaries.clear();
  }
}
