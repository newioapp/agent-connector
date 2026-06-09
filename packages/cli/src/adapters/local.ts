/**
 * Local (filesystem-only) managed-adapter operations: switching the active
 * version and removing installs. Kept separate from installer.ts so the
 * `adapter use` / `adapter uninstall` commands don't pull arborist's large
 * dependency graph — they only touch the on-disk layout via @newio/agent-engine.
 */
import { existsSync, rmSync } from 'fs';
import {
  managedAdapterByKey,
  versionDir,
  adapterDir,
  getActiveVersion,
  setActiveVersion,
  listInstalledVersions,
} from '@newio/agent-engine';

function assertKnownAdapter(key: string): void {
  if (!managedAdapterByKey(key)) {
    throw new Error(`Unknown adapter "${key}". Known adapters: claude, codex.`);
  }
}

/** Point an adapter's active version at an already-installed version. */
export function useAdapterVersion(root: string, key: string, version: string): void {
  assertKnownAdapter(key);
  if (!listInstalledVersions(root, key).includes(version)) {
    throw new Error(
      `Version ${version} of "${key}" is not installed. Install it first: newio adapter install ${key}@${version}`,
    );
  }
  setActiveVersion(root, key, version);
}

export interface UninstallResult {
  /** True when the removed version had been the active one. */
  readonly wasActive: boolean;
  /** A remaining installed version promoted to active, if any. */
  readonly promoted: string | undefined;
}

/**
 * Remove an installed adapter version. If it was the active version, promote the
 * newest remaining install to active (or clear the pointer if none remain).
 */
export function uninstallAdapter(root: string, key: string, version: string): UninstallResult {
  assertKnownAdapter(key);
  const dir = versionDir(root, key, version);
  if (!existsSync(dir)) {
    throw new Error(`Version ${version} of "${key}" is not installed.`);
  }
  const wasActive = getActiveVersion(root, key) === version;
  rmSync(dir, { recursive: true, force: true });

  let promoted: string | undefined;
  if (wasActive) {
    const remaining = listInstalledVersions(root, key);
    promoted = remaining[0];
    if (promoted !== undefined) {
      setActiveVersion(root, key, promoted);
    } else {
      // No installs left — drop the stale active pointer directory.
      rmSync(adapterDir(root, key), { recursive: true, force: true });
    }
  }
  return { wasActive, promoted };
}
