/**
 * Client-side CLI commands — talk to the daemon over its Unix socket.
 *
 * Kept separate from the dispatcher so the heavy daemon dependency graph is
 * never imported on the client path (see cli/index.ts).
 *
 * NOTE: command bodies are implemented in a follow-up; this currently routes
 * and prints usage.
 */

const USAGE = `newio — Newio Agent Connector

Daemon:
  newio daemon start [--no-enable]   Install + enable the service and start it
  newio daemon stop                  Stop the service
  newio daemon restart               Restart the service
  newio daemon status                Show service + agent status
  newio daemon logs [-f]             Tail daemon logs
  newio daemon reload                Hot-reload config
  newio daemon uninstall             Remove the service unit

Agents:
  newio agent list                   List agents with runtime status
  newio agent add                    Add an agent
  newio agent remove <id>            Stop and remove an agent
  newio agent start <id>             Start an agent
  newio agent stop <id>              Stop an agent
  newio agent restart <id>           Restart an agent
  newio agent info <id>              Show agent capabilities / auth info
  newio agent update <id> [...]      Update agent config

Environment:
  newio agent env list <id>          Show an agent's env vars
  newio agent env set <id> K=V...    Set/override env vars
  newio agent env unset <id> K...    Remove env vars
  newio agent env sync <id> [--shell]Resolve env from the login shell
  newio env shells                   List available login shells

Other:
  newio status                       Daemon + agents overview
  newio version                      Print CLI version
`;

const KNOWN_GROUPS = new Set(['daemon', 'agent', 'env', 'status']);

// eslint-disable-next-line @typescript-eslint/require-await -- stub; command bodies (async DaemonConnector calls) land in a follow-up
export async function runClientCommand(command: string | undefined, _args: string[]): Promise<void> {
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  if (!KNOWN_GROUPS.has(command)) {
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  // TODO(cli): implement the daemon/agent/env command bodies (auto-spawn,
  // DaemonConnector calls, notification streaming).
  console.error(`'${command}' is not implemented yet.`);
  process.exitCode = 1;
}
