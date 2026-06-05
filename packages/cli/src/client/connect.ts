/**
 * Daemon connection helpers for client commands.
 *
 * Each command opens a short-lived connection to the stage's daemon, runs, and
 * disconnects. If the daemon isn't reachable, the user is guided to start it
 * (we don't implicitly install a service as a side effect of, say, `agent list`).
 */
import { DaemonClient } from '../client.js';
import { DaemonConnector } from '../connector.js';
import type { DaemonNotificationHandlers } from '../client.js';
import { getDaemonPaths, type Stage } from '../paths.js';

function startHint(stage: Stage): string {
  return `newio daemon start${stage === 'prod' ? '' : ` --stage ${stage}`}`;
}

/** Connect to the daemon, or throw a friendly "is it running?" error. */
export async function openConnection(
  stage: Stage,
  handlers: DaemonNotificationHandlers = {},
): Promise<DaemonConnector> {
  const { socketPath } = getDaemonPaths(stage);
  const connector = new DaemonConnector(new DaemonClient());
  try {
    await connector.connect(socketPath, handlers);
  } catch {
    throw new Error(
      `Cannot reach the newio daemon (stage ${stage}). Is it running?\n  Start it with: ${startHint(stage)}`,
    );
  }
  return connector;
}

/** Open a connection, run `fn`, and always disconnect. */
export async function withDaemon<T>(
  stage: Stage,
  fn: (connector: DaemonConnector) => Promise<T>,
  handlers: DaemonNotificationHandlers = {},
): Promise<T> {
  const connector = await openConnection(stage, handlers);
  try {
    return await fn(connector);
  } finally {
    connector.disconnect();
  }
}
