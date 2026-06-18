/**
 * Shared path + stage resolution for the daemon and CLI client.
 *
 * Both sides must agree on where the daemon's Unix socket lives, so this is the
 * single source of truth for the data directory layout.
 */
import { join, basename } from 'path';
import { homedir } from 'os';

export type Stage = 'dev' | 'integ' | 'prod';

const STAGES: readonly Stage[] = ['dev', 'integ', 'prod'];

/**
 * Infer the stage from the command name the CLI was invoked as.
 *
 * The internal-testing builds install stage-named binaries (`newio-dev` /
 * `newio-integ`) so all three stages can coexist on one machine. Deriving the
 * stage from that name lets `newio-dev <cmd>` reach the dev daemon's socket (and
 * `~/.newio-dev` data dir) without the user setting NEWIO_STAGE on every call.
 * The plain `newio` command — and any other name (e.g. `node` when run from
 * source) — resolves to prod. An explicit NEWIO_STAGE always wins (see
 * {@link resolveStage}).
 */
export function stageFromCommandName(command: string): Stage {
  switch (basename(command)) {
    case 'newio-dev':
      return 'dev';
    case 'newio-integ':
      return 'integ';
    default:
      return 'prod';
  }
}

/**
 * Validate a stage value from the environment.
 *
 * Unset (or empty) falls back to the stage implied by the invoked command name
 * (`command`, default `process.argv0`) — see {@link stageFromCommandName} —
 * which is 'prod' for the plain `newio` binary. A non-empty value that isn't a
 * known stage is rejected loudly so typos like `NEWIO_STAGE=devv` fail fast
 * instead of silently falling back to prod.
 */
export function resolveStage(value: string | undefined, command: string = process.argv0): Stage {
  if (value === undefined || value === '') {
    return stageFromCommandName(command);
  }
  const stage = STAGES.find((s) => s === value);
  if (stage === undefined) {
    throw new Error(`Invalid NEWIO_STAGE "${value}". Expected one of: ${STAGES.join(', ')}.`);
  }
  return stage;
}

/**
 * User-facing stage suffix for CLI output, e.g. ` (dev)`.
 *
 * Prod is the only end-user stage, so it must stay invisible — `dev`/`integ` are
 * internal testing knobs and end users should never learn they exist. Prod
 * returns an empty string; non-prod returns a parenthetical so internal testers
 * can tell instances apart.
 */
export function stageSuffix(stage: Stage): string {
  return stage === 'prod' ? '' : ` (${stage})`;
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
  /**
   * Directory for agent-downloaded attachments. A hidden, stage-suffixed sibling
   * of the data dir (e.g. `~/.newio-dev-downloads`) so dev/integ/prod downloads
   * never mix. Kept separate from `dataDir` (internal plumbing) because it holds
   * user-facing files; organized as `<downloadsDir>/<username>/<conversationId>/`.
   */
  readonly downloadsDir: string;
  /**
   * Where the self-updater caches its last CDN version check, so it polls the
   * manifest at most once per day. A stage-scoped sibling of the data dir (e.g.
   * `~/.newio-dev/update-check.json`) so each stage tracks its own channel.
   */
  readonly updateCachePath: string;
  /**
   * Where the daemon caches the backend version-gate verdict (force-update /
   * deprecation), so frequent restarts don't re-hit the backend every time. A
   * stage-scoped sibling of the data dir (e.g. `~/.newio-dev/version-gate.json`),
   * kept out of connector/ like the update cache so daemon uninstall preserves it.
   */
  readonly versionGateCachePath: string;
}

/**
 * Base directory under which the per-stage data dirs live. Defaults to the user's
 * home, but `NEWIO_HOME` overrides it — an internal-testing knob (like
 * `NEWIO_STAGE`/`NEWIO_API_URL`) that fully sandboxes a stage's data dir, socket,
 * and downloads. End users never set it; e2e tests use it to run a real daemon in
 * an isolated temp dir without colliding with a developer's running daemon.
 */
function dataHome(): string {
  const override = process.env['NEWIO_HOME'];
  return override && override.length > 0 ? override : homedir();
}

