import { describe, it, expect } from 'vitest';
import {
  listLoginShells,
  pickLoginShell,
  resolveShellEnv,
  captureEnvFromShell,
  type ShellEnvDeps,
} from '../../src/main/shell-env';

const DELIMITER = '__NEWIO_SHELL_ENV_DELIMITER__';

/** Build a null-delimited `env -0` body bracketed by the delimiter, as the real shell command emits. */
function shellOutput(vars: Record<string, string>, opts: { banner?: string } = {}): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\0');
  return `${opts.banner ?? ''}${DELIMITER}${body}${DELIMITER}`;
}

const realUser = { username: 'real', homedir: '/Users/real', shell: '/bin/zsh' };

const IDENTITY = { USER: 'real', LOGNAME: 'real', HOME: '/Users/real', SHELL: '/bin/zsh' };

/** Deps that never touch the real OS — a fixed identity, a fixed /etc/shells, and a scripted shell. */
function deps(over: Partial<ShellEnvDeps> = {}): Partial<ShellEnvDeps> {
  return {
    readUserInfo: () => realUser,
    readFile: () => '/bin/zsh\n/bin/bash\n# comment\n/usr/bin/false\n',
    runShell: (_shell, _command, _env, cb) => cb(null, shellOutput({ PATH: '/sourced/bin' })),
    ...over,
  };
}

