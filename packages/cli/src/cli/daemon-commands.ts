/**
 * `newio daemon …` handlers — manage the daemon via the OS service manager.
 *
 * These only need the service manager (fs + launchctl/systemctl), not the
 * daemon RPC socket — except `reload`, which sends an RPC to the running daemon.
 */
import { getDaemonPaths, resolveConfig, stageSuffix, stageFromCommandName, type Stage } from '../paths.js';
import { createServiceManager, type InstallOptions, type ServiceStatus } from '../service/index.js';
import { withDaemon } from '../client/connect.js';
import { resolveSelfExec, resolveLauncherPath, cliCommandName } from '../sea.js';
import { parseLogLevel, DEFAULT_LOG_LEVEL } from '../daemon/log-level.js';

export interface DaemonStartOptions {
  readonly stage: Stage;
  readonly enable: boolean;
  /** Log verbosity from `--log-level`; baked into the service env, defaults to `info`. */
  readonly logLevel?: string;
}

/** Build the install options (service argv + baked environment) for a stage. */
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

  // Run the daemon via the same executable we're running as: the `newio` SEA
  // binary itself, or `node dist/cli.js`. SEA-aware so the unit never depends on
  // a system Node and is attributed to our signature on macOS.
  const { execPath, entryArgs } = resolveSelfExec();
  // For the SEA form, prefer the stable on-PATH launcher symlink over the
  // version-pinned real path so updates apply on the daemon's next start.
  const programExec = entryArgs.length === 0 ? resolveLauncherPath(execPath) : execPath;

  // Bake the resolved level into the service argv as `daemon run --log-level
  // <level>` — the same flag the user passed — so the service-launched daemon is
  // driven by the flag, not an env var. Validated by commander; falls back to
  // `info` when omitted.
  const logLevel = parseLogLevel(opts.logLevel) ?? DEFAULT_LOG_LEVEL;

  return {
    programArguments: [programExec, ...entryArgs, 'daemon', 'run', '--log-level', logLevel],
    env,
    logPath,
    enable: opts.enable,
  };
}

function describeStatus(stage: Stage, status: ServiceStatus): string {
  const prefix = `newio daemon${stageSuffix(stage)}:`;
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

/**
 * The `… daemon logs -f` command to print after install.
 *
 * `cmd` is the invoked command name (e.g. `newio` or `newio-dev`). It's prefixed
 * with `NEWIO_STAGE=<stage>` only when that command name wouldn't resolve to the
 * installed `stage` on its own — i.e. whenever the name's inferred stage differs
 * from the stage actually installed. That covers both the prod `newio` binary
 * driving a non-prod stage (`NEWIO_STAGE=dev newio …`) and a stage-named binary
 * driving a different stage (`NEWIO_STAGE=prod newio-dev …`), so the printed
 * command always targets the daemon that was just installed.
 */
export function daemonLogsHint(stage: Stage, cmd: string): string {
  const envPrefix = stageFromCommandName(cmd) === stage ? '' : `NEWIO_STAGE=${stage} `;
  return `${envPrefix}${cmd} daemon logs -f`;
}

export function daemonStart(opts: DaemonStartOptions): void {
  const service = createServiceManager(opts.stage);
  service.install(resolveInstallOptions(opts));
  console.log(describeStatus(opts.stage, service.status()));
  console.log(`Logs: ${daemonLogsHint(opts.stage, cliCommandName())}`);
}

export function daemonStop(stage: Stage): void {
  createServiceManager(stage).stop();
  console.log(`Stopped newio daemon${stageSuffix(stage)}.`);
}

export function daemonRestart(stage: Stage): void {
  const service = createServiceManager(stage);
  if (!service.isInstalled()) {
    throw new Error(`Daemon${stageSuffix(stage)} is not installed. Run \`newio daemon start\` first.`);
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
  console.log(`Uninstalled newio daemon${stageSuffix(stage)}.`);
}

export async function daemonReload(stage: Stage): Promise<void> {
  await withDaemon(stage, (c) => c.reload());
  console.log(`Reloaded newio daemon${stageSuffix(stage)}.`);
}
