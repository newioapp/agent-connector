/**
 * `newio auth …` — interactive Claude authentication.
 *
 * Runs the bundled claude-agent-acp login flow with the terminal attached
 * (stdio inherit), so the native `claude` OAuth flow drives directly. The
 * `@newio/agent-engine` import is lazy to keep its heavy dependency graph off the
 * light client path. Credentials are machine-wide and shared by all claude-code
 * agents — no daemon needed.
 */
import { spawn } from 'node:child_process';
import type { ClaudeAuthMethod } from '@newio/agent-engine';

export async function authClaude(method: ClaudeAuthMethod): Promise<void> {
  const { buildClaudeAuthCommand } = await import('@newio/agent-engine');
  const { command, args, env } = buildClaudeAuthCommand(method);

  const code = await new Promise<number>((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', (err) => {
      console.error(`Failed to start authentication: ${err.message}`);
      resolve(1);
    });
  });

  if (code !== 0) {
    process.exitCode = code;
  }
}
