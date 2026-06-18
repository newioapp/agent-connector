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

  it('caches the version-gate verdict inside the daemon-owned data dir', () => {
    expect(getDaemonPaths('prod').versionGateCachePath).toBe(
      join(homedir(), '.newio', 'connector', 'version-gate.json'),
    );
    expect(getDaemonPaths('dev').versionGateCachePath).toBe(
      join(homedir(), '.newio-dev', 'connector', 'version-gate.json'),
    );
    const paths = getDaemonPaths('dev');
    expect(paths.versionGateCachePath.startsWith(paths.dataDir)).toBe(true);
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

describe('getDaemonPaths with NEWIO_HOME', () => {
  const original = process.env['NEWIO_HOME'];

  afterEach(() => {
    if (original === undefined) {
      delete process.env['NEWIO_HOME'];
    } else {
      process.env['NEWIO_HOME'] = original;
    }
  });

  it('roots all daemon paths under NEWIO_HOME when set (test/sandbox isolation)', () => {
    process.env['NEWIO_HOME'] = '/tmp/sandbox';
    const paths = getDaemonPaths('dev');
    expect(paths.dataDir).toBe(join('/tmp/sandbox', '.newio-dev', 'connector'));
    expect(paths.socketPath).toBe(join('/tmp/sandbox', '.newio-dev', 'connector', 'daemon.sock'));
    expect(paths.downloadsDir).toBe(join('/tmp/sandbox', '.newio-dev-downloads'));
    expect(paths.updateCachePath).toBe(join('/tmp/sandbox', '.newio-dev', 'update-check.json'));
  });

  it('falls back to the home directory when NEWIO_HOME is empty', () => {
    process.env['NEWIO_HOME'] = '';
    expect(getDaemonPaths('prod').dataDir).toBe(join(homedir(), '.newio', 'connector'));
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

  it('keeps prod API/WS URLs when only the stage is set, but never the prod CDN', () => {
    process.env['NEWIO_STAGE'] = 'integ';
    // API/WS fall back to prod (existing behavior); the CDN must NOT — it stays
    // undefined so the updater refuses rather than targeting the prod channel.
    expect(resolveConfig()).toEqual({
      stage: 'integ',
      apiBaseUrl: 'https://api.newio.app',
      wsUrl: 'wss://ws.newio.app',
      cdnBaseUrl: undefined,
    });
  });

  it('leaves the CDN undefined for a non-prod stage with no NEWIO_CDN_URL', () => {
    process.env['NEWIO_STAGE'] = 'dev';
    expect(resolveConfig().cdnBaseUrl).toBeUndefined();
  });

  it('uses the hardcoded prod CDN for prod with no override', () => {
    expect(resolveConfig().cdnBaseUrl).toBe('https://cdn.newio.app');
  });

  it('honors NEWIO_CDN_URL for a non-prod stage, stripping a trailing slash', () => {
    process.env['NEWIO_STAGE'] = 'dev';
    process.env['NEWIO_CDN_URL'] = 'https://cdn.example.test/';
    expect(resolveConfig().cdnBaseUrl).toBe('https://cdn.example.test');
  });
});
