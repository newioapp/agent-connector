/**
 * Resolve a fully-sourced source environment for agent env capture.
 *
 * Two pieces, both ported from acp-inspector:
 *
 *  1. Authoritative identity from the OS password database (`getIdentityEnv`).
 *     A GUI app launched from the Dock is started by launchd with a minimal
 *     environment, so USER/LOGNAME/HOME/SHELL can be missing or wrong. Claude
 *     Code keys its login-Keychain credential by `$USER`, so a wrong/absent USER
 *     silently breaks agent auth. The password database (getpwuid) always
 *     reflects the real logged-in user, so we overlay it last.
 *
 *  2. Login-shell sourcing (`resolveShellEnv`). The CLI already runs inside the
 *     user's interactive shell, so its `process.env` is fully sourced. The
 *     desktop app, launched from the Dock, does NOT — it never sees PATH
 *     additions from `.zshrc`/`.zprofile`/nvm/homebrew. Spawning the login
 *     shell and reading its environment recovers them.
 *
 * The filter that decides which captured vars actually reach the agent
 * (`basic`/`all`) still lives in env-capture.ts; this module only produces the
 * richest, most-correct SOURCE environment to feed into that filter.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename } from 'node:path';

/** Shells we know how to invoke with `-ilc`. */
const SUPPORTED_SHELL_NAMES = new Set(['zsh', 'bash']);

/**
 * Per-process shell bookkeeping variables that must not cross a process
 * boundary — they reflect the sourcing subshell, not the user's environment:
 *   _      — path of the last command the shell exec'd (e.g. /usr/bin/env)
 *   PWD    — the sourcing shell's cwd; would conflict with the agent's real cwd
 *   OLDPWD — previous `cd` target
 *   SHLVL  — shell-nesting counter; a real shell maintains its own
 */
const TRANSIENT_VARS = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL']);

/**
 * Marker bracketing the `env` output. Login/interactive profile scripts
 * (`.zprofile`, `.zshrc`) are sourced before our command runs and may print
 * banners to stdout (e.g. "Configuring from .zprofile"). That text would
 * otherwise be parsed as a bogus environment variable. We print this marker
 * before and after `env` and keep only the content between the two markers.
 */
const ENV_DELIMITER = '__NEWIO_SHELL_ENV_DELIMITER__';

/** How long to wait for the login shell to source and dump its environment. */
const SHELL_SOURCE_TIMEOUT_MS = 10_000;

/** Injectable system calls, so the sourcing logic is unit-testable without a real shell. */
export interface ShellEnvDeps {
  /** Reads the OS password database for the current uid. Defaults to os.userInfo. */
  readonly readUserInfo: () => { username: string; homedir: string; shell: string | null };
  /** Reads a file synchronously as utf8. Defaults to fs.readFileSync. */
  readonly readFile: (path: string) => string;
  /** Spawns `shell -ilc <command>` and yields its stdout (or an error). */
  readonly runShell: (shell: string, command: string, callback: (err: Error | null, stdout: string) => void) => void;
}

const defaultDeps: ShellEnvDeps = {
  readUserInfo: () => userInfo(),
  readFile: (path) => readFileSync(path, 'utf8'),
  runShell: (shell, command, callback) => {
    // Seed the sourcing shell with TERM=dumb so profile scripts don't emit
    // terminal control sequences; identity is overlaid by the caller.
    execFile(
      shell,
      ['-ilc', command],
      { encoding: 'utf8', timeout: SHELL_SOURCE_TIMEOUT_MS, env: { TERM: 'dumb' } },
      // With `encoding: 'utf8'`, execFile types stdout as a string.
      (err, stdout) => callback(err, stdout),
    );
  },
};

/**
 * Authoritative identity environment derived from the OS password database
 * (getpwuid of the process's real uid), NOT from the shell or process.env.
 * Returns an empty object if userInfo() is unavailable (e.g. uid absent from
 * the password database), in which case identity is left untouched.
 */
