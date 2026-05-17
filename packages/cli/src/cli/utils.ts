/**
 * Shared CLI utilities.
 */
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { DaemonClient } from '../client.js';
import { DaemonConnector } from '../connector.js';
import type { AgentStatusInfo } from '@newio/agent-engine';

export function getDataDir(): string {
  const stage = process.env['NEWIO_STAGE'] ?? 'prod';
  const home = stage === 'prod' ? '.newio' : `.newio-${stage}`;
  return join(homedir(), home, 'connector');
}

export function getSocketPath(): string {
  return join(getDataDir(), 'daemon.sock');
}

export function getApiBaseUrl(): string {
  return process.env['NEWIO_API_URL'] ?? 'https://api.newio.app';
}

/** Connect to the daemon or exit with a helpful message. */
export async function connectOrExit(): Promise<DaemonConnector> {
  const socketPath = getSocketPath();
  if (!existsSync(socketPath)) {
    console.error('Error: daemon is not running. Start it with: newio daemon start');
    process.exit(1);
  }
  const connector = new DaemonConnector(new DaemonClient());
  try {
    await connector.connect(socketPath);
    return connector;
  } catch {
    console.error('Error: could not connect to daemon. Start it with: newio daemon start');
    process.exit(1);
  }
}

/**
 * Resolve an agent name (UUID, displayName, or username) to an AgentStatusInfo.
 * Exits with an error if not found or ambiguous.
 */
export function resolveAgent(agents: AgentStatusInfo[], name: string): AgentStatusInfo {
  // Exact UUID match
  const byId = agents.find((a) => a.id === name);
  if (byId) return byId;

  // Match by displayName or username (case-insensitive)
  const matches = agents.filter(
    (a) =>
      a.config.newio?.displayName?.toLowerCase() === name.toLowerCase() ||
      a.config.newio?.username?.toLowerCase() === name.toLowerCase(),
  );

  if (matches.length === 1) return matches[0] as AgentStatusInfo;

  if (matches.length > 1) {
    console.error(`Error: "${name}" matches multiple agents. Use the UUID instead:`);
    for (const m of matches) {
      console.error(`  ${m.id}  (${m.config.newio?.displayName ?? m.id})`);
    }
    process.exit(1);
  }

  console.error(`Error: no agent found matching "${name}"`);
  process.exit(1);
}
