/**
 * Shared path + stage resolution for the daemon and CLI client.
 *
 * Both sides must agree on where the daemon's Unix socket lives, so this is the
 * single source of truth for the data directory layout.
 */
import { join } from 'path';
import { homedir } from 'os';

export type Stage = 'dev' | 'integ' | 'prod';

const STAGES: readonly Stage[] = ['dev', 'integ', 'prod'];

/** Validate an arbitrary string into a Stage, defaulting to 'prod'. */
export function resolveStage(value: string | undefined): Stage {
  return STAGES.find((s) => s === value) ?? 'prod';
}

export interface DaemonPaths {
  /** Persistent data dir: config.json, tokens.json, cron.json. */
  readonly dataDir: string;
  /** Unix domain socket the daemon listens on / the client connects to. */
  readonly socketPath: string;
  /** PID file written by the daemon. */
  readonly pidPath: string;
  /** Log file (used when not captured by a service manager). */
  readonly logPath: string;
}

/** Resolve the per-stage data directory and well-known file paths. */
export function getDaemonPaths(stage: Stage): DaemonPaths {
  const home = stage === 'prod' ? '.newio' : `.newio-${stage}`;
  const dataDir = join(homedir(), home, 'connector');
  return {
    dataDir,
    socketPath: join(dataDir, 'daemon.sock'),
    pidPath: join(dataDir, 'daemon.pid'),
    logPath: join(dataDir, 'daemon.log'),
  };
}

export interface NewioUrls {
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
}

/** Default Newio API/WS URLs for a stage (overridable via env at the call site). */
export function getDefaultUrls(stage: Stage): NewioUrls {
  switch (stage) {
    case 'dev':
      return { apiBaseUrl: 'https://api.nan-dev.newio.app', wsUrl: 'wss://ws.nan-dev.newio.app' };
    case 'integ':
      return { apiBaseUrl: 'https://api.pipeline-integ.newio.app', wsUrl: 'wss://ws.pipeline-integ.newio.app' };
    case 'prod':
      return { apiBaseUrl: 'https://api.newio.app', wsUrl: 'wss://ws.newio.app' };
  }
}