describe('listLoginShells', () => {
  it('keeps only supported shells (zsh/bash), dropping comments and others', () => {
    expect(listLoginShells(deps())).toEqual(['/bin/zsh', '/bin/bash']);
  });

  it('returns [] when /etc/shells cannot be read', () => {
    expect(
      listLoginShells({
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toEqual([]);
  });
});

describe('pickLoginShell', () => {
  it('prefers the password-DB SHELL when supported', () => {
    expect(pickLoginShell({}, deps())).toBe('/bin/zsh');
  });

  it('falls back to the env SHELL when identity has none', () => {
    expect(pickLoginShell({ SHELL: '/bin/bash' }, deps({ readUserInfo: () => ({ ...realUser, shell: '' }) }))).toBe(
      '/bin/bash',
    );
  });

  it('falls back to the first /etc/shells entry when no SHELL is supported', () => {
    expect(
      pickLoginShell(
        { SHELL: '/usr/bin/fish' },
        deps({ readUserInfo: () => ({ ...realUser, shell: '/usr/bin/fish' }) }),
      ),
    ).toBe('/bin/zsh');
  });

  it('returns undefined when nothing supported is available', () => {
    expect(
      pickLoginShell(
        { SHELL: '/usr/bin/fish' },
        deps({ readUserInfo: () => ({ ...realUser, shell: '' }), readFile: () => '/usr/bin/fish\n' }),
      ),
    ).toBeUndefined();
  });
});

describe('resolveShellEnv', () => {
  it('seeds the sourcing shell with identity + TERM=dumb (so $HOME-keyed profiles resolve)', async () => {
    let spawnEnv: Record<string, string> | undefined;
    await resolveShellEnv(
      '/bin/zsh',
      {},
      deps({
        runShell: (_s, _c, env, cb) => {
          spawnEnv = env;
          cb(null, shellOutput({ PATH: '/sourced/bin' }));
        },
      }),
    );
    // HOME present so bash -ilc can read ~/.bash_profile and nvm/Homebrew resolve $HOME.
    expect(spawnEnv).toEqual({ TERM: 'dumb', ...IDENTITY });
  });

  it('sources the shell, strips the banner, and overlays identity', async () => {
    const env = await resolveShellEnv(
      '/bin/zsh',
      {},
      deps({
        runShell: (_s, _c, _env, cb) =>
          cb(null, shellOutput({ PATH: '/sourced/bin', USER: 'stale' }, { banner: 'Configuring from .zprofile\n' })),
      }),
    );
    expect(env['PATH']).toBe('/sourced/bin');
    // Identity overlay wins over a stale USER the profile left behind.
    expect(env['USER']).toBe('real');
    expect(env['HOME']).toBe('/Users/real');
    // Banner text must not become a bogus variable.
    expect(Object.keys(env)).not.toContain('Configuring from .zprofile');
  });

  it('drops transient shell bookkeeping (_, PWD, OLDPWD, SHLVL)', async () => {
    const env = await resolveShellEnv(
      '/bin/zsh',
      {},
      deps({
        runShell: (_s, _c, _env, cb) =>
          cb(null, shellOutput({ PATH: '/sourced/bin', _: '/usr/bin/env', PWD: '/x', OLDPWD: '/y', SHLVL: '3' })),
      }),
    );
    expect(env).toEqual({ PATH: '/sourced/bin', ...IDENTITY });
  });

  it('falls back to fallbackEnv + identity (not identity-only) when the shell spawn fails', async () => {
    const env = await resolveShellEnv(
      '/bin/zsh',
      { PATH: '/launchd/bin', TMPDIR: '/tmp', UNSET: undefined },
      deps({ runShell: (_s, _c, _env, cb) => cb(new Error('spawn EACCES'), '') }),
    );
    // PATH/TMPDIR from the fallback survive (dropping them would be worse than the
    // pre-sourcing env); undefined is filtered; identity is overlaid.
    expect(env).toEqual({ PATH: '/launchd/bin', TMPDIR: '/tmp', ...IDENTITY });
  });

  it('falls back to raw output when delimiters are missing', async () => {
    const env = await resolveShellEnv(
      '/bin/zsh',
      {},
      deps({ runShell: (_s, _c, _env, cb) => cb(null, `PATH=/sourced/bin\0FOO=bar`) }),
    );
    expect(env['PATH']).toBe('/sourced/bin');
    expect(env['FOO']).toBe('bar');
  });
});

describe('captureEnvFromShell', () => {
  it('basic mode keeps the sourced PATH + authoritative identity, dropping secrets', async () => {
    const env = await captureEnvFromShell(
      'basic',
      deps({
        runShell: (_s, _c, _env, cb) =>
          cb(null, shellOutput({ PATH: '/sourced/bin', SOME_SECRET: 'x', USER: 'stale' })),
      }),
    );
    // PATH from the sourced shell; USER from the password DB (not the stale one); secret dropped by `basic`.
    expect(env).toEqual({ PATH: '/sourced/bin', ...IDENTITY });
  });

  it('all mode keeps sourced secrets too, but identity still wins', async () => {
    const env = await captureEnvFromShell(
      'all',
      deps({
        runShell: (_s, _c, _env, cb) =>
          cb(null, shellOutput({ PATH: '/sourced/bin', SOME_SECRET: 'x', USER: 'stale' })),
      }),
    );
    expect(env['SOME_SECRET']).toBe('x');
    expect(env['USER']).toBe('real');
  });

  it('supported shell selected but spawn fails → keeps the fallback PATH, not identity-only', async () => {
    const env = await captureEnvFromShell(
      'basic',
      deps({ runShell: (_s, _c, _env, cb) => cb(new Error('timeout'), '') }),
      { PATH: '/launchd/bin', SOME_SECRET: 'x' }, // a supported shell (/bin/zsh) is still picked from identity
    );
    // The launchd-provided PATH is preserved so the next agent launch can still
    // find node; `basic` still drops the secret; identity overlaid.
    expect(env).toEqual({ PATH: '/launchd/bin', ...IDENTITY });
  });

  it('falls back to the given env + identity when no supported login shell exists', async () => {
    let spawned = false;
    const env = await captureEnvFromShell(
      'basic',
      deps({
        readUserInfo: () => ({ ...realUser, shell: '' }), // no SHELL from the password DB
        readFile: () => '/usr/bin/fish\n', // /etc/shells has nothing supported
        runShell: (_s, _c, _env, cb) => {
          spawned = true;
          cb(null, '');
        },
      }),
      { PATH: '/from/process' }, // fallback env: no SHELL, so no shell is picked
    );
    // No shell was sourced; the fallback env is filtered, identity overlaid.
    expect(spawned).toBe(false);
    expect(env['PATH']).toBe('/from/process');
    expect(env['USER']).toBe('real');
  });
});
