import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, setLogLevel } from '../../src/core/logger';

describe('Logger', () => {
  beforeEach(() => {
    setLogLevel('debug');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs at all levels with correct format', () => {
    const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const log = new Logger('test-tag');
    log.debug('d', 1);
    log.info('i', 2);
    log.warn('w', 3);
    log.error('e', 4);

    expect(spyDebug).toHaveBeenCalledTimes(1);
    expect(spyInfo).toHaveBeenCalledTimes(1);
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(spyError).toHaveBeenCalledTimes(1);

    // Check prefix format: timestamp [LEVEL] [tag]
    const debugCall = spyDebug.mock.calls[0];
    expect(debugCall[0]).toMatch(/^\d{4}-.*\[DEBUG\] \[test-tag\]$/);
    expect(debugCall[1]).toBe('d');
    expect(debugCall[2]).toBe(1);
  });

  it('respects log level filtering', () => {
    const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});

    setLogLevel('warn');
    const log = new Logger('test');

    log.debug('should not appear');
    log.info('should not appear');
    log.warn('should appear');
    log.error('should appear');

    expect(spyDebug).not.toHaveBeenCalled();
    expect(spyInfo).not.toHaveBeenCalled();
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(spyError).toHaveBeenCalledTimes(1);
  });

  it('error level only logs errors', () => {
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});

    setLogLevel('error');
    const log = new Logger('test');

    log.warn('nope');
    log.error('yes');

    expect(spyWarn).not.toHaveBeenCalled();
    expect(spyError).toHaveBeenCalledTimes(1);
  });
});
