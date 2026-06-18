import { describe, it, expect } from 'vitest';
import { parseLogLevel, resolveLogLevel, isLevelEnabled, DEFAULT_LOG_LEVEL } from '../src/daemon/log-level';

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
