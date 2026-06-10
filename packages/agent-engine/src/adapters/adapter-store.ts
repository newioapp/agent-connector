/**
 * On-disk layout + resolution for managed adapters. Pure filesystem/path logic —
 * deliberately free of any heavy install dependency (arborist/pacote) so the
 * agent spawn path can resolve an installed adapter without pulling the
 * installer's dependency graph. The installer (in the CLI) writes into the same
 * layout; this module reads it.
 *
 * Layout, rooted at `<dataDir>/adapters/`:
 *
 *   <root>/<key>/<version>/                  one isolated install per version
 *   <root>/<key>/<version>/node_modules/…    the adapter package + its full tree
 *   <root>/<key>/active.json                 { "version": "<active>" }
 *
 * Each version is a self-contained install dir with its own node_modules, so
 * versions coexist cleanly and an old one can be removed without touching the
 * others. The active version is a small JSON pointer rather than a symlink
 * (symlinks are fragile on Windows).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { rcompare, valid } from 'semver';
import { managedAdapterByKey } from './adapter-spec.js';

/** File name of the active-version pointer inside an adapter's directory. */
const ACTIVE_POINTER = 'active.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Root directory for all managed adapters, derived from the engine's data dir. */
export function adaptersRoot(dataDir: string): string {
  return join(dataDir, 'adapters');
}

/** Directory holding all installed versions (and the active pointer) for one adapter. */
export function adapterDir(root: string, key: string): string {
  return join(root, key);
}

/** Directory for a single installed version of an adapter. */
export function versionDir(root: string, key: string, version: string): string {
  return join(root, key, version);
}

/** Sort versions newest-first by semver, falling back to lexical for non-semver. */
export function sortVersionsDesc(versions: readonly string[]): string[] {
  return [...versions].sort((a, b) => {
    if (valid(a) !== null && valid(b) !== null) {
      return rcompare(a, b);
    }
    return a < b ? 1 : a > b ? -1 : 0;
  });
}

/**
 * Whether a specific adapter version is fully installed — i.e. its package's bin
 * entry actually resolves on disk, not merely that a node_modules dir exists.
 * This rejects half-finished installs (e.g. a reify that failed partway).
 */
export function isVersionInstalled(root: string, key: string, version: string): boolean {
  const entry = resolveBinEntry(root, key, version);
  return entry !== undefined && existsSync(entry);
}

/**
 * Versions currently installed for an adapter, newest-first by semver. A version
 * counts as installed only if its adapter bin resolves (see isVersionInstalled).
 */
export function listInstalledVersions(root: string, key: string): readonly string[] {
  const dir = adapterDir(root, key);
  if (!existsSync(dir)) {
    return [];
  }
  const versions: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ACTIVE_POINTER) {
      continue;
    }
    if (statSync(join(dir, entry)).isDirectory() && isVersionInstalled(root, key, entry)) {
      versions.push(entry);
    }
  }
  return sortVersionsDesc(versions);
}

/** The active version for an adapter, or undefined if none is set / installed. */
export function getActiveVersion(root: string, key: string): string | undefined {
  const pointer = join(adapterDir(root, key), ACTIVE_POINTER);
  if (!existsSync(pointer)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(pointer, 'utf8'));
  if (!isRecord(parsed)) {
    return undefined;
  }
  const version = parsed['version'];
  return typeof version === 'string' ? version : undefined;
}

/** Point an adapter's active version at `version`. Caller ensures it's installed. */
export function setActiveVersion(root: string, key: string, version: string): void {
  const dir = adapterDir(root, key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ACTIVE_POINTER), `${JSON.stringify({ version })}\n`, { mode: 0o600 });
}

/**
 * Absolute path to the adapter's bin entry (a node script) for a specific
 * installed version, or undefined if that version isn't installed / resolvable.
 * Reads the installed package's own package.json `bin` field so we follow the
 * package's declared entry rather than guessing a path.
 */
export function resolveBinEntry(root: string, key: string, version: string): string | undefined {
  const spec = managedAdapterByKey(key);
  if (!spec) {
    return undefined;
  }
  const pkgJsonPath = join(versionDir(root, key, version), 'node_modules', spec.pkg, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  if (!isRecord(parsed)) {
    return undefined;
  }
  const bin = parsed['bin'];
  // `bin` may be a string (single binary) or a name→path map.
  let rel: string | undefined;
  if (typeof bin === 'string') {
    rel = bin;
  } else if (isRecord(bin)) {
    const entry = bin[spec.bin];
    rel = typeof entry === 'string' ? entry : undefined;
  }
  if (rel === undefined) {
    return undefined;
  }
  return join(versionDir(root, key, version), 'node_modules', spec.pkg, rel);
}

/**
 * Resolve the bin entry for an adapter's currently-active version, or undefined
 * if nothing is installed/active. This is the spawn path's entry point.
 */
export function resolveActiveBinEntry(root: string, key: string): string | undefined {
  const version = getActiveVersion(root, key);
  if (version === undefined) {
    return undefined;
  }
  return resolveBinEntry(root, key, version);
}
