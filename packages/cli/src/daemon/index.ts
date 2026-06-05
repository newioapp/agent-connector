#!/usr/bin/env node
/**
 * newio-connectord — Newio Agent Connector daemon.
 *
 * Starts the agent engine and exposes a JSON-RPC 2.0 API over a Unix domain socket.
 * Managed by the OS service manager (systemctl/launchctl) or spawned directly.
 */
import { join } from 'path';
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { createRequire } from 'module';
import { setLogHandler, getLogger } from '@newio/agent-sdk';
import {
  FileAgentConfigManager,
  AgentRuntimeManager,
  JsonCronStore,
  type EngineConfig,
  type StatusListener,
} from '@newio/agent-engine';
import { DaemonServer } from './server.js';
import { DaemonHandler } from './handler.js';
import { version } from '../../package.json';

const log = getLogger('daemon');

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const stage = (process.env['NEWIO_STAGE'] ?? 'prod') as EngineConfig['stage'];
const apiBaseUrl = process.env['NEWIO_API_URL'] ?? 'https://api.newio.app';
const wsUrl = process.env['NEWIO_WS_URL'] ?? 'wss://ws.newio.app';

const homeDir = stage === 'prod' ? '.newio' : `.newio-${stage}`;
const dataDir = join(homedir(), homeDir, 'connector');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

const socketPath = join(dataDir, 'daemon.sock');
const pidPath = join(dataDir, 'daemon.pid');

const require = createRequire(import.meta.url);
const mcpBridgePath = require.resolve('@newio/agent-engine/mcp-bridge');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
  }
  writeFileSync(pidPath, String(process.pid), 'utf8');

  const engineConfig: EngineConfig = {
    apiBaseUrl,
    wsUrl,
    stage,
    appDisplayName: 'Newio Connector Daemon',
    appVersion: version,
    dataDir,
    mcpBridgePath,
  };

  const agentConfigManager = new FileAgentConfigManager(dataDir);
  const cronStore = new JsonCronStore(join(dataDir, 'cron.json'));

  // Runtime manager is recreated on reload; handler holds a mutable reference.
  const makeListener = (_handler: DaemonHandler): StatusListener => ({
    onStatusChanged(agentId, status, error) {
      server.notify('agent.statusChanged', { agentId, status, error });
    },
    onApprovalUrl(agentId, approvalUrl) {
      server.notify('agent.approvalUrl', { agentId, approvalUrl });
    },
    onPollAttempt(agentId) {
      server.notify('agent.pollAttempt', { agentId });
    },
    onConfigUpdated(agentId) {
      const config = agentConfigManager.get(agentId);
      if (config) server.notify('agent.configUpdated', { agentId, config });
    },
    onAgentInfo(agentId, info) {
      server.notify('agent.acpInfo', { agentId, info });
    },
  });

  const handler = new DaemonHandler({
    agentConfigManager,
    agentRuntimeManager: new AgentRuntimeManager(agentConfigManager, cronStore, {} as StatusListener, engineConfig),
    version,
    onReload: async () => {
      log.info('Reloading...');
      // Capture which agents were running
      const running = agentConfigManager
        .list()
        .filter((c) => {
          const { status } = handler.deps.agentRuntimeManager.getStatus(c.id);
          return status !== 'stopped' && status !== 'error';
        })
        .map((c) => c.id);

      await handler.deps.agentRuntimeManager.stopAll();

      handler.deps.agentRuntimeManager = new AgentRuntimeManager(
        agentConfigManager,
        cronStore,
        makeListener(handler),
        engineConfig,
      );

      for (const id of running) {
        try {
          handler.deps.agentRuntimeManager.start(id);
        } catch (e) {
          log.warn(`Failed to restart agent ${id} after reload`, e);
        }
      }
      log.info('Reload complete');
    },
    onStop: async () => {
      log.info('Stop requested');
      await shutdown();
    },
  });

  // Wire the real listener now that handler exists
  handler.deps.agentRuntimeManager = new AgentRuntimeManager(
    agentConfigManager,
    cronStore,
    makeListener(handler),
    engineConfig,
  );

  const server = new DaemonServer(handler);
  await server.listen(socketPath);
  log.info(`newio-connectord ${version} started (pid ${process.pid})`);

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down...');
    await handler.deps.agentRuntimeManager.stopAll();
    cronStore.close();
    await server.close();
    try {
      unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    log.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

setLogHandler((level, name, message, args) => {
  const prefix = `[${name}]`;
  if (level === 'error') console.error(prefix, message, ...args);
  else if (level === 'warn') console.warn(prefix, message, ...args);
  else console.log(prefix, message, ...args);
});

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
