import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { resolveStage, resolveConfig, stageFromCommandName, getDaemonPaths } from '../src/paths';

describe('stageFromCommandName', () => {
  it('infers the stage from a stage-named command', () => {
    expect(stageFromCommandName('newio-dev')).toBe('dev');
    expect(stageFromCommandName('newio-integ')).toBe('integ');
  });

  it('resolves plain newio and anything unrecognized to prod', () => {
    expect(stageFromCommandName('newio')).toBe('prod');
    expect(stageFromCommandName('node')).toBe('prod');
    expect(stageFromCommandName('newio-bogus')).toBe('prod');
  });

  it('uses the basename, so an absolute launcher path still resolves', () => {
    expect(stageFromCommandName('/home/u/.local/bin/newio-dev')).toBe('dev');
    expect(stageFromCommandName('/usr/local/bin/newio')).toBe('prod');
  });
});

describe('resolveStage', () => {
  it('defaults to the command-name stage when unset or empty', () => {
    // Default command (process.argv0 = node under vitest) → prod.
    expect(resolveStage(undefined)).toBe('prod');
    expect(resolveStage('')).toBe('prod');
    // An explicit stage-named command is honored when NEWIO_STAGE is unset.
    expect(resolveStage(undefined, 'newio-dev')).toBe('dev');
    expect(resolveStage('', '/opt/bin/newio-integ')).toBe('integ');
  });

  it('lets an explicit NEWIO_STAGE override the command name', () => {
    expect(resolveStage('prod', 'newio-dev')).toBe('prod');
    expect(resolveStage('integ', 'newio')).toBe('integ');
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

describe('getDaemonPaths', () => {
  it('roots prod under ~/.newio with a sibling ~/.newio-downloads', () => {
    const paths = getDaemonPaths('prod');
    expect(paths.dataDir).toBe(join(homedir(), '.newio', 'connector'));
    expect(paths.downloadsDir).toBe(join(homedir(), '.newio-downloads'));
  });

  it('caches the update check beside the data dir, stage-scoped', () => {
    expect(getDaemonPaths('prod').updateCachePath).toBe(join(homedir(), '.newio', 'update-check.json'));
    expect(getDaemonPaths('dev').updateCachePath).toBe(join(homedir(), '.newio-dev', 'update-check.json'));
  });

  it('keeps the update cache out of connector/ so daemon uninstall preserves it', () => {
    const paths = getDaemonPaths('dev');
    expect(paths.updateCachePath.startsWith(paths.dataDir)).toBe(false);
  });

  it('stage-suffixes both the data dir and the downloads dir for non-prod', () => {
    expect(getDaemonPaths('dev').dataDir).toBe(join(homedir(), '.newio-dev', 'connector'));
    expect(getDaemonPaths('dev').downloadsDir).toBe(join(homedir(), '.newio-dev-downloads'));
    expect(getDaemonPaths('integ').downloadsDir).toBe(join(homedir(), '.newio-integ-downloads'));
  });

  it('keeps the downloads dir a hidden sibling, not nested under the data dir', () => {
    const paths = getDaemonPaths('dev');
    expect(paths.downloadsDir.startsWith(paths.dataDir)).toBe(false);
  });
});

describe('resolveConfig', () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env['NEWIO_STAGE'];
    delete process.env['NEWIO_API_URL'];
    delete process.env['NEWIO_WS_URL'];
    delete process.env['NEWIO_CDN_URL'];
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('falls back to prod stage and prod endpoints with no env', () => {
    expect(resolveConfig()).toEqual({
      stage: 'prod',
      apiBaseUrl: 'https://api.newio.app',
      wsUrl: 'wss://ws.newio.app',
      cdnBaseUrl: 'https://cdn.newio.app',
    });
  });

  it('reads stage and URL overrides from the environment', () => {
    process.env['NEWIO_STAGE'] = 'dev';
    process.env['NEWIO_API_URL'] = 'https://api.example.test';
    process.env['NEWIO_WS_URL'] = 'wss://ws.example.test';
    process.env['NEWIO_CDN_URL'] = 'https://cdn.example.test';
    expect(resolveConfig()).toEqual({
      stage: 'dev',
      apiBaseUrl: 'https://api.example.test',
      wsUrl: 'wss://ws.example.test',
      cdnBaseUrl: 'https://cdn.example.test',
    });
  });

  it('keeps prod URLs when only the stage is set', () => {
    process.env['NEWIO_STAGE'] = 'integ';
    expect(resolveConfig()).toEqual({
      stage: 'integ',
      apiBaseUrl: 'https://api.newio.app',
      wsUrl: 'wss://ws.newio.app',
      cdnBaseUrl: 'https://cdn.newio.app',
    });
  });

  it('strips a trailing slash from NEWIO_CDN_URL so the manifest path joins cleanly', () => {
    process.env['NEWIO_CDN_URL'] = 'https://cdn.example.test/';
    expect(resolveConfig().cdnBaseUrl).toBe('https://cdn.example.test');
  });
});
