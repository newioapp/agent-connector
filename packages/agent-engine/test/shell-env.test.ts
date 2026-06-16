import { describe, it, expect } from 'vitest';
import { getIdentityEnv, listLoginShells, pickLoginShell, resolveShellEnv, resolveSourceEnv } from '../src/shell-env';
import type { ShellEnvDeps } from '../src/shell-env';

const DELIMITER = '__NEWIO_SHELL_ENV_DELIMITER__';

/** Build a null-delimited `env -0` body bracketed by the delimiter, as the real shell command emits. */
function shellOutput(vars: Record<string, string>, opts: { banner?: string } = {}): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\0');
  return `${opts.banner ?? ''}${DELIMITER}${body}${DELIMITER}`;
}

const realUser = { username: 'real', homedir: '/Users/real', shell: '/bin/zsh' };

/** Deps that never touch the real OS — a fixed identity, a fixed /etc/shells, and a scripted shell. */
function deps(over: Partial<ShellEnvDeps> = {}): Partial<ShellEnvDeps> {
  return {
    readUserInfo: () => realUser,
    readFile: () => '/bin/zsh\n/bin/bash\n# comment\n/usr/bin/false\n',
    runShell: (_shell, _command, cb) => cb(null, shellOutput({ PATH: '/sourced/bin' })),
    ...over,
  };
}

describe('getIdentityEnv', () => {
  it('derives USER/LOGNAME/HOME/SHELL from the password database', () => {
    expect(getIdentityEnv(deps())).toEqual({
      USER: 'real',
      LOGNAME: 'real',
      HOME: '/Users/real',
      SHELL: '/bin/zsh',
    });
  });

  it('omits SHELL when the password database has none', () => {
    expect(getIdentityEnv(deps({ readUserInfo: () => ({ ...realUser, shell: '' }) }))).toEqual({
      USER: 'real',
      LOGNAME: 'real',
      HOME: '/Users/real',
    });
  });

  it('returns {} when userInfo throws (uid not in password database)', () => {
    expect(
      getIdentityEnv({
        readUserInfo: () => {
          throw new Error('no such uid');
        },
      }),
    ).toEqual({});
  });
});

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
  it('sources the shell, strips the banner, and overlays identity', async () => {
    const env = await resolveShellEnv(
      '/bin/zsh',
      deps({
        runShell: (_s, _c, cb) =>
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
      deps({
        runShell: (_s, _c, cb) =>
          cb(null, shellOutput({ PATH: '/sourced/bin', _: '/usr/bin/env', PWD: '/x', OLDPWD: '/y', SHLVL: '3' })),
      }),
    );
    expect(env).toEqual({
      PATH: '/sourced/bin',
      USER: 'real',
      LOGNAME: 'real',
      HOME: '/Users/real',
      SHELL: '/bin/zsh',
    });
  });

  it('falls back to identity-only when the shell spawn fails', async () => {
    const env = await resolveShellEnv(
      '/bin/zsh',
      deps({ runShell: (_s, _c, cb) => cb(new Error('spawn EACCES'), '') }),
    );
    expect(env).toEqual({ USER: 'real', LOGNAME: 'real', HOME: '/Users/real', SHELL: '/bin/zsh' });
  });

  it('falls back to raw output when delimiters are missing', async () => {
    const env = await resolveShellEnv(
      '/bin/zsh',
      deps({ runShell: (_s, _c, cb) => cb(null, `PATH=/sourced/bin\0FOO=bar`) }),
    );
    expect(env['PATH']).toBe('/sourced/bin');
    expect(env['FOO']).toBe('bar');
  });
});

describe('resolveSourceEnv', () => {
  it('sources the login shell by default', async () => {
    const env = await resolveSourceEnv({
      fallbackEnv: { PATH: '/sparse' },
      deps: deps({ runShell: (_s, _c, cb) => cb(null, shellOutput({ PATH: '/sourced/bin' })) }),
    });
    expect(env['PATH']).toBe('/sourced/bin');
    expect(env['USER']).toBe('real');
  });

  it('skips the shell spawn and overlays identity onto the fallback env when sourceShell is false', async () => {
    let spawned = false;
    const env = await resolveSourceEnv({
      sourceShell: false,
      fallbackEnv: { PATH: '/from/process', USER: 'wrong' },
      deps: deps({
        runShell: (_s, _c, cb) => {
          spawned = true;
          cb(null, '');
        },
      }),
    });
    expect(spawned).toBe(false);
    expect(env['PATH']).toBe('/from/process');
    expect(env['USER']).toBe('real'); // identity overlay still applied
  });

  it('falls back to fallbackEnv + identity when no supported shell exists', async () => {
    const env = await resolveSourceEnv({
      fallbackEnv: { PATH: '/from/process' },
      deps: deps({ readUserInfo: () => ({ ...realUser, shell: '' }), readFile: () => '/usr/bin/fish\n' }),
    });
    expect(env['PATH']).toBe('/from/process');
    expect(env['USER']).toBe('real');
  });
});
