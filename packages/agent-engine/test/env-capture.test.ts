import { describe, it, expect } from 'vitest';
import { captureEnv, asEnvSyncMode, ENV_SYNC_MODES, inheritedBaseEnv } from '../src/env-capture';

describe('captureEnv', () => {
  it('basic keeps only allowlisted essentials (incl. LC_* locale) and drops the rest', () => {
    const env = captureEnv('basic', {
      USER: 'nan',
      HOME: '/Users/nan',
      PATH: '/usr/bin',
      LC_ALL: 'en_US.UTF-8',
      SOME_SECRET: 'x',
    });
    expect(env).toEqual({ USER: 'nan', HOME: '/Users/nan', PATH: '/usr/bin', LC_ALL: 'en_US.UTF-8' });
  });

  it('all keeps every variable except cwd-derived ones (PWD/OLDPWD)', () => {
    const env = captureEnv('all', { USER: 'nan', SOME_SECRET: 'x', PWD: '/here', OLDPWD: '/there' });
    expect(env).toEqual({ USER: 'nan', SOME_SECRET: 'x' });
  });

  it('basic also excludes cwd-derived vars even though they are not in the allowlist', () => {
    expect(captureEnv('basic', { PWD: '/here' })).toEqual({});
  });

  it('skips undefined values (NodeJS.ProcessEnv may carry them)', () => {
    expect(captureEnv('all', { USER: 'nan', UNSET: undefined })).toEqual({ USER: 'nan' });
  });

  it('defaults to the current process environment', () => {
    process.env['NEWIO_ENV_CAPTURE_TEST'] = 'present';
    try {
      expect(captureEnv('all')['NEWIO_ENV_CAPTURE_TEST']).toBe('present');
    } finally {
      delete process.env['NEWIO_ENV_CAPTURE_TEST'];
    }
  });
});

describe('inheritedBaseEnv', () => {
  it('keeps only the allowlisted identity vars, dropping PATH/secrets', () => {
    expect(
      inheritedBaseEnv({ HOME: '/Users/nan', USER: 'nan', LOGNAME: 'nan', TMPDIR: '/tmp', PATH: '/x', SECRET: 's' }),
    ).toEqual({ HOME: '/Users/nan', USER: 'nan', LOGNAME: 'nan', TMPDIR: '/tmp' });
  });

  it('omits keys absent from the source', () => {
    expect(inheritedBaseEnv({ USER: 'nan' })).toEqual({ USER: 'nan' });
  });
});

describe('asEnvSyncMode', () => {
  it('accepts the known modes', () => {
    for (const mode of ENV_SYNC_MODES) {
      expect(asEnvSyncMode(mode)).toBe(mode);
    }
  });

  it('rejects anything else', () => {
    expect(() => asEnvSyncMode('shell')).toThrow(/Invalid env-sync mode/);
  });
});
