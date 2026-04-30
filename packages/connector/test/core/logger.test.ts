import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron-log/main', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    transports: {
      file: { maxSize: 0, format: '', archiveLogFn: vi.fn() },
      console: { format: '' },
    },
  },
}));

import log from 'electron-log/main';
import { Logger, setLogLevel, initElectronLog } from '../../src/core/logger';

describe('Logger', () => {
  beforeEach(() => {
    setLogLevel('debug');
    vi.clearAllMocks();
  });

  it('logs at all levels with tag prefix', () => {
    const logger = new Logger('test-tag');
    logger.debug('d', 1);
    logger.info('i', 2);
    logger.warn('w', 3);
    logger.error('e', 4);

    expect(log.debug).toHaveBeenCalledWith('[test-tag] d', 1);
    expect(log.info).toHaveBeenCalledWith('[test-tag] i', 2);
    expect(log.warn).toHaveBeenCalledWith('[test-tag] w', 3);
    expect(log.error).toHaveBeenCalledWith('[test-tag] e', 4);
  });

  it('respects log level filtering', () => {
    setLogLevel('warn');
    const logger = new Logger('test');

    logger.debug('should not appear');
    logger.info('should not appear');
    logger.warn('should appear');
    logger.error('should appear');

    expect(log.debug).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('error level only logs errors', () => {
    setLogLevel('error');
    const logger = new Logger('test');

    logger.warn('nope');
    logger.error('yes');

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('initElectronLog configures file transport', () => {
    initElectronLog();
    expect(log.transports.file.maxSize).toBe(5 * 1024 * 1024);
    expect(log.transports.file.archiveLogFn).toBeTypeOf('function');
  });
});