export function getIdentityEnv(deps: Partial<ShellEnvDeps> = {}): Record<string, string> {
  const readUserInfo = deps.readUserInfo ?? defaultDeps.readUserInfo;
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

/**
 * List login shells installed on the system that we support. Reads `/etc/shells`
 * and keeps shells whose basename is `zsh` or `bash`. Returns `[]` when none are
 * found or the file can't be read (callers fall back to no sourcing).
 */
export function listLoginShells(deps: Partial<ShellEnvDeps> = {}): string[] {
  const readFile = deps.readFile ?? defaultDeps.readFile;
  try {
    return readFile('/etc/shells')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && SUPPORTED_SHELL_NAMES.has(basename(line)));
  } catch {
    return [];
  }
}

/**
 * Pick the login shell to source. Prefers the user's own `$SHELL` (from the
 * password DB or the fallback env) when it's a supported shell, otherwise the
 * first supported entry in `/etc/shells`. Returns undefined when no supported
 * shell is available — callers then skip sourcing and use the fallback env.
 */
export function pickLoginShell(
  fallbackEnv: NodeJS.ProcessEnv = process.env,
  deps: Partial<ShellEnvDeps> = {},
): string | undefined {
  const preferred = getIdentityEnv(deps).SHELL ?? fallbackEnv['SHELL'];
  if (typeof preferred === 'string' && SUPPORTED_SHELL_NAMES.has(basename(preferred))) {
    return preferred;
  }
  return listLoginShells(deps)[0];
}

/**
 * Source the given login shell and return its environment, with transient
 * shell bookkeeping stripped and password-DB identity overlaid last. On any
 * failure (spawn error, empty output) returns just the authoritative identity,
 * so callers still get a correct USER/LOGNAME/HOME.
 */
export function resolveShellEnv(shell: string, deps: Partial<ShellEnvDeps> = {}): Promise<Record<string, string>> {
  const runShell = deps.runShell ?? defaultDeps.runShell;
  const identity = getIdentityEnv(deps);
  return new Promise((resolve) => {
    // Bracket `env -0` (null-delimited, so values may contain newlines) with a
    // marker, so we can strip any banner a profile script printed to stdout.
    const command = `printf %s '${ENV_DELIMITER}'; env -0; printf %s '${ENV_DELIMITER}'`;
    runShell(shell, command, (err, stdout) => {
      if (err || !stdout) {
        resolve({ ...identity });
        return;
      }
      // Keep only what's between the two markers; profile banners land before
      // the first marker and are discarded. Fall back to the raw output if the
      // markers are missing (unexpected — e.g. printf unavailable).
      const first = stdout.indexOf(ENV_DELIMITER);
      const last = stdout.lastIndexOf(ENV_DELIMITER);
      const body = first !== -1 && last !== first ? stdout.slice(first + ENV_DELIMITER.length, last) : stdout;

      const env: Record<string, string> = {};
      for (const entry of body.split('\0')) {
        const idx = entry.indexOf('=');
        if (idx > 0) {
          const key = entry.slice(0, idx);
          if (!TRANSIENT_VARS.has(key)) {
            env[key] = entry.slice(idx + 1);
          }
        }
      }
      // Overlay identity last — a profile script could have clobbered it, and
      // the password-database value is authoritative.
      resolve({ ...env, ...identity });
    });
  });
}

/**
 * Build the richest, most-correct SOURCE environment to feed into the capture
 * filter. By default sources the user's login shell (recovering PATH/keys a
 * Dock-launched GUI process never sees) and overlays password-DB identity. Set
 * `sourceShell: false` for callers already running inside a sourced shell (the
 * CLI), which then only need the identity overlay — no extra shell spawn.
 */
export async function resolveSourceEnv(
  opts: { sourceShell?: boolean; fallbackEnv?: NodeJS.ProcessEnv; deps?: Partial<ShellEnvDeps> } = {},
): Promise<NodeJS.ProcessEnv> {
  const { sourceShell = true, fallbackEnv = process.env, deps = {} } = opts;
  if (sourceShell) {
    const shell = pickLoginShell(fallbackEnv, deps);
    if (shell) {
      return resolveShellEnv(shell, deps);
    }
  }
  // No sourcing (disabled, or no supported shell): use the fallback env with
  // authoritative identity overlaid on top.
  return { ...fallbackEnv, ...getIdentityEnv(deps) };
}
