import { Command } from 'commander';
import { join } from 'path';
import { existsSync } from 'fs';
import { AuthManager } from '@newio/agent-sdk';
import { FileAgentConfigManager } from '@newio/agent-engine';
import type { AgentRuntimeStatus } from '@newio/agent-engine';
import { DaemonClient } from '../client.js';
import { DaemonConnector } from '../connector.js';
import { connectOrExit, resolveAgent, getDataDir, getApiBaseUrl } from './utils.js';

function statusIcon(status: AgentRuntimeStatus): string {
  switch (status) {
    case 'running':
      return '●';
    case 'error':
      return '✗';
    case 'stopped':
      return '○';
    default:
      return '◌';
  }
}

export function agentCommands(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .description('List agents and their status')
    .action(async () => {
      const connector = await connectOrExit();
      const agents = await connector.listAgents();
      connector.disconnect();

      if (agents.length === 0) {
        console.log('No agents configured.');
        return;
      }

      for (const a of agents) {
        const name = a.config.newio?.displayName ?? a.id;
        const username = a.config.newio?.username ? `@${a.config.newio.username}` : '';
        const error = a.error ? `  (${a.error})` : '';
        console.log(
          `${statusIcon(a.runtimeStatus)}  ${name}${username ? '  ' + username : ''}  ${a.runtimeStatus}${error}`,
        );
      }
    });

  program
    .command('start <name>')
    .description('Start a stopped agent')
    .action(async (name: string) => {
      const connector = await connectOrExit();
      const agents = await connector.listAgents();
      const agent = resolveAgent(agents, name);
      await connector.startAgent(agent.id);
      connector.disconnect();
      console.log(`Starting ${agent.config.newio?.displayName ?? agent.id}...`);
    });

  program
    .command('stop <name>')
    .description('Stop a running agent')
    .action(async (name: string) => {
      const connector = await connectOrExit();
      const agents = await connector.listAgents();
      const agent = resolveAgent(agents, name);
      await connector.stopAgent(agent.id);
      connector.disconnect();
      console.log(`Stopped ${agent.config.newio?.displayName ?? agent.id}.`);
    });

  program
    .command('restart <name>')
    .description('Restart an agent')
    .action(async (name: string) => {
      const connector = await connectOrExit();
      const agents = await connector.listAgents();
      const agent = resolveAgent(agents, name);
      await connector.stopAgent(agent.id);
      await connector.startAgent(agent.id);
      connector.disconnect();
      console.log(`Restarted ${agent.config.newio?.displayName ?? agent.id}.`);
    });

  program
    .command('login <name>')
    .description('Authenticate an agent (register new or re-login existing)')
    .action(async (name: string) => {
      const dataDir = getDataDir();
      const configManager = new FileAgentConfigManager(dataDir);
      const agents = configManager.list();

      // Find existing agent by name
      const matches = agents.filter(
        (a) =>
          a.id === name ||
          a.newio?.displayName?.toLowerCase() === name.toLowerCase() ||
          a.newio?.username?.toLowerCase() === name.toLowerCase(),
      );

      if (matches.length > 1) {
        console.error(`Error: "${name}" matches multiple agents. Use the UUID instead.`);
        process.exit(1);
      }

      const auth = new AuthManager(getApiBaseUrl());
      let agentId: string;
      let handle: Awaited<ReturnType<typeof auth.register>>;

      if (matches.length === 1 && matches[0]?.newio?.agentId) {
        const existing = matches[0];
        if (existing.newio?.agentId) {
          // Re-login existing agent
          agentId = existing.id;
          console.log(`Logging in "${existing.newio.displayName ?? existing.id}"...`);
          handle = await auth.login({ agentId: existing.newio.agentId });
        } else {
          // Existing agent without agentId yet — register fresh
          agentId = existing.id;
          console.log(`Registering "${existing.newio?.displayName ?? existing.id}"...`);
          handle = await auth.register({ name: existing.newio?.displayName ?? name });
        }
      } else {
        // Register new agent
        console.log(`Registering new agent "${name}"...`);
        handle = await auth.register({ name });
        agentId = handle.agentId;
        configManager.add({ displayName: name, type: 'custom' });
        const newAgent = configManager.list().find((a) => a.newio?.displayName === name);
        if (newAgent) agentId = newAgent.id;
      }

      console.log(`\nApprove this agent in the Newio app:\n  ${handle.approvalUrl}\n`);
      process.stdout.write('Waiting for approval');

      const tokens = await handle.waitForApproval({
        onPollAttempt: () => process.stdout.write('.'),
      });

      console.log('\n✓ Approved!');

      configManager.setTokens(agentId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });

      const agent = configManager.get(agentId);
      if (agent) {
        configManager.setNewioIdentity(agentId, { ...agent.newio, agentId: handle.agentId });
      }

      auth.dispose();

      // Reload daemon if running so it picks up the new tokens
      const socketPath = join(dataDir, 'daemon.sock');
      if (existsSync(socketPath)) {
        try {
          const connector = new DaemonConnector(new DaemonClient());
          await connector.connect(socketPath);
          await connector.reload();
          connector.disconnect();
        } catch {
          /* daemon not reachable — user can reload manually */
        }
      }

      console.log(`Agent "${name}" is authenticated. Run: newio start ${name}`);
    });

  program
    .command('logs <name>')
    .description('Stream agent status events')
    .option('-f, --follow', 'Keep streaming (default: show current status and exit)')
    .action(async (name: string, opts: { follow?: boolean }) => {
      const connector = await connectOrExit();
      const agents = await connector.listAgents();
      const agent = resolveAgent(agents, name);
      const displayName = agent.config.newio?.displayName ?? agent.id;

      console.log(`${displayName}  ${agent.runtimeStatus}${agent.error ? '  ' + agent.error : ''}`);

      if (!opts.follow) {
        connector.disconnect();
        return;
      }

      connector.disconnect();

      const socketPath = join(getDataDir(), 'daemon.sock');
      const streaming = new DaemonConnector(new DaemonClient());
      await streaming.connect(socketPath, {
        onStatusChanged(agentId, status, error) {
          if (agentId === agent.id) {
            const ts = new Date().toISOString();
            console.log(`${ts}  ${status}${error ? '  ' + error : ''}`);
          }
        },
      });

      process.on('SIGINT', () => {
        streaming.disconnect();
        process.exit(0);
      });
    });
}
