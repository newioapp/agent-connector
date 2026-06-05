/**
 * `newio daemon …` commands — manage the daemon via the OS service manager.
 *
 * These only need the service manager (fs + launchctl/systemctl), not the
 * daemon RPC socket, so they stay on the lightweight client path. (`reload`,
 * which needs an RPC to the running daemon, is implemented with the client
 * command surface in a follow-up.)
 */
import { realpathSync } from 'fs';
import { resolveStage, getDaemonPaths, getDefaultUrls, type Stage } from '../paths.js';
import { createServiceManager, type InstallOptions, type ServiceStatus } from '../service/index.js';

interface DaemonFlags {
  readonly stage: Stage;
  readonly enable: boolean;
  readonly apiUrl?: string;
  readonly wsUrl?: string;
  readonly follow: boolean;
  readonly lines: number;
}

function parseDaemonFlags(args: string[]): DaemonFlags {
  let stageArg: string | undefined = process.env['NEWIO_STAGE'];
  let enable = true;
  let apiUrl: string | undefined;
  let wsUrl: string | undefined;
  let follow = false;
  let lines = 50;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--no-enable':
        enable = false;
        break;
      case '--stage':
        stageArg = args[++i];
        break;
      case '--api-url':
        apiUrl = args[++i];
        break;
      case '--ws-url':
        wsUrl = args[++i];
        break;
      case '-f':
      case '--follow':
        follow = true;
        break;
      case '-n':
      case '--lines':
        lines = Number(args[++i]) || lines;
        break;
    }
  }

  return { stage: resolveStage(stageArg), enable, apiUrl, wsUrl, follow, lines };
}

/** Build the install options (node/cli paths + baked environment) for a stage. */
function resolveInstallOptions(flags: DaemonFlags): InstallOptions {
  const defaults = getDefaultUrls(flags.stage);
  const { logPath } = getDaemonPaths(flags.stage);

  const env: Record<string, string> = {
    NEWIO_STAGE: flags.stage,
    NEWIO_API_URL: flags.apiUrl ?? defaults.apiBaseUrl,
    NEWIO_WS_URL: flags.wsUrl ?? defaults.wsUrl,
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
    enable: flags.enable,
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

export function runDaemonCommand(sub: string | undefined, args: string[]): void {
  const flags = parseDaemonFlags(args);
  const service = createServiceManager(flags.stage);

  switch (sub) {
    case 'start': {
      service.install(resolveInstallOptions(flags));
      console.log(describeStatus(flags.stage, service.status()));
      console.log(`Logs: newio daemon logs${flags.stage === 'prod' ? '' : ` --stage ${flags.stage}`} -f`);
      return;
    }
    case 'stop': {
      service.stop();
      console.log(`Stopped newio daemon (${flags.stage}).`);
      return;
    }
    case 'restart': {
      if (!service.isInstalled()) {
        throw new Error(`Daemon (${flags.stage}) is not installed. Run \`newio daemon start\` first.`);
      }
      service.restart();
      console.log(describeStatus(flags.stage, service.status()));
      return;
    }
    case 'status': {
      console.log(describeStatus(flags.stage, service.status()));
      return;
    }
    case 'logs': {
      service.logs({ follow: flags.follow, lines: flags.lines });
      return;
    }
    case 'uninstall': {
      service.uninstall();
      console.log(`Uninstalled newio daemon (${flags.stage}).`);
      return;
    }
    case 'run':
      // Handled earlier in the dispatcher (loads the daemon module directly).
      throw new Error('`daemon run` is handled by the dispatcher.');
    default:
      throw new Error(`Unknown daemon command: ${sub ?? '(none)'}`);
  }
}
