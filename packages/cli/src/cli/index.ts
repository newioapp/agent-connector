#!/usr/bin/env node
/**
 * `newio` — single binary for the Newio Agent Connector.
 *
 * Built on commander. The client commands (daemon/agent/env) are wired here;
 * the daemon foreground process (`daemon run`) is lazily imported so its heavy
 * dependency graph (agent engine / ACP / MCP) never loads on the client path.
 *
 * Stage + backend URLs are resolved from the environment (`resolveConfig`), not
 * from CLI flags — they're internal testing knobs and stay off the public CLI
 * surface. End users always resolve to `prod`.
 */
import { Command, Option } from 'commander';
import { resolveConfig, getDaemonPaths } from '../paths.js';
import { version } from '../../package.json';
import * as daemon from './daemon-commands.js';
import * as agent from './agent-commands.js';
import type { AddOptions, CreateAccountOptions, UpdateOptions } from './agent-commands.js';
import * as updater from './update-commands.js';
import type { UpdateContext } from './update-commands.js';

// Resolved once at startup from NEWIO_STAGE / NEWIO_API_URL / NEWIO_WS_URL / NEWIO_CDN_URL.
const { stage, cdnBaseUrl } = resolveConfig();

// Everything the self-updater needs: which channel (CDN) to check, the running
// version, and where to cache the once-per-day result for this stage.
const updateContext: UpdateContext = {
  stage,
  cdnBaseUrl,
  currentVersion: version,
  cachePath: getDaemonPaths(stage).updateCachePath,
  argv0: process.argv[1] ?? process.argv0,
};

const program = new Command();
program
  .name('newio')
  .description('Newio Agent Connector — headless agent management')
  .version(version, '-v, --version');

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------

const daemonCmd = program.command('daemon').description('Manage the daemon service');

daemonCmd
  .command('run')
  .description('Run the daemon in the foreground (used by the service unit)')
  .action(async () => {
    const { runDaemon } = await import('../daemon/index.js');
    await runDaemon();
  });

daemonCmd
  .command('start')
  .description('Install and start the daemon service')
  .option('--no-enable', 'do not start on login/boot')
  .action((_options: unknown, cmd: Command) => {
    const o = cmd.opts<{ enable: boolean }>();
    daemon.daemonStart({ stage, enable: o.enable });
  });

daemonCmd
  .command('stop')
  .description('Stop the daemon')
  .action(() => daemon.daemonStop(stage));

daemonCmd
  .command('restart')
  .description('Restart the daemon')
  .action(() => daemon.daemonRestart(stage));

daemonCmd
  .command('status')
  .description('Show daemon status')
  .action(() => daemon.daemonStatus(stage));

daemonCmd
  .command('logs')
  .description('Tail daemon logs')
  .option('-f, --follow', 'follow the log stream', false)
  .option('-n, --lines <n>', 'number of lines to show', '50')
  .action((_options: unknown, cmd: Command) => {
    const o = cmd.opts<{ follow: boolean; lines: string }>();
    daemon.daemonLogs(stage, { follow: o.follow, lines: Number(o.lines) || 50 });
  });

daemonCmd
  .command('reload')
  .description('Reload daemon config without restarting (RPC)')
  .action(() => daemon.daemonReload(stage));

daemonCmd
  .command('uninstall')
  .description('Stop and remove the daemon service')
  .action(() => daemon.daemonUninstall(stage));

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

const agentCmd = program.command('agent').description('Manage agents');

agentCmd
  .command('list')
  .description('List agents with runtime status')
  .action(() => agent.agentList(stage));

