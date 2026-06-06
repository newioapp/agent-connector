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

export interface ResolvedConfig {
  readonly stage: Stage;
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
}

/**
 * The single source of truth for stage + URL resolution from the environment.
 *
 * Stage and URLs are intentionally NOT exposed as CLI flags — they're internal
 * testing knobs. End users with no env set always resolve to `prod`. Internal
 * testers set `NEWIO_STAGE` (and optionally `NEWIO_API_URL`/`NEWIO_WS_URL` to
 * override the stage's default endpoints).
 */
export function resolveConfig(): ResolvedConfig {
  const stage = resolveStage(process.env['NEWIO_STAGE']);
  const defaults = getDefaultUrls(stage);
  return {
    stage,
    apiBaseUrl: process.env['NEWIO_API_URL'] ?? defaults.apiBaseUrl,
    wsUrl: process.env['NEWIO_WS_URL'] ?? defaults.wsUrl,
  };
}
