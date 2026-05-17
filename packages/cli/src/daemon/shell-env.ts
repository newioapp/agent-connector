/**
 * Resolve environment variables from the user's login shell.
 */
import { execFile } from 'child_process';
import { readFileSync } from 'fs';

const SUPPORTED_SHELL_NAMES = new Set(['zsh', 'bash']);
export const ENVIRONMENT_SOURCE = 'environment';

export function listAvailableShells(): string[] {
  try {
    const content = readFileSync('/etc/shells', 'utf8');
    const shells = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (line.length === 0 || line.startsWith('#')) return false;
        const basename = line.split('/').pop() ?? '';
        return SUPPORTED_SHELL_NAMES.has(basename);
      });
    return shells.length > 0 ? shells : [ENVIRONMENT_SOURCE];
  } catch {
    return [ENVIRONMENT_SOURCE];
  }
}

export async function getShellEnv(shell: string): Promise<Record<string, string>> {
  if (shell === ENVIRONMENT_SOURCE) {
    return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  }
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', 'env -0'], { encoding: 'utf8', timeout: 10_000, env: { TERM: 'dumb' } }, (err, stdout) => {
      if (err || !stdout) {
        resolve({});
        return;
      }
      const env: Record<string, string> = {};
      for (const entry of stdout.split('\0')) {
        const idx = entry.indexOf('=');
        if (idx > 0) env[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
      resolve(env);
    });
  });
}
