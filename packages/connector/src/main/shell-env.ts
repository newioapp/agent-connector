/**
 * Login-shell environment capture for the desktop app.
 *
 * Lives in the desktop (connector) package — not the shared engine, and not the
 * CLI — because only the GUI needs it. The CLI always runs inside the user's
 * interactive shell, so its `process.env` is already fully sourced; it captures
 * that directly. The desktop app is launched from the Dock by launchd with a
 * minimal environment: no PATH additions from `.zshrc`/`.zprofile`/nvm/homebrew,
 * and a possibly-wrong USER/HOME. So here we spawn the user's login shell,
 * read its environment, overlay authoritative password-DB identity, and apply
 * the same shared `basic`/`all` filter the CLI uses.
 *
 * Runs in the Electron MAIN process (never the daemon, never the renderer).
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import { captureEnv, getIdentityEnv } from '@newio/agent-engine';
import type { EnvSyncMode, UserIdentity } from '@newio/agent-engine';

/** Shells we know how to invoke with `-ilc`. */
const SUPPORTED_SHELL_NAMES = new Set(['zsh', 'bash']);

/**
 * Per-process shell bookkeeping that must not cross a process boundary — it
 * reflects the sourcing subshell, not the user's environment. (The shared
 * `captureEnv` filter also drops these, so this is belt-and-suspenders for the
 * raw sourced env.)
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
  readonly readUserInfo: () => UserIdentity;
  /** Reads a file synchronously as utf8. Defaults to fs.readFileSync. */
  readonly readFile: (path: string) => string;
  /** Spawns `shell -ilc <command>` with the given environment, yielding its stdout (or an error). */
  readonly runShell: (
    shell: string,
    command: string,
    env: Record<string, string>,
    callback: (err: Error | null, stdout: string) => void,
  ) => void;
}

const defaultDeps: ShellEnvDeps = {
  readUserInfo: userInfo,
  readFile: (path) => readFileSync(path, 'utf8'),
  runShell: (shell, command, env, callback) => {
    execFile(
      shell,
      ['-ilc', command],
      { encoding: 'utf8', timeout: SHELL_SOURCE_TIMEOUT_MS, env },
      // With `encoding: 'utf8'`, execFile types stdout as a string.
      (err, stdout) => callback(err, stdout),
    );
  },
};

/** Resolve identity from injected deps, falling back to the OS password database. */
function identityEnv(deps: Partial<ShellEnvDeps>): Record<string, string> {
  return getIdentityEnv(deps.readUserInfo ?? defaultDeps.readUserInfo);
}

/** Drop `undefined`-valued entries so a sparse ProcessEnv becomes a clean Record. */
function definedEntries(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * List supported login shells from `/etc/shells` (basename `zsh`/`bash`).
 * Returns `[]` when none are found or the file can't be read.
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
 * password DB, then the fallback env) when supported, otherwise the first
 * supported entry in `/etc/shells`. Returns undefined when nothing is available.
 */
export function pickLoginShell(
  fallbackEnv: NodeJS.ProcessEnv = process.env,
  deps: Partial<ShellEnvDeps> = {},
): string | undefined {
  // getIdentityEnv only sets SHELL when the password DB has one; fall back to
  // the caller's env otherwise. (`in` keeps this undefined-aware regardless of
  // the package's noUncheckedIndexedAccess setting.)
  const identity = identityEnv(deps);
  const preferred = 'SHELL' in identity ? identity['SHELL'] : fallbackEnv['SHELL'];
  if (typeof preferred === 'string' && SUPPORTED_SHELL_NAMES.has(basename(preferred))) {
    return preferred;
  }
  return listLoginShells(deps)[0];
}

/**
 * Source the given login shell and return its environment, with transient
 * bookkeeping stripped and password-DB identity overlaid last. On any failure
 * (spawn error, timeout, empty output) returns `fallbackEnv` + identity — never
 * identity-only, which would drop PATH/TMPDIR/locale and make the next agent
 * launch fail harder than the un-sourced sparse env it replaced.
 */
export function resolveShellEnv(
  shell: string,
  fallbackEnv: NodeJS.ProcessEnv,
  deps: Partial<ShellEnvDeps> = {},
): Promise<Record<string, string>> {
  const runShell = deps.runShell ?? defaultDeps.runShell;
  const identity = identityEnv(deps);
  // Seed the sourcing shell with identity (HOME/USER/LOGNAME/SHELL) so profile
  // scripts that key off $HOME/$USER — nvm, pyenv, Homebrew — resolve against the
  // real user. Without HOME, `bash -ilc` may not even read ~/.bash_profile, so
  // the very PATH this is meant to recover would be missed. TERM=dumb keeps
  // profile output free of terminal control sequences.
  const spawnEnv = { TERM: 'dumb', ...identity };
  return new Promise((resolve) => {
    // Bracket `env -0` (null-delimited, so values may contain newlines) with a
    // marker, so we can strip any banner a profile script printed to stdout.
    const command = `printf %s '${ENV_DELIMITER}'; env -0; printf %s '${ENV_DELIMITER}'`;
    runShell(shell, command, spawnEnv, (err, stdout) => {
      if (err || !stdout) {
        resolve({ ...definedEntries(fallbackEnv), ...identity });
        return;
      }
      // Keep only what's between the two markers; a profile banner lands before
      // the first marker and is discarded. Fall back to the raw output if the
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
 * Capture the agent environment for the desktop app: source the user's login
 * shell (recovering PATH/keys the Dock-launched GUI never sees), then apply the
 * shared `basic`/`all` filter. Falls back to `process.env` + identity when no
 * supported login shell exists.
 */
export async function captureEnvFromShell(
  mode: EnvSyncMode,
  deps: Partial<ShellEnvDeps> = {},
  fallbackEnv: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const shell = pickLoginShell(fallbackEnv, deps);
  const source = shell ? await resolveShellEnv(shell, fallbackEnv, deps) : { ...fallbackEnv, ...identityEnv(deps) };
  return captureEnv(mode, source);
}
