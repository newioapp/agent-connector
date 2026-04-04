/**
 * Resolve environment variables from the user's login shell.
 *
 * Spawns the specified shell in interactive login mode and captures the full
 * environment, including PATH additions from .zshrc, .bashrc, nvm, homebrew, etc.
 * Works on macOS and Linux (both use /etc/shells and `-ilc`).
 */
import { execFile } from 'child_process';
import { readFileSync } from 'fs';

/** Shells we know how to invoke with `-ilc`. */
const SUPPORTED_SHELL_NAMES = new Set(['zsh', 'bash']);

/** Cached results keyed by shell path. */
const cache = new Map<string, Record<string, string>>();

/**
 * List shells installed on the system that we support.
 * Reads /etc/shells and filters to shells whose basename is zsh or bash.
 * Returns empty array if /etc/shells doesn't exist (e.g. Windows).
 */
export function listAvailableShells(): string[] {
  try {
    const content = readFileSync('/etc/shells', 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (line.length === 0 || line.startsWith('#')) {
          return false;
        }
        const basename = line.split('/').pop() ?? '';
        return SUPPORTED_SHELL_NAMES.has(basename);
      });
  } catch {
    return [];
  }
}

/**
 * Get environment variables from a specific shell.
 * Results are cached per shell path for the lifetime of the process.
 */
export async function getShellEnv(shell: string): Promise<Record<string, string>> {
  const cached = cache.get(shell);
  if (cached) {
    return cached;
  }

  const env = await resolveFromShell(shell);
  cache.set(shell, env);
  return env;
}

function resolveFromShell(shell: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', 'env -0'], { encoding: 'utf8', timeout: 10_000, env: { TERM: 'dumb' } }, (err, stdout) => {
      if (err || !stdout) {
        resolve({});
        return;
      }

      const env: Record<string, string> = {};
      for (const entry of stdout.split('\0')) {
        const idx = entry.indexOf('=');
        if (idx > 0) {
          env[entry.slice(0, idx)] = entry.slice(idx + 1);
        }
      }
      resolve(env);
    });
  });
}
