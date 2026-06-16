/**
 * Environment capture for agent processes.
 *
 * Both modes read from a given environment (defaulting to the CURRENT process's
 * own environment) — captured client-side by whichever process configures the
 * agent: the CLI's interactive shell, or the desktop app's process. The daemon
 * never sources a login shell; its own service environment is sparse.
 *
 * The richest SOURCE environment (login-shell sourcing for the desktop +
 * authoritative password-DB identity) is built in shell-env.ts; this file owns
 * the `basic`/`all` filter that decides which of those vars reach the agent.
 */
import { getIdentityEnv, resolveSourceEnv } from './shell-env.js';
import type { ShellEnvDeps } from './shell-env.js';

/** How much of the environment to capture for an agent. */
export type EnvSyncMode = 'basic' | 'all';
export const ENV_SYNC_MODES: readonly EnvSyncMode[] = ['basic', 'all'];
export const DEFAULT_ENV_SYNC_MODE: EnvSyncMode = 'basic';

/**
 * `basic` allowlist: the minimum an agent needs to launch and to reach the macOS
 * login Keychain — Claude Code keys its credential by `$USER`, so dropping it
 * silently breaks auth. (`TERM` is omitted: the agent spawn forces `TERM=dumb`.)
 */
const BASIC_ENV_KEYS: readonly string[] = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'TZ', 'TMPDIR'];
/** Prefixes kept wholesale by `basic` (locale: `LC_ALL`, `LC_CTYPE`, …). */
const BASIC_ENV_PREFIXES: readonly string[] = ['LC_'];
/**
 * Never captured, in either mode: per-process shell bookkeeping that's stale
 * once handed to the agent. `PWD`/`OLDPWD` are cwd-derived (the agent's cwd is
 * set explicitly); `_` is the last-exec'd command path; `SHLVL` is the shell
 * nesting counter (the agent maintains its own).
 */
const EXCLUDED_ENV_KEYS = new Set(['PWD', 'OLDPWD', '_', 'SHLVL']);

/**
 * Host-process vars inherited as a fallback for agent spawns, so identity vars
 * (which Claude Code keys its Keychain credential by) are present even when an
 * agent's configured envVars omit them. Deliberately tight — an allowlist, not
 * the daemon's whole environment; PATH/secrets/etc. come from the agent's own
 * configured env, which for `basic`/`all` already includes USER/HOME.
 */
const INHERITED_ENV_KEYS: readonly string[] = ['HOME', 'USER', 'LOGNAME', 'TMPDIR'];

/**
 * Pick the allowlisted identity vars from `source` (defaults to this process's
 * environment), then overlay authoritative identity from the OS password
 * database. The overlay matters most at spawn time: the daemon's own
 * environment is sparse and may omit `USER`/`HOME` entirely, yet Claude Code
 * keys its Keychain credential by `$USER`. getpwuid always reflects the real
 * logged-in user, so it wins over whatever `source` did (or didn't) provide.
 */
export function inheritedBaseEnv(
  source: NodeJS.ProcessEnv = process.env,
  identity: Record<string, string> = getIdentityEnv(),
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return { ...result, ...identity };
}

/** Narrow a raw string to an EnvSyncMode, throwing on anything else. */
export function asEnvSyncMode(value: string): EnvSyncMode {
  const match = ENV_SYNC_MODES.find((m) => m === value);
  if (!match) {
    throw new Error(`Invalid env-sync mode "${value}". Expected one of: ${ENV_SYNC_MODES.join(', ')}`);
  }
  return match;
}

function isBasicKey(key: string): boolean {
  return BASIC_ENV_KEYS.includes(key) || BASIC_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Capture environment variables from `source` (defaults to this process's own
 * environment) according to `mode`:
 * - `basic` — only the allowlisted essentials (see {@link BASIC_ENV_KEYS}).
 * - `all` — every defined variable except cwd-derived ones (`PWD`/`OLDPWD`).
 */
export function captureEnv(mode: EnvSyncMode, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || EXCLUDED_ENV_KEYS.has(key)) {
      continue;
    }
    if (mode === 'all' || isBasicKey(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Capture environment variables, resolving the SOURCE first via shell-env:
 * - `sourceShell: true` (default) sources the user's login shell and overlays
 *   password-DB identity — for the desktop app, which is launched from the Dock
 *   without a sourced environment.
 * - `sourceShell: false` skips the shell spawn and only overlays identity onto
 *   the existing process environment — for the CLI, already inside a sourced
 *   interactive shell.
 *
 * Identity vars (`USER`/`HOME`/`LOGNAME`/`SHELL`) are in the `basic` allowlist,
 * so the authoritative overlay survives the filter in both modes.
 */
export async function captureShellEnv(
  mode: EnvSyncMode,
  opts: { sourceShell?: boolean; fallbackEnv?: NodeJS.ProcessEnv; deps?: Partial<ShellEnvDeps> } = {},
): Promise<Record<string, string>> {
  return captureEnv(mode, await resolveSourceEnv(opts));
}
