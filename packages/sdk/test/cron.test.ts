import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronScheduler, parseCronExpression } from '../src/app/cron.js';

describe('parseCronExpression', () => {
  it('parses "every 30s"', () => {
    const result = parseCronExpression('every 30s');
    expect(result).toEqual({ type: 'recurring', intervalMs: 30_000 });
  });

  it('parses "every 5m"', () => {
    const result = parseCronExpression('every 5m');
    expect(result).toEqual({ type: 'recurring', intervalMs: 300_000 });
  });

  it('parses "every 2h"', () => {
    const result = parseCronExpression('every 2h');
    expect(result).toEqual({ type: 'recurring', intervalMs: 7_200_000 });
  });

  it('parses shorthand "60s" without "every"', () => {
    const result = parseCronExpression('60s');
    expect(result).toEqual({ type: 'recurring', intervalMs: 60_000 });
  });

  it('parses "at <ISO-8601>"', () => {
    const result = parseCronExpression('at 2026-04-09T12:00:00Z');
    expect(result.type).toBe('once');
    if (result.type === 'once') {
      expect(result.triggerTime).toBe(new Date('2026-04-09T12:00:00Z').getTime());
    }
  });

  it('is case-insensitive', () => {
    expect(parseCronExpression('Every 10S')).toEqual({ type: 'recurring', intervalMs: 10_000 });
    expect(parseCronExpression('AT 2026-04-09T12:00:00Z').type).toBe('once');
  });

  it('trims whitespace', () => {
    expect(parseCronExpression('  every 5m  ')).toEqual({ type: 'recurring', intervalMs: 300_000 });
  });

  it('throws on invalid expression', () => {
    expect(() => parseCronExpression('invalid')).toThrow('Invalid cron expression');
  });

  it('throws on invalid ISO datetime', () => {
    expect(() => parseCronExpression('at not-a-date')).toThrow('Invalid ISO-8601 datetime');
  });

  it('throws on unsupported unit', () => {
    expect(() => parseCronExpression('every 5d')).toThrow('Invalid cron expression');
  });
});

describe('CronScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires recurring job on interval', async () => {
    const triggered: string[] = [];
    const scheduler = new CronScheduler({ onTriggered: (e) => triggered.push(e.cronId) });

    scheduler.schedule({ cronId: 'c1', expression: 'every 1s', newioSessionId: 's1', label: 'Test' });

    await vi.advanceTimersByTimeAsync(3100);
    expect(triggered).toEqual(['c1', 'c1', 'c1']);

    scheduler.dispose();
  });

  it('fires one-shot job and auto-cancels', async () => {
    const triggered: string[] = [];
    const scheduler = new CronScheduler({ onTriggered: (e) => triggered.push(e.cronId) });

    const future = new Date(Date.now() + 2000).toISOString();
    scheduler.schedule({ cronId: 'c1', expression: `at ${future}`, newioSessionId: 's1', label: 'Once' });

    await vi.advanceTimersByTimeAsync(2100);
    expect(triggered).toEqual(['c1']);
    expect(scheduler.list()).toHaveLength(0);

    scheduler.dispose();
  });

  it('skips one-shot with past trigger time', () => {
    const scheduler = new CronScheduler();
    const past = new Date(Date.now() - 1000).toISOString();
    scheduler.schedule({ cronId: 'c1', expression: `at ${past}`, newioSessionId: 's1', label: 'Past' });
    expect(scheduler.list()).toHaveLength(0);
    scheduler.dispose();
  });

  it('replaces existing job with same id', async () => {
    const triggered: string[] = [];
    const scheduler = new CronScheduler({ onTriggered: (e) => triggered.push(e.label ?? '') });

    scheduler.schedule({ cronId: 'c1', expression: 'every 1s', newioSessionId: 's1', label: 'First' });
    scheduler.schedule({ cronId: 'c1', expression: 'every 1s', newioSessionId: 's1', label: 'Second' });

    await vi.advanceTimersByTimeAsync(1100);
    expect(triggered).toEqual(['Second']);

    scheduler.dispose();
  });

  it('calls onScheduled callback', () => {
    const scheduled: string[] = [];
    const scheduler = new CronScheduler({ onScheduled: (def) => scheduled.push(def.cronId) });

    scheduler.schedule({ cronId: 'c1', expression: 'every 1s', newioSessionId: 's1', label: 'Test' });
    expect(scheduled).toEqual(['c1']);

    scheduler.dispose();
  });

  it('calls onCancelled callback', () => {
    const cancelled: string[] = [];
    const scheduler = new CronScheduler({ onCancelled: (id) => cancelled.push(id) });

    scheduler.schedule({ cronId: 'c1', expression: 'every 1s', newioSessionId: 's1', label: 'Test' });
    scheduler.cancel('c1');
    expect(cancelled).toEqual(['c1']);

    scheduler.dispose();
  });

  it('cancel is a no-op for unknown cronId', () => {
    const scheduler = new CronScheduler();
    scheduler.cancel('nonexistent'); // should not throw
    scheduler.dispose();
  });

  it('dispose cancels all jobs', async () => {
    const triggered: string[] = [];
    const scheduler = new CronScheduler({ onTriggered: (e) => triggered.push(e.cronId) });

    scheduler.schedule({ cronId: 'c1', expression: 'every 1s', newioSessionId: 's1', label: 'A' });
    scheduler.schedule({ cronId: 'c2', expression: 'every 1s', newioSessionId: 's1', label: 'B' });

    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(triggered).toHaveLength(0);
    expect(scheduler.list()).toHaveLength(0);
  });

  it('list returns all active jobs', () => {
    const scheduler = new CronScheduler();
    scheduler.schedule({ cronId: 'c1', expression: 'every 1s', newioSessionId: 's1', label: 'A' });
    scheduler.schedule({ cronId: 'c2', expression: 'every 2s', newioSessionId: 's1', label: 'B' });

    const jobs = scheduler.list();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.cronId).sort()).toEqual(['c1', 'c2']);

    scheduler.dispose();
  });

  it('includes payload and newioSessionId in triggered event', async () => {
    let event: unknown;
    const scheduler = new CronScheduler({
      onTriggered: (e) => {
        event = e;
      },
    });

    scheduler.schedule({
      cronId: 'c1',
      expression: 'every 1s',
      newioSessionId: 'session-42',
      label: 'With Payload',
      payload: { key: 'value' },
    });

    await vi.advanceTimersByTimeAsync(1100);
    expect(event).toEqual(
      expect.objectContaining({
        cronId: 'c1',
        newioSessionId: 'session-42',
        label: 'With Payload',
        payload: { key: 'value' },
        triggeredAt: expect.any(String),
      }),
    );

    scheduler.dispose();
  });
});
