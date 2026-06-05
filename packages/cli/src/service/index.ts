/**
 * Service-manager factory — selects the right implementation for the platform.
 */
import type { Stage } from '../paths.js';
import type { ServiceManager } from './types.js';
import { LaunchdServiceManager } from './launchd.js';
import { SystemdServiceManager } from './systemd.js';

export type { ServiceManager, ServiceStatus, ServiceState, InstallOptions, LogsOptions } from './types.js';

/**
 * Create the platform service manager. Throws on unsupported platforms (the
 * daemon can still be run in the foreground via `newio daemon run`).
 */
export function createServiceManager(stage: Stage): ServiceManager {
  switch (process.platform) {
    case 'darwin':
      return new LaunchdServiceManager(stage);
    case 'linux':
      return new SystemdServiceManager(stage);
    default:
      throw new Error(
        `Service management is not supported on ${process.platform}. Run the daemon in the foreground with \`newio daemon run\`.`,
      );
  }
}
