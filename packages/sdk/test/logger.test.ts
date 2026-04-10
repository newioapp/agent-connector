import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getLogger, setLogHandler, consoleLogHandler } from '../src/core/logger.js';

describe('logger', () => {
  beforeEach(() => {
    setLogHandler(undefined);
  });

  it('forwards calls to the global handler', () => {
    const handler = vi.fn();
    setLogHandler(handler);
    const log = getLogger('test');

    log.debug('d', 1);
    log.info('i', 2);
    log.warn('w', 3);
    log.error('e', 4);

    expect(handler).toHaveBeenCalledTimes(4);
    expect(handler).toHaveBeenCalledWith('debug', 'test', 'd', [1]);
    expect(handler).toHaveBeenCalledWith('info', 'test', 'i', [2]);
    expect(handler).toHaveBeenCalledWith('warn', 'test', 'w', [3]);
    expect(handler).toHaveBeenCalledWith('error', 'test', 'e', [4]);
  });

  it('does nothing when no handler is set', () => {
    const log = getLogger('test');
    // Should not throw
    log.debug('msg');
    log.info('msg');
    log.warn('msg');
    log.error('msg');
  });

  describe('consoleLogHandler', () => {
    it('dispatches to the correct console method with prefix', () => {
      const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
      const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});

      consoleLogHandler('debug', 'mod', 'hello', ['a']);
      consoleLogHandler('info', 'mod', 'hello', ['b']);
      consoleLogHandler('warn', 'mod', 'hello', ['c']);
      consoleLogHandler('error', 'mod', 'hello', ['d']);

      expect(spyDebug).toHaveBeenCalledWith('[Newio:mod]', 'hello', 'a');
      expect(spyInfo).toHaveBeenCalledWith('[Newio:mod]', 'hello', 'b');
      expect(spyWarn).toHaveBeenCalledWith('[Newio:mod]', 'hello', 'c');
      expect(spyError).toHaveBeenCalledWith('[Newio:mod]', 'hello', 'd');

      spyDebug.mockRestore();
      spyInfo.mockRestore();
      spyWarn.mockRestore();
      spyError.mockRestore();
    });
  });
});
