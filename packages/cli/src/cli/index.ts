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
import { cliSubcommand } from '../sea.js';
import { version } from '../../package.json';
import * as daemon from './daemon-commands.js';
import * as agent from './agent-commands.js';
import type { AddOptions, CreateAccountOptions, UpdateOptions } from './agent-commands.js';
import * as updater from './update-commands.js';
import type { UpdateContext } from './update-commands.js';
import { LOG_LEVELS } from '../daemon/log-level.js';
import { commandPathOf, shouldEnforceVersionGate, enforceVersionGate } from './version-gate.js';
import type { VersionGateContext } from './version-gate.js';
import { resolvePlatform } from '../update/version-gate.js';

// Resolved once at startup from NEWIO_STAGE / NEWIO_API_URL / NEWIO_WS_URL / NEWIO_CDN_URL.
const { stage, apiBaseUrl, cdnBaseUrl } = resolveConfig();

// Everything the self-updater needs: which channel (CDN) to check, the running
// version, and where to cache the once-per-day result for this stage.
const updateContext: UpdateContext = {
  stage,
  cdnBaseUrl,
  currentVersion: version,
  cachePath: getDaemonPaths(stage).updateCachePath,
  // The launcher name, for stage-correct command hints (`newio` vs `newio-dev`).
  // Must be argv0 (the binary/launcher), NOT argv[1] — under a SEA argv[1] is the
  // first subcommand, which would drop the stage suffix. cliCommandName() maps a
  // non-`newio*` value (e.g. `node` when run from source) back to `newio`.
  argv0: process.argv0,
};

// Everything the per-command version gate needs: the backend to ask, the running
// version + platform to report, and where to cache the verdict for this stage.
const versionGateContext: VersionGateContext = {
  apiBaseUrl,
  currentVersion: version,
  platform: resolvePlatform(),
  cachePath: getDaemonPaths(stage).versionGateCachePath,
  argv0: process.argv0,
};

const program = new Command();
program
  .name('newio')
  .description('Newio Agent Connector — headless agent management')
  .version(version, '-v, --version');

// Client commands install no log handler: the SDK logger drops getLogger() calls
// when none is set, and a failed command surfaces through the top-level catch
// below (console.error). Only the daemon installs a handler (see runDaemon).

// Before any command's action, ask the backend whether this version may still
// operate (cached, fail-open). A forced update aborts here; deprecation warns.
// Skips the updater, the internal bridge, and daemon manage/inspect verbs so a
// forced-out connector can still recover. Running per-command (not once at daemon
// startup) is deliberate: the daemon launches once and rarely restarts, while
// users touch these commands constantly.
program.hook('preAction', async (_thisCommand, actionCommand) => {
  if (shouldEnforceVersionGate(commandPathOf(actionCommand))) {
    await enforceVersionGate(versionGateContext);
  }
});

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------

const daemonCmd = program.command('daemon').description('Manage the daemon service');

daemonCmd
  .command('run')
  .description('Run the daemon in the foreground')
  .addOption(new Option('--log-level <level>', 'daemon log verbosity (default: info)').choices([...LOG_LEVELS]))
  .action(async (_options: unknown, cmd: Command) => {
    const { logLevel } = cmd.opts<{ logLevel?: string }>();
    const { runDaemon } = await import('../daemon/index.js');
    await runDaemon({ logLevel });
  });

daemonCmd
  .command('start')
  .description('Install and start the daemon service')
  .option('--no-enable', 'do not start on login/boot')
  .addOption(new Option('--log-level <level>', 'daemon log verbosity (default: info)').choices([...LOG_LEVELS]))
  .action((_options: unknown, cmd: Command) => {
    const { enable, logLevel } = cmd.opts<{ enable: boolean; logLevel?: string }>();
    daemon.daemonStart({ stage, enable, logLevel });
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
  .command('create-account')
  .description('Register a new Newio agent account (username chosen at approval)')
  .requiredOption('--name <name>', 'display name for the new account')
  .action((_options: unknown, cmd: Command) => agent.agentCreateAccount(cmd.opts<CreateAccountOptions>()));

agentCmd
  .command('list')
  .description('List agents with runtime status')
  .action(() => agent.agentList(stage));

agentCmd
  .command('add')
  .description('Add an agent config')
  .addOption(new Option('--type <type>', 'agent type').choices([...agent.AGENT_TYPE_CHOICES]).makeOptionMandatory())
  .requiredOption('--username <username>', 'Newio agent username (run "newio agent create-account" to make one)')
  .option('--cwd <dir>', 'working directory for the agent process')
  .option(
    '--command <path>',
    'ACP executable to spawn. For --type custom it is the binary to run; for built-in types it overrides the default binary. Combine with --arg for arguments, e.g. --command node --arg /path/to/agent.js',
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
  .option('--command <path>', 'ACP executable to spawn (replaces the prior launch config; combine with --arg)')
  .option(
    '--arg <value>',
    'argument for --command; repeat for multiple args',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
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
// SEA-aware subcommand lookup: the bridge is argv[1] in a SEA, argv[2] otherwise.
const isInternalBridge = cliSubcommand() === 'mcp-bridge';

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
