import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityThrottle } from '../src/core/activity-throttle.js';

describe('ActivityThrottle', () => {
  let emit: ReturnType<typeof vi.fn>;
  let throttle: ActivityThrottle;

  beforeEach(() => {
    vi.useFakeTimers();
    emit = vi.fn();
    throttle = new ActivityThrottle(emit);
  });

  afterEach(() => {
    throttle.dispose();
    vi.useRealTimers();
  });

  it('emits immediately on first status update', () => {
    throttle.update('conv-1', 'typing');
    expect(emit).toHaveBeenCalledWith('conv-1', 'typing');
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('suppresses duplicate status within throttle window', () => {
    throttle.update('conv-1', 'typing');
    throttle.update('conv-1', 'typing');
    throttle.update('conv-1', 'typing');
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('emits immediately on status change', () => {
    throttle.update('conv-1', 'typing');
    throttle.update('conv-1', 'thinking');
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('conv-1', 'thinking');
  });

  it('re-emits after throttle window expires', () => {
    throttle.update('conv-1', 'typing');
    vi.advanceTimersByTime(3000);
    throttle.update('conv-1', 'typing');
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('emits idle immediately and cleans up', () => {
    throttle.update('conv-1', 'typing');
    throttle.update('conv-1', 'idle');
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('conv-1', 'idle');
  });

  it('does not emit idle if already idle', () => {
    throttle.update('conv-1', 'idle');
    expect(emit).not.toHaveBeenCalled();
  });

  it('sends heartbeat after 5s of sustained status', () => {
    throttle.update('conv-1', 'thinking');
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('conv-1', 'thinking');
  });

  it('sends recurring heartbeats', () => {
    throttle.update('conv-1', 'typing');
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(5000);
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('stops heartbeat after idle', () => {
    throttle.update('conv-1', 'typing');
    throttle.update('conv-1', 'idle');
    vi.advanceTimersByTime(10000);
    expect(emit).toHaveBeenCalledTimes(2); // typing + idle, no heartbeat
  });

  it('flush emits idle and stops heartbeat', () => {
    throttle.update('conv-1', 'typing');
    throttle.flush('conv-1');
    expect(emit).toHaveBeenLastCalledWith('conv-1', 'idle');
    vi.advanceTimersByTime(10000);
    expect(emit).toHaveBeenCalledTimes(2); // typing + idle
  });

  it('flush is a no-op for unknown conversation', () => {
    throttle.flush('conv-unknown');
    expect(emit).not.toHaveBeenCalled();
  });

  it('tracks conversations independently', () => {
    throttle.update('conv-1', 'typing');
    throttle.update('conv-2', 'thinking');
    expect(emit).toHaveBeenCalledTimes(2);

    // Duplicate on conv-1 suppressed, but conv-2 status change emits
    throttle.update('conv-1', 'typing');
    throttle.update('conv-2', 'tool_calling');
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenLastCalledWith('conv-2', 'tool_calling');
  });

  it('dispose clears all heartbeat timers', () => {
    throttle.update('conv-1', 'typing');
    throttle.update('conv-2', 'thinking');
    throttle.dispose();
    vi.advanceTimersByTime(10000);
    expect(emit).toHaveBeenCalledTimes(2); // only the initial emits
  });
});
