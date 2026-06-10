import { describe, it, expect, vi } from 'vitest';
import { withTimeout, TimeoutError } from '../src/utils';

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'label')).resolves.toBe('ok');
  });

  it('propagates the original rejection when the promise rejects in time', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'label')).rejects.toThrow('boom');
  });

  it('rejects with TimeoutError when the promise never settles', async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<never>(() => {
        /* never settles — models a dead ACP child that will never respond */
      });
      const result = withTimeout(pending, 3000, 'session/close');
      const assertion = expect(result).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(3000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
