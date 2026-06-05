/**
 * ServiceManager — OS-level supervision for the daemon.
 *
 * The daemon runs under the platform service manager (launchd on macOS, systemd
 * --user on Linux) so it gets crash-restart, boot persistence, and log capture
 * for free. Each implementation generates a unit/plist that runs
 * `<node> <cli> daemon run`, then drives the OS tooling to install/start it.
 */
import type { Stage } from '../paths.js';

export type ServiceState = 'running' | 'stopped' | 'not-installed';

export interface ServiceStatus {
  readonly state: ServiceState;
  /** PID of the running daemon, if known. */
  readonly pid?: number;
  /** Whether the service is enabled to start on login/boot. */
  readonly enabled?: boolean;
}

export interface InstallOptions {
  /** Absolute path to the Node executable that runs the daemon. */
  readonly nodePath: string;
  /** Absolute path to the CLI entry script (`dist/cli.js`). */
  readonly cliEntryPath: string;
  /** Environment baked into the unit (NEWIO_STAGE/URLs, HOME, PATH). */
  readonly env: Record<string, string>;
  /** Where stdout/stderr is written (launchd); systemd uses journald. */
  readonly logPath: string;
  /** Start on login/boot (install-and-enable). */
  readonly enable: boolean;
}

export interface LogsOptions {
  /** Follow the log stream (`tail -f` / `journalctl -f`). */
  readonly follow: boolean;
  /** Number of trailing lines to show initially. */
  readonly lines: number;
}

export interface ServiceManager {
  readonly stage: Stage;
  /** True if the unit/plist file exists on disk. */
  isInstalled(): boolean;
  /** Write the unit file and (if enable) register it with the service manager. */
  install(opts: InstallOptions): void;
  /** Stop and deregister the service, then remove the unit file. */
  uninstall(): void;
  /** Start the service (must be installed first). */
  start(): void;
  /** Stop the running service (leaves it installed). */
  stop(): void;
  /** Restart the service. */
  restart(): void;
  /** Current service state. */
  status(): ServiceStatus;
  /** Stream the daemon logs to stdout. */
  logs(opts: LogsOptions): void;
}
