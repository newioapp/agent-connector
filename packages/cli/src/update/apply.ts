/**
 * Apply an update by re-running the published `install.sh`.
 *
 * The installer already does every hard part — download the right os/arch
 * archive, verify its SHA-256, drop it in a versioned dir, and atomically flip
 * the on-PATH symlink — so the self-updater simply re-invokes it pinned to the
 * target version. Reusing one script keeps the curl|bash install path and the
 * in-CLI `newio update` path byte-for-byte identical.
 *
 * Only meaningful for a SEA binary install. An npm-global or run-from-source CLI
 * can't replace its own executable this way; the caller gates on
 * {@link isSeaBinary} and prints package-manager guidance instead.
 */
import { spawnSync } from 'child_process';

export interface ApplyOptions {
  /** CDN base (no trailing slash); install.sh + the archives live under `${cdnBaseUrl}/downloads/cli`. */
  readonly cdnBaseUrl: string;
  /** Exact version to install, so we land on the version we reported, not a moving "latest". */
  readonly version: string;
}

export interface ApplyResult {
  readonly applied: boolean;
  /** Present when `applied` is false. */
  readonly error?: string;
}

/**
 * Stream the installer (stdio inherited so the user sees its progress). The CDN
 * base and pinned version are passed through the same env knobs install.sh
 * already documents (NEWIO_INSTALL_BASE_URL / NEWIO_VERSION).
 */
export function applyUpdateViaInstaller(opts: ApplyOptions): ApplyResult {
  const installBase = `${opts.cdnBaseUrl}/downloads/cli`;
  // pipefail so a failed curl aborts instead of feeding empty input to bash.
  const script = `set -euo pipefail; curl -fsSL "$NEWIO_INSTALL_BASE_URL/install.sh" | bash`;
  const result = spawnSync('bash', ['-c', script], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NEWIO_INSTALL_BASE_URL: installBase,
      NEWIO_VERSION: opts.version,
    },
  });

  if (result.error !== undefined) {
    return { applied: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return { applied: false, error: `installer exited with status ${result.status ?? 'unknown'}` };
  }
  return { applied: true };
}
