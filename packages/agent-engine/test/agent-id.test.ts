import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { isSafeAgentId, assertSafeAgentId } from '../src/agent-id';

describe('agent id validation', () => {
  it('accepts generated UUIDs', () => {
    for (let i = 0; i < 20; i++) {
      expect(isSafeAgentId(randomUUID())).toBe(true);
    }
  });

  it('accepts plain identifiers', () => {
    expect(isSafeAgentId('agent-1')).toBe(true);
    expect(isSafeAgentId('Agent_2')).toBe(true);
  });

  it('rejects path traversal and separators', () => {
    for (const bad of ['..', '.', '../..', 'a/b', 'a\\b', '/etc', '', ' ', 'a.b', 'a/../b', 'x\0y']) {
      expect(isSafeAgentId(bad)).toBe(false);
      expect(() => assertSafeAgentId(bad)).toThrow(/Invalid agent id/);
    }
  });
});
