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

/**
 * Validate a stage value from the environment.
 *
 * Unset (or empty) defaults to 'prod'. A non-empty value that isn't a known
 * stage is rejected loudly so typos like `NEWIO_STAGE=devv` fail fast instead
 * of silently falling back to prod.
 */
export function resolveStage(value: string | undefined): Stage {
  if (value === undefined || value === '') {
    return 'prod';
  }
  const stage = STAGES.find((s) => s === value);
  if (stage === undefined) {
    throw new Error(`Invalid NEWIO_STAGE "${value}". Expected one of: ${STAGES.join(', ')}.`);
  }
  return stage;
}

export interface DaemonPaths {
  /** Persistent data dir: per-agent state under agents/<agentId>/ (config, credentials, env, cron). */
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

// Production endpoints — the only URLs hardcoded in this (private) repo. Non-prod
// stage URLs are never checked in; internal testers supply them via the
// NEWIO_API_URL / NEWIO_WS_URL env vars.
const PROD_API_URL = 'https://api.newio.app';
const PROD_WS_URL = 'wss://ws.newio.app';

export interface ResolvedConfig {
  readonly stage: Stage;
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
}

/**
 * The single source of truth for stage + URL resolution from the environment.
 *
 * Stage and URLs are intentionally NOT exposed as CLI flags — they're internal
 * testing knobs. End users with no env set resolve to `prod` with the production
 * endpoints. Internal testers set `NEWIO_STAGE` (for data-dir/socket isolation)
 * and `NEWIO_API_URL` / `NEWIO_WS_URL` to point at a non-prod backend. If the
 * stage is set without matching URLs, requests simply fall back to prod.
 */
export function resolveConfig(): ResolvedConfig {
  return {
    stage: resolveStage(process.env['NEWIO_STAGE']),
    apiBaseUrl: process.env['NEWIO_API_URL'] ?? PROD_API_URL,
    wsUrl: process.env['NEWIO_WS_URL'] ?? PROD_WS_URL,
  };
}
