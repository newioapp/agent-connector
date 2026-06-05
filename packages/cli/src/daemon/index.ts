/**
 * Newio Agent Connector daemon.
 *
 * Starts the agent engine and exposes a JSON-RPC 2.0 API over a Unix domain
 * socket. Invoked via `newio daemon run` (the foreground process that the OS
 * service manager — launchd/systemd — executes).
 */
import { join } from 'path';
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { createConnection } from 'net';
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
import { resolveStage, getDaemonPaths, getDefaultUrls } from '../paths.js';
import { version } from '../../package.json';

const log = getLogger('daemon');

/**
 * Probe whether a daemon is already listening on the socket. Returns true only
 * if a live process accepts a connection — a leftover socket file from a crashed
 * daemon reports false (and is safe to unlink).
 */
function isSocketAlive(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (alive: boolean): void => {
      socket.destroy();
      resolve(alive);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 1000);
  });
}

/**
 * Boot the daemon. Resolves config from the environment, sets up the agent
 * runtime, and serves JSON-RPC over the stage's Unix socket until SIGINT/SIGTERM.
 */
export async function runDaemon(): Promise<void> {
  setLogHandler((level, name, message, args) => {
    const prefix = `[${name}]`;
    if (level === 'error') {
      console.error(prefix, message, ...args);
    } else if (level === 'warn') {
      console.warn(prefix, message, ...args);
    } else {
      console.log(prefix, message, ...args);
    }
  });

  // Login-shell env resolution depends on $HOME; fail loudly if a service unit
  // launched us without it rather than silently producing empty agent envs.
  if (typeof process.env['HOME'] !== 'string' || process.env['HOME'].length === 0) {
    throw new Error('HOME is not set — the daemon cannot resolve agent shell environments.');
  }

  const stage = resolveStage(process.env['NEWIO_STAGE']);
  const defaults = getDefaultUrls(stage);
  const apiBaseUrl = process.env['NEWIO_API_URL'] ?? defaults.apiBaseUrl;
  const wsUrl = process.env['NEWIO_WS_URL'] ?? defaults.wsUrl;

  const { dataDir, socketPath, pidPath } = getDaemonPaths(stage);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  const require = createRequire(import.meta.url);
  const mcpBridgePath = require.resolve('@newio/agent-engine/mcp-bridge');

  // Refuse to start if another daemon already owns this stage's socket —
  // otherwise we'd unlink a live socket and become a second writer of dataDir.
  if (await isSocketAlive(socketPath)) {
    throw new Error(`A daemon is already running for stage ${stage} (socket ${socketPath}).`);
  }
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      /* ignore stale socket */
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
  const makeListener = (): StatusListener => ({
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
      if (config) {
        server.notify('agent.configUpdated', { agentId, config });
      }
    },
    onAgentInfo(agentId, info) {
      server.notify('agent.acpInfo', { agentId, info });
    },
  });

  const handler = new DaemonHandler({
    agentConfigManager,
    agentRuntimeManager: new AgentRuntimeManager(agentConfigManager, cronStore, makeListener(), engineConfig),
    version,
    onReload: async () => {
      log.info('Reloading...');
      // Capture which agents were running so we can restart them.
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
        makeListener(),
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

  const server = new DaemonServer(handler);
  await server.listen(socketPath);
  log.info(`newio daemon ${version} started (pid ${process.pid}, stage ${stage})`);

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info('Shutting down...');
    await handler.deps.agentRuntimeManager.stopAll();
    cronStore.close();
    await server.close();
    for (const path of [socketPath, pidPath]) {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
    log.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
