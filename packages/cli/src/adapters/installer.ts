/**
 * Managed-adapter installer — downloads ACP agent adapters from npm into the
 * connector's managed install dir so users don't have to install them globally.
 *
 * Uses @npmcli/arborist (the tree manager npm itself uses) for installs: it
 * resolves the full dependency tree and, for adapters that ship prebuilt native
 * binaries via optionalDependencies (codex-acp), installs only the binary
 * matching the current platform. pacote (npm's fetcher, used by arborist) reads
 * the registry directly for version listings.
 *
 * `ignoreScripts: true` on every reify is a hard invariant, for two reasons:
 *   1. Security — managed adapters run with broad tool trust, so we never want
 *      to execute arbitrary install scripts from the registry.
 *   2. Bundling — it keeps @npmcli/run-script's node-gyp code path (the one
 *      bundle-hostile branch in arborist) dead, so the CLI SEA bundle stays
 *      clean. Neither managed adapter needs install scripts.
 *
 * This module pulls in arborist's large dependency graph, so it is imported
 * lazily by the `adapter` CLI commands (never on the hot client path).
 */
import { mkdirSync, rmSync } from 'fs';
import Arborist from '@npmcli/arborist';
import * as pacote from 'pacote';
import {
  managedAdapterByKey,
  versionDir,
  getActiveVersion,
  setActiveVersion,
  listInstalledVersions,
  sortVersionsDesc,
  type ManagedAdapterSpec,
} from '@newio/agent-engine';

function requireSpec(key: string): ManagedAdapterSpec {
  const spec = managedAdapterByKey(key);
  if (!spec) {
    throw new Error(`Unknown adapter "${key}". Known adapters: claude, codex.`);
  }
  return spec;
}

export interface RemoteVersions {
  /** All published versions, newest-first. */
  readonly versions: readonly string[];
  /** The version the registry's `latest` dist-tag points at. */
  readonly latest: string | undefined;
}

/** List the versions published to the registry for an adapter. */
export async function listRemoteVersions(key: string): Promise<RemoteVersions> {
  const spec = requireSpec(key);
  const packument = await pacote.packument(spec.pkg, { fullMetadata: false });
  const versions = sortVersionsDesc(Object.keys(packument.versions));
  return { versions, latest: packument['dist-tags'].latest };
}

/** Resolve a version spec (`latest`, `^0.40`, `0.44.0`, …) to a concrete version. */
async function resolveConcreteVersion(spec: ManagedAdapterSpec, versionSpec: string): Promise<string> {
  const manifest = await pacote.manifest(`${spec.pkg}@${versionSpec}`);
  return manifest.version;
}

export interface InstallResult {
  readonly version: string;
  /** True when this install was already present (no download performed). */
  readonly alreadyInstalled: boolean;
  /** True when this version was made the active one as a result of the install. */
  readonly madeActive: boolean;
}

/**
 * Install an adapter version into the managed dir. `versionSpec` defaults to the
 * registry `latest`. Becomes the active version if no version was active before.
 */
export async function installAdapter(root: string, key: string, versionSpec = 'latest'): Promise<InstallResult> {
  const spec = requireSpec(key);
  const version = await resolveConcreteVersion(spec, versionSpec);
  const dir = versionDir(root, key, version);

  // "Installed" means the bin actually resolves, not just that the dir exists —
  // so a previously-failed install doesn't get mistaken for a good one.
  const alreadyInstalled = listInstalledVersions(root, key).includes(version);
  if (!alreadyInstalled) {
    // Start from a clean dir (a prior partial install may linger) and remove it
    // if reify throws, so the version is never left half-installed — which would
    // otherwise be skipped as "already installed" or made active while broken.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const arb = new Arborist({ path: dir, ignoreScripts: true });
    try {
      await arb.reify({ add: [`${spec.pkg}@${version}`] });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  let madeActive = false;
  if (getActiveVersion(root, key) === undefined) {
    setActiveVersion(root, key, version);
    madeActive = true;
  }
  return { version, alreadyInstalled, madeActive };
}
