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
import { RPC_PROTOCOL_VERSION } from '../daemon/rpc.js';

/** Env prefix shown in hints so non-prod testers reproduce the right stage. */
function envPrefix(stage: Stage): string {
  return stage === 'prod' ? '' : `NEWIO_STAGE=${stage} `;
}

function startHint(stage: Stage): string {
  return `${envPrefix(stage)}newio daemon start`;
}

/** Connect to the daemon, verify protocol compatibility, or throw a friendly error. */
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

  const handshake = await connector.handshake();
  if (handshake.protocolVersion !== RPC_PROTOCOL_VERSION) {
    connector.disconnect();
    throw new Error(
      `Daemon protocol mismatch (daemon v${handshake.protocolVersion}, CLI v${RPC_PROTOCOL_VERSION}). ` +
        `Restart the daemon after updating: ${envPrefix(stage)}newio daemon restart`,
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
