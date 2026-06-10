import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { JsonSessionStore } from '../src/json-session-store';
import { sessionStoreKey } from '../src/session-store';

const path = (): string => join(tmpdir(), `sessions-${randomUUID()}.json`);

describe('JsonSessionStore', () => {
  it('sets, gets, and deletes; persists across instances', () => {
    const p = path();
    const s = new JsonSessionStore(p);
    const k1 = sessionStoreKey('conversation', 'conv-a');
    const k2 = sessionStoreKey('contact', '__contact__');
    s.set(k1, 'corr-a', '1.0.0');
    s.set(k2, 'corr-c', '1.0.0');

    expect(s.get(k1)).toEqual({ correlationId: 'corr-a', promptFormatterVersion: '1.0.0' });
    expect(s.get(k2)?.correlationId).toBe('corr-c');
    expect(s.get('missing')).toBeUndefined();
    expect(existsSync(p)).toBe(true);

    // Reload from disk in a fresh instance.
    const s2 = new JsonSessionStore(p);
    expect(s2.get(k1)).toEqual({ correlationId: 'corr-a', promptFormatterVersion: '1.0.0' });

    s2.delete(k1);
    expect(s2.get(k1)).toBeUndefined();
    expect(new JsonSessionStore(p).get(k1)).toBeUndefined();
  });

  it('overwrites an existing mapping (e.g. rotation)', () => {
    const p = path();
    const s = new JsonSessionStore(p);
    const k = sessionStoreKey('conversation', 'conv-a');
    s.set(k, 'corr-old', '1.0.0');
    s.set(k, 'corr-new', '1.0.0');
    expect(s.get(k)?.correlationId).toBe('corr-new');
    const onDisk: unknown = JSON.parse(readFileSync(p, 'utf8'));
    expect(
      (onDisk as { sessions: Record<string, { correlationId: string } | undefined> }).sessions[k]?.correlationId,
    ).toBe('corr-new');
  });

  it('keys conversation/contact/cron independently', () => {
    const p = path();
    const s = new JsonSessionStore(p);
    s.set(sessionStoreKey('conversation', 'x'), 'c1', '1.0.0');
    s.set(sessionStoreKey('cron', 'x'), 'c2', '1.0.0');
    expect(s.get(sessionStoreKey('conversation', 'x'))?.correlationId).toBe('c1');
    expect(s.get(sessionStoreKey('cron', 'x'))?.correlationId).toBe('c2');
  });

  it('survives a corrupt file by starting empty', () => {
    const p = path();
    writeFileSync(p, '{ not json');
    const s = new JsonSessionStore(p);
    expect(s.get(sessionStoreKey('conversation', 'a'))).toBeUndefined();
  });

  it('skips malformed entries on load', () => {
    const p = path();
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        sessions: { good: { correlationId: 'ok', promptFormatterVersion: '1.0.0' }, bad: { correlationId: 42 } },
      }),
    );
    const s = new JsonSessionStore(p);
    expect(s.get('good')?.correlationId).toBe('ok');
    expect(s.get('bad')).toBeUndefined();
  });
});
