import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PendingActions, ActionTimeoutError, ActionAbortedError } from '../src/app/pending-actions.js';

describe('PendingActions', () => {
  let pa: PendingActions;

  beforeEach(() => {
    vi.useFakeTimers();
    pa = new PendingActions();
  });

  afterEach(() => {
    pa.dispose();
    vi.useRealTimers();
  });

  it('resolves when a matching response arrives', async () => {
    const promise = pa.create('req-1', 5000);
    const resolved = pa.resolve({ requestId: 'req-1', selectedOptionId: 'approve' });

    expect(resolved).toBe(true);
    await expect(promise).resolves.toEqual({ requestId: 'req-1', selectedOptionId: 'approve' });
  });

  it('returns false when resolving an unknown requestId', () => {
    expect(pa.resolve({ requestId: 'unknown', selectedOptionId: 'x' })).toBe(false);
  });

  it('rejects with ActionTimeoutError after timeout', async () => {
    const promise = pa.create('req-2', 1000);
    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow(ActionTimeoutError);
    await expect(promise).rejects.toMatchObject({ requestId: 'req-2' });
  });

  it('does not resolve after timeout', async () => {
    const promise = pa.create('req-3', 100);
    vi.advanceTimersByTime(101);
    await expect(promise).rejects.toThrow(ActionTimeoutError);

    // Resolving after timeout should return false (already cleaned up)
    expect(pa.resolve({ requestId: 'req-3', selectedOptionId: 'x' })).toBe(false);
  });

  it('dispose rejects all pending with ActionAbortedError', async () => {
    const p1 = pa.create('req-a', 10000);
    const p2 = pa.create('req-b', 10000);

    pa.dispose();

    await expect(p1).rejects.toThrow(ActionAbortedError);
    await expect(p1).rejects.toMatchObject({ requestId: 'req-a' });
    await expect(p2).rejects.toThrow(ActionAbortedError);
  });

  it('handles multiple concurrent requests independently', async () => {
    const p1 = pa.create('r1', 5000);
    const p2 = pa.create('r2', 5000);

    pa.resolve({ requestId: 'r2', selectedOptionId: 'opt-b' });
    await expect(p2).resolves.toEqual({ requestId: 'r2', selectedOptionId: 'opt-b' });

    pa.resolve({ requestId: 'r1', selectedOptionId: 'opt-a' });
    await expect(p1).resolves.toEqual({ requestId: 'r1', selectedOptionId: 'opt-a' });
  });
});
