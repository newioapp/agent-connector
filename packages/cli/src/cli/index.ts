#!/usr/bin/env node
/**
 * `newio` — single binary for the Newio Agent Connector.
 *
 * Dispatches between two roles:
 *   - `newio daemon run`  → the long-lived daemon process (heavy deps: agent
 *     engine, ACP, MCP). Lazily imported so it never loads on the client path.
 *   - everything else      → thin client commands that talk to the daemon over
 *     its Unix socket (net-only, stays lightweight).
 */
import { version } from '../../package.json';

async function main(): Promise<void> {
  const [command, sub, ...rest] = process.argv.slice(2);

  // Daemon foreground process — what the service unit (or auto-spawn) executes.
  if (command === 'daemon' && sub === 'run') {
    const { runDaemon } = await import('../daemon/index.js');
    await runDaemon();
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(version);
    return;
  }

  // All other commands run as a client against the daemon. Kept behind a dynamic
  // import so the daemon's heavy dependency graph never loads here.
  const { runClientCommand } = await import('./client-commands.js');
  await runClientCommand(
    command,
    [sub, ...rest].filter((a): a is string => a !== undefined),
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
