/**
 * Authoritative process identity from the OS password database.
 *
 * Used in two places, both independent of any login-shell sourcing (which lives
 * in the desktop app):
 *  - the daemon's agent spawn (`inheritedBaseEnv`), so a spawned agent always
 *    has a correct `$USER` even though the daemon's own environment is sparse —
 *    Claude Code keys its login-Keychain credential by `$USER`, so a wrong or
 *    absent value silently breaks agent auth; and
 *  - the desktop's shell-env capture, as the final overlay over a sourced env.
 */
import { userInfo } from 'node:os';

/** The subset of `os.userInfo()` we depend on; narrowed so it's trivial to fake in tests. */
export interface UserIdentity {
  readonly username: string;
  readonly homedir: string;
  readonly shell: string | null;
}

/**
 * Identity environment derived from the OS password database (getpwuid of the
 * process's real uid), NOT from the shell or `process.env`. A GUI app launched
 * from the Dock is started by launchd with a minimal environment, so
 * `USER`/`LOGNAME`/`HOME`/`SHELL` can be missing or wrong; the password database
 * always reflects the real logged-in user. Returns `{}` when `userInfo()` is
 * unavailable (e.g. uid absent from the database), leaving identity untouched.
 */
export function getIdentityEnv(readUserInfo: () => UserIdentity = userInfo): Record<string, string> {
  try {
    const info = readUserInfo();
    const identity: Record<string, string> = {
      USER: info.username,
      LOGNAME: info.username,
      HOME: info.homedir,
    };
    // pw_shell may be empty on some systems; only set SHELL when present.
    if (typeof info.shell === 'string' && info.shell.length > 0) {
      identity.SHELL = info.shell;
    }
    return identity;
  } catch {
    return {};
  }
}
