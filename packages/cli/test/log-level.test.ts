import { describe, it, expect, vi, afterEach } from 'vitest';
import { getLogger, setLogHandler } from '@newio/agent-sdk';
import {
  parseLogLevel,
  resolveLogLevel,
  isLevelEnabled,
  installClientLogHandler,
  DEFAULT_LOG_LEVEL,
} from '../src/daemon/log-level';

describe('parseLogLevel', () => {
  it('accepts each known level', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('info')).toBe('info');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('error')).toBe('error');
  });

  it('returns undefined for unknown or absent values', () => {
    expect(parseLogLevel('trace')).toBeUndefined();
    expect(parseLogLevel('')).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });
});

describe('resolveLogLevel', () => {
  it('uses the explicit flag when provided', () => {
    expect(resolveLogLevel('debug')).toBe('debug');
    expect(resolveLogLevel('warn')).toBe('warn');
  });

  it('defaults to info when no flag is given', () => {
    expect(resolveLogLevel(undefined)).toBe(DEFAULT_LOG_LEVEL);
    expect(DEFAULT_LOG_LEVEL).toBe('info');
  });

  it('ignores an unrecognized value rather than failing', () => {
    expect(resolveLogLevel('bogus')).toBe('info');
  });
});

describe('isLevelEnabled', () => {
  it('suppresses levels below the threshold', () => {
    expect(isLevelEnabled('debug', 'info')).toBe(false);
    expect(isLevelEnabled('info', 'info')).toBe(true);
    expect(isLevelEnabled('error', 'info')).toBe(true);
  });

  it('passes everything at debug threshold', () => {
    expect(isLevelEnabled('debug', 'debug')).toBe(true);
    expect(isLevelEnabled('error', 'debug')).toBe(true);
  });

  it('passes only errors at error threshold', () => {
    expect(isLevelEnabled('warn', 'error')).toBe(false);
    expect(isLevelEnabled('error', 'error')).toBe(true);
  });
});

describe('installClientLogHandler', () => {
  afterEach(() => {
    setLogHandler(undefined);
    vi.restoreAllMocks();
  });

  it('writes diagnostics to stderr with a [name] tag and no timestamp', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installClientLogHandler();

    getLogger('launchd').info('Wrote plist', { path: '/x' });

    expect(err).toHaveBeenCalledWith('[launchd]', 'Wrote plist', { path: '/x' });
    // No ISO-8601 timestamp prefix (that's the daemon file log's concern).
    expect(err.mock.calls[0]?.[0]).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('runs at the info default — suppresses debug, keeps info/warn/error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installClientLogHandler();
    expect(DEFAULT_LOG_LEVEL).toBe('info');

    const log = getLogger('svc');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(err).toHaveBeenCalledTimes(3);
    expect(err).not.toHaveBeenCalledWith('[svc]', 'd');
    expect(err).toHaveBeenCalledWith('[svc]', 'i');
    expect(err).toHaveBeenCalledWith('[svc]', 'w');
    expect(err).toHaveBeenCalledWith('[svc]', 'e');
  });
});