agentCmd
  .command('add')
  .description('Add a runner config for an existing Newio agent account')
  .addOption(new Option('--type <type>', 'agent type').choices([...agent.AGENT_TYPE_CHOICES]).makeOptionMandatory())
  .requiredOption('--username <username>', 'Newio agent username (run "newio agent create-account" to make one)')
  .option('--cwd <dir>', 'working directory for the agent process')
  .option(
    '--exec <command>',
    'ACP executable to spawn, optionally with args (legacy; whitespace-split — prefer --command/--arg for paths with spaces). For --type custom it is the full invocation; for built-in types it overrides the binary and extra args are appended, e.g. --exec "/opt/bin/codex-acp" or --exec "node wrapper.js"',
  )
  .option(
    '--command <path>',
    'ACP executable path — path-safe alternative to --exec (takes precedence). Combine with --arg.',
  )
  .option(
    '--arg <value>',
    'argument for --command; repeat for multiple args, e.g. --command node --arg /path/to/agent.js',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .addOption(
    new Option('--session-mode <mode>', agent.SESSION_MODE_DESCRIPTION).choices([...agent.SESSION_MODE_CHOICES]),
  )
  // The agent subprocess runs with exactly the environment synced here — PATH (to
  // find node + the agent binary), USER (Claude Code keys its Keychain credential
  // by it), API keys, etc. Captured from this CLI's own environment.
  .addOption(
    new Option('--env-sync <mode>', 'environment to sync into the agent, captured from this shell')
      .choices([...agent.ENV_SYNC_MODES])
      .default('basic'),
  )
  .action((_options: unknown, cmd: Command) => agent.agentAdd(stage, cmd.opts<AddOptions>()));

agentCmd
  .command('create-account')
  .description('Register a new Newio agent account (username chosen at approval)')
  .requiredOption('--name <name>', 'display name for the new account')
  .action((_options: unknown, cmd: Command) => agent.agentCreateAccount(cmd.opts<CreateAccountOptions>()));

agentCmd
  .command('remove <agent>')
  .description('Stop and remove an agent')
  .action((query: string) => agent.agentRemove(stage, query));

agentCmd
  .command('start <agent>')
  .description('Start an agent (streams approval + status)')
  .action((query: string) => agent.agentStart(stage, query));

agentCmd
  .command('stop <agent>')
  .description('Stop an agent')
  .action((query: string) => agent.agentStop(stage, query));

agentCmd
  .command('restart <agent>')
  .description('Restart an agent')
  .action((query: string) => agent.agentRestart(stage, query));

agentCmd
  .command('info <agent>')
  .description('Show agent capabilities / auth info')
  .action((query: string) => agent.agentInfo(stage, query));

agentCmd
  .command('update <agent>')
  .description('Update agent config')
  .option('--name <name>', 'display name')
  .option('--cwd <dir>', 'working directory')
  .option('--exec <command>', 'ACP executable to spawn, optionally with args (overrides the default binary)')
  .option('--username <username>', 'Newio username')
  .addOption(
    new Option('--session-mode <mode>', agent.SESSION_MODE_DESCRIPTION).choices([...agent.SESSION_MODE_CHOICES]),
  )
  .action((query: string, _options: unknown, cmd: Command) =>
    agent.agentUpdate(stage, query, cmd.opts<UpdateOptions>()),
  );

// agent env subgroup
const envCmd = agentCmd.command('env').description("Manage an agent's environment variables");

envCmd
  .command('list <agent>')
  .description('Show env vars')
  .action((query: string) => agent.envList(stage, query));

envCmd
  .command('set <agent> <pairs...>')
  .description('Set KEY=VALUE env vars')
  .action((query: string, pairs: string[]) => agent.envSet(stage, query, pairs));

envCmd
  .command('unset <agent> <keys...>')
  .description('Remove env vars by key')
  .action((query: string, keys: string[]) => agent.envUnset(stage, query, keys));

envCmd
  .command('sync <agent>')
  .description("Capture env from this shell and replace the agent's environment")
  .addOption(
    new Option('--mode <mode>', 'which variables to capture').choices([...agent.ENV_SYNC_MODES]).default('basic'),
  )
  .action((query: string, _options: unknown, cmd: Command) =>
    agent.envSync(stage, query, cmd.opts<{ mode?: string }>().mode),
  );

envCmd
  .command('edit <agent>')
  .description('Open the agent env file in $VISUAL/$EDITOR')
  .action((query: string) => agent.envEdit(stage, query));

// ---------------------------------------------------------------------------
// top-level
// ---------------------------------------------------------------------------

const topEnvCmd = program.command('env').description('Environment helpers');

topEnvCmd
  .command('print [mode]')
  .description('Print what an env-sync mode (basic|all) would capture from this shell')
  .action((mode: string | undefined) => agent.envPrint(mode));

program
  .command('status')
  .description('Daemon health + agent overview')
  .action(() => agent.status(stage));

program
  .command('update')
  .description('Check for a newer newio release and install it')
  .option('--check', 'only report whether an update is available; do not install')
  .option('-y, --yes', 'install without prompting for confirmation')
  .action((_options: unknown, cmd: Command) =>
    updater.update(updateContext, cmd.opts<{ check?: boolean; yes?: boolean }>()),
  );

// Internal: the MCP stdio↔UDS bridge an ACP agent spawns as its MCP server.
// Launched by the daemon as `node <cli-entry> mcp-bridge <socket>` (never by a
// user), so it stays dependency-free and off the documented surface.
program
  .command('mcp-bridge <socketPath>', { hidden: true })
  .description('Relay an MCP stdio server to the daemon Unix socket (internal)')
  .action(async (socketPath: string) => {
    const { runMcpBridge } = await import('./mcp-bridge.js');
    runMcpBridge(socketPath);
  });

// `mcp-bridge` is an internal stdio relay — its stdout is the MCP transport, so
// it must never emit an update notice. Everything else gets the passive,
// once-per-day reminder after the command completes (TTY-gated inside).
const isInternalBridge = process.argv[2] === 'mcp-bridge';

program
  .parseAsync(process.argv)
  .then(async () => {
    if (!isInternalBridge) {
      await updater.notifyIfUpdateAvailable(updateContext);
    }
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