/** Resolve the per-stage data directory and well-known file paths. */
export function getDaemonPaths(stage: Stage): DaemonPaths {
  const base = dataHome();
  const home = stage === 'prod' ? '.newio' : `.newio-${stage}`;
  const dataDir = join(base, home, 'connector');
  return {
    dataDir,
    socketPath: join(dataDir, 'daemon.sock'),
    pidPath: join(dataDir, 'daemon.pid'),
    logPath: join(dataDir, 'daemon.log'),
    // Sibling of `home`, not nested under it: `.newio-downloads` (prod),
    // `.newio-dev-downloads`, `.newio-integ-downloads`.
    downloadsDir: join(base, `${home}-downloads`),
    // Beside the data dir (not under connector/, which the daemon owns) so a
    // `daemon uninstall` doesn't wipe the update cadence: `~/.newio/update-check.json`.
    updateCachePath: join(base, home, 'update-check.json'),
    // Likewise beside the data dir: `~/.newio/version-gate.json`.
    versionGateCachePath: join(base, home, 'version-gate.json'),
  };
}

// Production endpoints — the only URLs hardcoded in this (private) repo. Non-prod
// stage URLs are never checked in; internal testers supply them via the
// NEWIO_API_URL / NEWIO_WS_URL / NEWIO_CDN_URL env vars.
const PROD_API_URL = 'https://api.newio.app';
const PROD_WS_URL = 'wss://ws.newio.app';
// Download CDN — where install.sh + the self-updater fetch binaries and the
// version manifest. Each stage has its OWN downloads bucket + CloudFront
// distribution (see .github/workflows/release-cli-binaries.yml), so dev/integ
// testers point here with NEWIO_CDN_URL exactly as they do for the API URL.
const PROD_CDN_URL = 'https://cdn.newio.app';

export interface ResolvedConfig {
  readonly stage: Stage;
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
  /**
   * Download CDN base (no trailing slash); the version manifest + binaries live
   * under `${cdnBaseUrl}/downloads/cli`. Unlike the API/WS URLs, this does NOT
   * fall back to prod for a non-prod stage: it's only the hardcoded prod CDN for
   * `prod`, or an explicit `NEWIO_CDN_URL`, else `undefined`. The updater mutates
   * the installed binary, so a `newio-dev` build with no override must refuse to
   * check/install rather than silently pull the prod channel.
   */
  readonly cdnBaseUrl: string | undefined;
}

/**
 * The single source of truth for stage + URL resolution from the environment.
 *
 * Stage and URLs are intentionally NOT exposed as CLI flags — they're internal
 * testing knobs. End users with no env set resolve to `prod` with the production
 * endpoints. Internal testers set `NEWIO_STAGE` (for data-dir/socket isolation)
 * and `NEWIO_API_URL` / `NEWIO_WS_URL` to point at a non-prod backend. If the
 * stage is set without matching URLs, requests simply fall back to prod — except
 * the download CDN (see {@link resolveCdnBaseUrl}), which must not.
 */
export function resolveConfig(): ResolvedConfig {
  const stage = resolveStage(process.env['NEWIO_STAGE']);
  return {
    stage,
    apiBaseUrl: process.env['NEWIO_API_URL'] ?? PROD_API_URL,
    wsUrl: process.env['NEWIO_WS_URL'] ?? PROD_WS_URL,
    cdnBaseUrl: resolveCdnBaseUrl(stage),
  };
}

/**
 * Resolve the download CDN base, or `undefined` when it can't be safely
 * determined. An explicit `NEWIO_CDN_URL` always wins (trailing slash trimmed).
 * Otherwise only `prod` has a compiled-in CDN; a non-prod stage with no override
 * returns `undefined` so the updater fails fast instead of pulling prod binaries.
 */
function resolveCdnBaseUrl(stage: Stage): string | undefined {
  const override = process.env['NEWIO_CDN_URL'];
  if (override !== undefined && override !== '') {
    return override.replace(/\/+$/, '');
  }
  return stage === 'prod' ? PROD_CDN_URL : undefined;
}
