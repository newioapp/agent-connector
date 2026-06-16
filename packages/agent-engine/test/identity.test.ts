import { describe, it, expect } from 'vitest';
import { getIdentityEnv } from '../src/identity';

const realUser = { username: 'real', homedir: '/Users/real', shell: '/bin/zsh' };

describe('getIdentityEnv', () => {
  it('derives USER/LOGNAME/HOME/SHELL from the password database', () => {
    expect(getIdentityEnv(() => realUser)).toEqual({
      USER: 'real',
      LOGNAME: 'real',
      HOME: '/Users/real',
      SHELL: '/bin/zsh',
    });
  });

  it('omits SHELL when the password database has none', () => {
    expect(getIdentityEnv(() => ({ ...realUser, shell: '' }))).toEqual({
      USER: 'real',
      LOGNAME: 'real',
      HOME: '/Users/real',
    });
  });

  it('returns {} when userInfo throws (uid not in password database)', () => {
    expect(
      getIdentityEnv(() => {
        throw new Error('no such uid');
      }),
    ).toEqual({});
  });
});
