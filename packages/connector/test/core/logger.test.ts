import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, setLogLevel } from '@newio/core';

describe('Logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setLogLevel('debug');
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('logs at all levels with tag prefix', () => {
    const logger = new Logger('test-tag');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('[DEBUG] [test-tag] d'))).toBe(true);
    expect(calls.some((s) => s.includes('[INFO] [test-tag] i'))).toBe(true);
    expect(calls.some((s) => s.includes('[WARN] [test-tag] w'))).toBe(true);
    expect(calls.some((s) => s.includes('[ERROR] [test-tag] e'))).toBe(true);
  });

  it('respects log level filtering', () => {
    setLogLevel('warn');
    const logger = new Logger('test');

    logger.debug('should not appear');
    logger.info('should not appear');
    logger.warn('should appear');
    logger.error('should appear');

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('should not appear'))).toBe(false);
    expect(calls.filter((s) => s.includes('should appear'))).toHaveLength(2);
  });

  it('error level only logs errors', () => {
    setLogLevel('error');
    const logger = new Logger('test');

    logger.warn('nope');
    logger.error('yes');

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('nope'))).toBe(false);
    expect(calls.some((s) => s.includes('yes'))).toBe(true);
  });
});
