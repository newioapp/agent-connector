import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveStage, resolveConfig } from '../src/paths';

describe('resolveStage', () => {
  it('defaults to prod when unset or empty', () => {
    expect(resolveStage(undefined)).toBe('prod');
    expect(resolveStage('')).toBe('prod');
  });

  it('returns known stages', () => {
    expect(resolveStage('dev')).toBe('dev');
    expect(resolveStage('integ')).toBe('integ');
    expect(resolveStage('prod')).toBe('prod');
  });

  it('throws on an unknown non-empty value instead of falling back', () => {
    expect(() => resolveStage('devv')).toThrow(/Invalid NEWIO_STAGE "devv"/);
    expect(() => resolveStage('staging')).toThrow(/Expected one of: dev, integ, prod/);
  });
});

describe('resolveConfig', () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env['NEWIO_STAGE'];
    delete process.env['NEWIO_API_URL'];
    delete process.env['NEWIO_WS_URL'];
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('falls back to prod stage and prod endpoints with no env', () => {
    expect(resolveConfig()).toEqual({
      stage: 'prod',
      apiBaseUrl: 'https://api.newio.app',
      wsUrl: 'wss://ws.newio.app',
    });
  });

  it('reads stage and URL overrides from the environment', () => {
    process.env['NEWIO_STAGE'] = 'dev';
    process.env['NEWIO_API_URL'] = 'https://api.example.test';
    process.env['NEWIO_WS_URL'] = 'wss://ws.example.test';
    expect(resolveConfig()).toEqual({
      stage: 'dev',
      apiBaseUrl: 'https://api.example.test',
      wsUrl: 'wss://ws.example.test',
    });
  });

  it('keeps prod URLs when only the stage is set', () => {
    process.env['NEWIO_STAGE'] = 'integ';
    expect(resolveConfig()).toEqual({
      stage: 'integ',
      apiBaseUrl: 'https://api.newio.app',
      wsUrl: 'wss://ws.newio.app',
    });
  });
});
