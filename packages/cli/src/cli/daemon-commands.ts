/**
 * `newio daemon …` handlers — manage the daemon via the OS service manager.
 *
 * These only need the service manager (fs + launchctl/systemctl), not the
 * daemon RPC socket — except `reload`, which sends an RPC to the running daemon.
 */
import { realpathSync } from 'fs';
import { getDaemonPaths, resolveConfig, type Stage } from '../paths.js';
import { createServiceManager, type InstallOptions, type ServiceStatus } from '../service/index.js';
import { withDaemon } from '../client/connect.js';

export interface DaemonStartOptions {
  readonly stage: Stage;
  readonly enable: boolean;
}

/** Build the install options (node/cli paths + baked environment) for a stage. */
function resolveInstallOptions(opts: DaemonStartOptions): InstallOptions {
  // Resolve the fully-formed URLs (from env, or stage defaults) and bake them
  // into the unit so the service is self-contained even if defaults change.
  const { apiBaseUrl, wsUrl } = resolveConfig();
  const { logPath } = getDaemonPaths(opts.stage);

  const env: Record<string, string> = {
    NEWIO_STAGE: opts.stage,
    NEWIO_API_URL: apiBaseUrl,
    NEWIO_WS_URL: wsUrl,
  };
  // The daemon resolves agent shell environments from $HOME and needs a PATH;
  // bake the current values so the service environment matches the user's.
  if (typeof process.env['HOME'] === 'string') {
    env['HOME'] = process.env['HOME'];
  }
  if (typeof process.env['PATH'] === 'string') {
    env['PATH'] = process.env['PATH'];
  }

  return {
    nodePath: process.execPath,
    // argv[1] is the CLI entry node was invoked with; resolve symlinks (npm bin).
    cliEntryPath: realpathSync(process.argv[1] ?? ''),
    env,
    logPath,
    enable: opts.enable,
  };
}

function describeStatus(stage: Stage, status: ServiceStatus): string {
  const prefix = `newio daemon (${stage}):`;
  switch (status.state) {
    case 'not-installed':
      return `${prefix} not installed`;
    case 'stopped':
      return `${prefix} stopped${status.enabled ? ' (enabled)' : ''}`;
    case 'running': {
      const bits = [status.pid ? `pid ${status.pid}` : undefined, status.enabled ? 'enabled' : undefined].filter(
        (b): b is string => b !== undefined,
      );
      return `${prefix} running${bits.length ? ` (${bits.join(', ')})` : ''}`;
    }
  }
}

export function daemonStart(opts: DaemonStartOptions): void {
  const service = createServiceManager(opts.stage);
  service.install(resolveInstallOptions(opts));
  console.log(describeStatus(opts.stage, service.status()));
  const envPrefix = opts.stage === 'prod' ? '' : `NEWIO_STAGE=${opts.stage} `;
  console.log(`Logs: ${envPrefix}newio daemon logs -f`);
}

export function daemonStop(stage: Stage): void {
  createServiceManager(stage).stop();
  console.log(`Stopped newio daemon (${stage}).`);
}

export function daemonRestart(stage: Stage): void {
  const service = createServiceManager(stage);
  if (!service.isInstalled()) {
    throw new Error(`Daemon (${stage}) is not installed. Run \`newio daemon start\` first.`);
  }
  service.restart();
  console.log(describeStatus(stage, service.status()));
}

export function daemonStatus(stage: Stage): void {
  console.log(describeStatus(stage, createServiceManager(stage).status()));
}

export function daemonLogs(stage: Stage, opts: { follow: boolean; lines: number }): void {
  createServiceManager(stage).logs(opts);
}

export function daemonUninstall(stage: Stage): void {
  createServiceManager(stage).uninstall();
  console.log(`Uninstalled newio daemon (${stage}).`);
}

export async function daemonReload(stage: Stage): Promise<void> {
  await withDaemon(stage, (c) => c.reload());
  console.log(`Reloaded newio daemon (${stage}).`);
}
