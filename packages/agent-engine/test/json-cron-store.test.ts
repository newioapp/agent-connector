import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { JsonCronStore } from '../src/json-cron-store';

const path = (): string => join(tmpdir(), `cron-${randomUUID()}.json`);

describe('JsonCronStore', () => {
  it('saves, lists, and deletes; persists across instances', () => {
    const p = path();
    const s = new JsonCronStore(p);
    s.saveCron('agent-1', { cronId: 'c1', expression: '0 9 * * *', label: 'daily', payload: { x: 1 } });
    s.saveCron('agent-1', { cronId: 'c2', expression: '0 10 * * *', label: 'other' });
    s.saveCron('agent-2', { cronId: 'c3', expression: '0 11 * * *', label: 'theirs' });

    expect(
      s
        .listCrons('agent-1')
        .map((c) => c.cronId)
        .sort(),
    ).toEqual(['c1', 'c2']);
    expect(s.listCrons('agent-1').find((c) => c.cronId === 'c1')?.payload).toEqual({ x: 1 });
    expect(existsSync(p)).toBe(true);

    // Reload from disk in a fresh instance.
    const s2 = new JsonCronStore(p);
    expect(s2.listCrons('agent-2').map((c) => c.cronId)).toEqual(['c3']);

    s2.deleteCron('c3');
    expect(s2.listCrons('agent-2')).toEqual([]);
    expect(new JsonCronStore(p).listCrons('agent-2')).toEqual([]);
  });

  it('prunes expired one-shot jobs on list (memory and disk)', () => {
    const p = path();
    const s = new JsonCronStore(p);
    s.saveCron('a', { cronId: 'past', expression: 'at 2000-01-01T00:00:00Z', label: 'old' });
    s.saveCron('a', { cronId: 'future', expression: 'at 2999-01-01T00:00:00Z', label: 'new' });
    expect(s.listCrons('a').map((c) => c.cronId)).toEqual(['future']);
    const onDisk: unknown = JSON.parse(readFileSync(p, 'utf8'));
    expect((onDisk as { crons: Record<string, unknown> }).crons.past).toBeUndefined();
  });

  it('survives a corrupt file by starting empty', () => {
    const p = path();
    writeFileSync(p, '{ not json');
    const s = new JsonCronStore(p);
    expect(s.listCrons('a')).toEqual([]);
  });
});
