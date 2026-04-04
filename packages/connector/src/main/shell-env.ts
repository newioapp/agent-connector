/**
 * Resolve environment variables from the user's login shell.
 *
 * Electron apps launched from the macOS Dock inherit a minimal environment
 * (/usr/bin:/bin). This module spawns the user's shell in interactive login
 * mode and captures the full environment, including PATH additions from
 * .zshrc, .bashrc, nvm, homebrew, etc.
 */
import { execFile } from 'child_process';
import { readFileSync } from 'fs';

/** Shells we know how to invoke with `-ilc`. */
const SUPPORTED_SHELLS = new Set([
  '/bin/zsh',
  '/bin/bash',
  '/usr/bin/zsh',
  '/usr/bin/bash',
  '/opt/homebrew/bin/bash',
  '/opt/homebrew/bin/zsh',
]);

/** Cached results keyed by shell path. */
const cache = new Map<string, Record<string, string>>();

/**
 * List shells installed on the system that we support.
 * Reads /etc/shells and filters to known-supported entries.
 */
export function listAvailableShells(): string[] {
  try {
    const content = readFileSync('/etc/shells', 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && SUPPORTED_SHELLS.has(line));
  } catch {
    // Fallback: just check the user's default shell
    const defaultShell = process.env.SHELL ?? '/bin/zsh';
    return SUPPORTED_SHELLS.has(defaultShell) ? [defaultShell] : ['/bin/zsh'];
  }
}

/**
 * Get environment variables from a specific shell.
 * Results are cached per shell path for the lifetime of the process.
 */
export async function getShellEnv(shell?: string): Promise<Record<string, string>> {
  const shellPath = shell ?? process.env.SHELL ?? '/bin/zsh';

  const cached = cache.get(shellPath);
  if (cached) {
    return cached;
  }

  const env = await resolveFromShell(shellPath);
  cache.set(shellPath, env);
  return env;
}

function resolveFromShell(shell: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', 'env -0'], { encoding: 'utf8', timeout: 10_000, env: { TERM: 'dumb' } }, (err, stdout) => {
      if (err || !stdout) {
        resolve(
          Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
        );
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
