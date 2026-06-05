#!/usr/bin/env node
/**
 * `newio` — single binary for the Newio Agent Connector.
 *
 * Built on commander. The client commands (daemon/agent/env) are wired here;
 * the daemon foreground process (`daemon run`) is lazily imported so its heavy
 * dependency graph (agent engine / ACP / MCP) never loads on the client path.
 */
import { Command, Option } from 'commander';
import { resolveStage, type Stage } from '../paths.js';
import { version } from '../../package.json';
import * as daemon from './daemon-commands.js';
import * as agent from './agent-commands.js';
import type { AddOptions, UpdateOptions } from './agent-commands.js';

/** Resolve the target stage from the global --stage option (or NEWIO_STAGE). */
function stageOf(cmd: Command): Stage {
  const { stage } = cmd.optsWithGlobals<{ stage?: string }>();
  return resolveStage(stage ?? process.env['NEWIO_STAGE']);
}

const program = new Command();
program
  .name('newio')
  .description('Newio Agent Connector — headless agent management')
  .version(version, '-v, --version')
  .option('--stage <stage>', 'deployment stage (dev|integ|prod)');

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
  .option('--api-url <url>', 'override the Newio API URL')
  .option('--ws-url <url>', 'override the Newio WebSocket URL')
  .action((_options: unknown, cmd: Command) => {
    const o = cmd.opts<{ enable: boolean; apiUrl?: string; wsUrl?: string }>();
    daemon.daemonStart({ stage: stageOf(cmd), enable: o.enable, apiUrl: o.apiUrl, wsUrl: o.wsUrl });
  });

daemonCmd
  .command('stop')
  .description('Stop the daemon')
  .action((_options: unknown, cmd: Command) => daemon.daemonStop(stageOf(cmd)));

daemonCmd
  .command('restart')
  .description('Restart the daemon')
  .action((_options: unknown, cmd: Command) => daemon.daemonRestart(stageOf(cmd)));

daemonCmd
  .command('status')
  .description('Show daemon status')
  .action((_options: unknown, cmd: Command) => daemon.daemonStatus(stageOf(cmd)));

daemonCmd
  .command('logs')
  .description('Tail daemon logs')
  .option('-f, --follow', 'follow the log stream', false)
  .option('-n, --lines <n>', 'number of lines to show', '50')
  .action((_options: unknown, cmd: Command) => {
    const o = cmd.opts<{ follow: boolean; lines: string }>();
    daemon.daemonLogs(stageOf(cmd), { follow: o.follow, lines: Number(o.lines) || 50 });
  });

daemonCmd
  .command('reload')
  .description('Reload daemon config without restarting (RPC)')
  .action((_options: unknown, cmd: Command) => daemon.daemonReload(stageOf(cmd)));

daemonCmd
  .command('uninstall')
  .description('Stop and remove the daemon service')
  .action((_options: unknown, cmd: Command) => daemon.daemonUninstall(stageOf(cmd)));

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

const agentCmd = program.command('agent').description('Manage agents');

agentCmd
  .command('list')
  .description('List agents with runtime status')
  .action((_options: unknown, cmd: Command) => agent.agentList(stageOf(cmd)));

agentCmd
  .command('add')
  .description('Add an agent')
  .addOption(new Option('--type <type>', 'agent type').choices([...agent.AGENT_TYPE_CHOICES]).makeOptionMandatory())
  .requiredOption('--name <name>', 'display name')
  .option('--cwd <dir>', 'working directory for the agent process')
  .option('--username <username>', 'existing Newio username to log in as')
  .addOption(new Option('--session-mode <mode>', 'session mode').choices([...agent.SESSION_MODE_CHOICES]))
  .action((_options: unknown, cmd: Command) => agent.agentAdd(stageOf(cmd), cmd.opts<AddOptions>()));

agentCmd
  .command('remove <agent>')
  .description('Stop and remove an agent')
  .action((query: string, _options: unknown, cmd: Command) => agent.agentRemove(stageOf(cmd), query));

agentCmd
  .command('start <agent>')
  .description('Start an agent (streams approval + status)')
  .action((query: string, _options: unknown, cmd: Command) => agent.agentStart(stageOf(cmd), query));

agentCmd
  .command('stop <agent>')
  .description('Stop an agent')
  .action((query: string, _options: unknown, cmd: Command) => agent.agentStop(stageOf(cmd), query));

agentCmd
  .command('restart <agent>')
  .description('Restart an agent')
  .action((query: string, _options: unknown, cmd: Command) => agent.agentRestart(stageOf(cmd), query));

agentCmd
  .command('info <agent>')
  .description('Show agent capabilities / auth info')
  .action((query: string, _options: unknown, cmd: Command) => agent.agentInfo(stageOf(cmd), query));

agentCmd
  .command('update <agent>')
  .description('Update agent config')
  .option('--name <name>', 'display name')
  .option('--cwd <dir>', 'working directory')
  .option('--username <username>', 'Newio username')
  .addOption(new Option('--session-mode <mode>', 'session mode').choices([...agent.SESSION_MODE_CHOICES]))
  .action((query: string, _options: unknown, cmd: Command) =>
    agent.agentUpdate(stageOf(cmd), query, cmd.opts<UpdateOptions>()),
  );

// agent env subgroup
const envCmd = agentCmd.command('env').description("Manage an agent's environment variables");

envCmd
  .command('list <agent>')
  .description('Show env vars')
  .action((query: string, _options: unknown, cmd: Command) => agent.envList(stageOf(cmd), query));

envCmd
  .command('set <agent> <pairs...>')
  .description('Set KEY=VALUE env vars')
  .action((query: string, pairs: string[], _options: unknown, cmd: Command) =>
    agent.envSet(stageOf(cmd), query, pairs),
  );

envCmd
  .command('unset <agent> <keys...>')
  .description('Remove env vars by key')
  .action((query: string, keys: string[], _options: unknown, cmd: Command) =>
    agent.envUnset(stageOf(cmd), query, keys),
  );

envCmd
  .command('sync <agent>')
  .description('Resolve env from the login shell')
  .option('--shell <shell>', 'shell to resolve from (defaults to the first available)')
  .action((query: string, _options: unknown, cmd: Command) =>
    agent.envSync(stageOf(cmd), query, cmd.opts<{ shell?: string }>().shell),
  );

// ---------------------------------------------------------------------------
// top-level
// ---------------------------------------------------------------------------

program
  .command('env')
  .description('Environment helpers')
  .command('shells')
  .description('List available login shells')
  .action((_options: unknown, cmd: Command) => agent.envShells(stageOf(cmd)));

program
  .command('status')
  .description('Daemon health + agent overview')
  .action((_options: unknown, cmd: Command) => agent.status(stageOf(cmd)));

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
