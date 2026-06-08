/**
 * Environment capture for agent processes.
 *
 * Both modes read from a given environment (defaulting to the CURRENT process's
 * own environment) — captured client-side by whichever process configures the
 * agent: the CLI's interactive shell, or the desktop app's process. The daemon
 * never sources a login shell; its own service environment is sparse.
 */

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
/** Never captured, in either mode: cwd-derived vars — the agent's cwd is set explicitly. */
const EXCLUDED_ENV_KEYS = new Set(['PWD', 'OLDPWD']);

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
