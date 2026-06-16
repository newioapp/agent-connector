import { describe, it, expect } from 'vitest';
import { captureEnv, captureShellEnv, asEnvSyncMode, ENV_SYNC_MODES, inheritedBaseEnv } from '../src/env-capture';
import type { ShellEnvDeps } from '../src/shell-env';

const DELIMITER = '__NEWIO_SHELL_ENV_DELIMITER__';

/** Deps that source a fixed identity + scripted shell, never touching the real OS. */
function shellDeps(sourced: Record<string, string>): Partial<ShellEnvDeps> {
  const body = Object.entries(sourced)
    .map(([k, v]) => `${k}=${v}`)
    .join('\0');
  return {
    readUserInfo: () => ({ username: 'real', homedir: '/Users/real', shell: '/bin/zsh' }),
    readFile: () => '/bin/zsh\n',
    runShell: (_shell, _command, cb) => cb(null, `${DELIMITER}${body}${DELIMITER}`),
  };
}

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

  it('all keeps every variable except transient shell bookkeeping (PWD/OLDPWD/_/SHLVL)', () => {
    const env = captureEnv('all', {
      USER: 'nan',
      SOME_SECRET: 'x',
      PWD: '/here',
      OLDPWD: '/there',
      _: '/usr/bin/env',
      SHLVL: '2',
    });
    expect(env).toEqual({ USER: 'nan', SOME_SECRET: 'x' });
  });

  it('basic also excludes transient bookkeeping vars even though they are not in the allowlist', () => {
    expect(captureEnv('basic', { PWD: '/here', _: '/usr/bin/env', SHLVL: '2' })).toEqual({});
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
  // Pass an explicit empty identity to assert the pure allowlist filter without
  // the OS password-DB overlay (which is exercised separately below).
  const noIdentity = {};

  it('keeps only the allowlisted identity vars, dropping PATH/secrets', () => {
    expect(
      inheritedBaseEnv(
        { HOME: '/Users/nan', USER: 'nan', LOGNAME: 'nan', TMPDIR: '/tmp', PATH: '/x', SECRET: 's' },
        noIdentity,
      ),
    ).toEqual({ HOME: '/Users/nan', USER: 'nan', LOGNAME: 'nan', TMPDIR: '/tmp' });
  });

  it('omits keys absent from the source', () => {
    expect(inheritedBaseEnv({ USER: 'nan' }, noIdentity)).toEqual({ USER: 'nan' });
  });

  it('overlays authoritative identity, winning over a sparse/absent source USER/HOME', () => {
    // Daemon-style sparse source with no USER/HOME; password-DB identity fills them in.
    expect(inheritedBaseEnv({ TMPDIR: '/tmp' }, { USER: 'real', LOGNAME: 'real', HOME: '/Users/real' })).toEqual({
      TMPDIR: '/tmp',
      USER: 'real',
      LOGNAME: 'real',
      HOME: '/Users/real',
    });
  });

  it('identity overrides a wrong USER/HOME present in the source', () => {
    expect(
      inheritedBaseEnv({ USER: 'wrong', HOME: '/wrong' }, { USER: 'real', LOGNAME: 'real', HOME: '/Users/real' }),
    ).toEqual({ USER: 'real', LOGNAME: 'real', HOME: '/Users/real' });
  });
});

describe('captureShellEnv', () => {
  it('basic mode keeps the sourced PATH plus authoritative identity, dropping secrets', async () => {
    const env = await captureShellEnv('basic', {
      deps: shellDeps({ PATH: '/sourced/bin', SOME_SECRET: 'x', USER: 'stale' }),
    });
    // PATH from the sourced shell; USER from the password DB (not the stale one); secret dropped by `basic`.
    expect(env).toEqual({
      PATH: '/sourced/bin',
      USER: 'real',
      LOGNAME: 'real',
      HOME: '/Users/real',
      SHELL: '/bin/zsh',
    });
  });

  it('all mode keeps sourced secrets too, but identity still wins', async () => {
    const env = await captureShellEnv('all', {
      deps: shellDeps({ PATH: '/sourced/bin', SOME_SECRET: 'x', USER: 'stale' }),
    });
    expect(env['SOME_SECRET']).toBe('x');
    expect(env['USER']).toBe('real');
  });

  it('sourceShell:false captures the fallback env (no shell spawn) with identity overlaid', async () => {
    let spawned = false;
    const env = await captureShellEnv('all', {
      sourceShell: false,
      fallbackEnv: { PATH: '/from/process', USER: 'wrong' },
      deps: {
        readUserInfo: () => ({ username: 'real', homedir: '/Users/real', shell: '/bin/zsh' }),
        runShell: (_s, _c, cb) => {
          spawned = true;
          cb(null, '');
        },
      },
    });
    expect(spawned).toBe(false);
    expect(env['PATH']).toBe('/from/process');
    expect(env['USER']).toBe('real');
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
