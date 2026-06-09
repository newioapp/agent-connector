/**
 * `newio adapter …` handlers — install and version the npm-distributed ACP
 * adapters (claude, codex) into the connector's managed dir, so an agent of
 * that type can start without the adapter being on PATH.
 *
 * Pure-filesystem operations (list/use/uninstall/which) talk to the on-disk
 * layout via @newio/agent-engine directly. The network/install operations
 * (install/versions) lazily import ./installer so arborist's large dependency
 * graph never loads for the lightweight commands.
 */
import {
  MANAGED_ADAPTERS,
  adaptersRoot,
  getActiveVersion,
  listInstalledVersions,
  managedAdapterByKey,
  resolveActiveBinEntry,
  type ManagedAdapterSpec,
} from '@newio/agent-engine';
import { getDaemonPaths, type Stage } from '../paths.js';

/** Resolve the managed-adapter root for a stage (`<dataDir>/adapters`). */
function rootFor(stage: Stage): string {
  return adaptersRoot(getDaemonPaths(stage).dataDir);
}

interface AdapterArg {
  readonly key: string;
  readonly version?: string;
}

/** Parse a `<key>[@version]` argument (e.g. `claude`, `codex@0.16.0`). */
function parseAdapterArg(arg: string): AdapterArg {
  const at = arg.indexOf('@');
  if (at === -1) {
    return { key: arg };
  }
  return { key: arg.slice(0, at), version: arg.slice(at + 1) };
}

/** Resolve a friendly key to its spec, throwing a helpful error if unknown. */
function requireKey(key: string): ManagedAdapterSpec {
  const spec = managedAdapterByKey(key);
  if (!spec) {
    const known = MANAGED_ADAPTERS.map((a) => a.key).join(', ');
    throw new Error(`Unknown adapter "${key}". Known adapters: ${known}.`);
  }
  return spec;
}

/** `newio adapter list` — installed adapters + their active version. */
export function adapterList(stage: Stage): void {
  const root = rootFor(stage);
  console.log(`${'ADAPTER'.padEnd(10)}  ${'ACTIVE'.padEnd(12)}  INSTALLED`);
  for (const spec of MANAGED_ADAPTERS) {
    const installed = listInstalledVersions(root, spec.key);
    const active = getActiveVersion(root, spec.key);
    const installedStr = installed.length > 0 ? installed.join(', ') : '—';
    console.log(`${spec.key.padEnd(10)}  ${(active ?? '—').padEnd(12)}  ${installedStr}`);
  }
  console.log('');
  console.log('Install one with: newio adapter install <adapter>[@version]');
}

/** `newio adapter versions <adapter>` — versions published to the registry. */
export async function adapterVersions(stage: Stage, arg: string): Promise<void> {
  const { key } = parseAdapterArg(arg);
  requireKey(key);
  const root = rootFor(stage);
  const installed = new Set(listInstalledVersions(root, key));
  const { listRemoteVersions } = await import('../adapters/installer.js');
  const { versions, latest } = await listRemoteVersions(key);
  if (versions.length === 0) {
    console.log(`No published versions found for "${key}".`);
    return;
  }
  for (const v of versions) {
    const tags: string[] = [];
    if (v === latest) {
      tags.push('latest');
    }
    if (installed.has(v)) {
      tags.push('installed');
    }
    console.log(tags.length > 0 ? `${v}  (${tags.join(', ')})` : v);
  }
}

/** `newio adapter install <adapter>[@version]` — download into the managed dir. */
export async function adapterInstall(stage: Stage, arg: string): Promise<void> {
  const { key, version } = parseAdapterArg(arg);
  const spec = requireKey(key);
  const root = rootFor(stage);
  console.log(`Installing ${key} (${spec.pkg}@${version ?? 'latest'})…`);
  const { installAdapter } = await import('../adapters/installer.js');
  const result = await installAdapter(root, key, version);
  if (result.alreadyInstalled) {
    console.log(`Already installed: ${key}@${result.version}.`);
  } else {
    console.log(`Installed ${key}@${result.version}.`);
  }
  if (result.madeActive) {
    console.log(`Set as the active ${key} adapter.`);
  } else {
    const active = getActiveVersion(root, key);
    if (active !== result.version) {
      console.log(
        `Active ${key} adapter remains ${active ?? '—'}. Switch with: newio adapter use ${key}@${result.version}`,
      );
    }
  }
}

/** `newio adapter use <adapter>@<version>` — switch the active version. */
export async function adapterUse(stage: Stage, arg: string): Promise<void> {
  const { key, version } = parseAdapterArg(arg);
  requireKey(key);
  if (version === undefined) {
    throw new Error(`Specify a version: newio adapter use ${key}@<version>`);
  }
  const { useAdapterVersion } = await import('../adapters/local.js');
  useAdapterVersion(rootFor(stage), key, version);
  console.log(`Active ${key} adapter is now ${version}.`);
}

/** `newio adapter uninstall <adapter>@<version>` — remove an installed version. */
export async function adapterUninstall(stage: Stage, arg: string): Promise<void> {
  const { key, version } = parseAdapterArg(arg);
  requireKey(key);
  if (version === undefined) {
    throw new Error(`Specify a version: newio adapter uninstall ${key}@<version>`);
  }
  const { uninstallAdapter } = await import('../adapters/local.js');
  const result = uninstallAdapter(rootFor(stage), key, version);
  console.log(`Removed ${key}@${version}.`);
  if (result.wasActive) {
    console.log(
      result.promoted !== undefined
        ? `Active ${key} adapter is now ${result.promoted}.`
        : `No ${key} adapter versions remain installed.`,
    );
  }
}

/** `newio adapter which <adapter>` — print the resolved bin path for the active version. */
export function adapterWhich(stage: Stage, arg: string): void {
  const { key } = parseAdapterArg(arg);
  requireKey(key);
  const root = rootFor(stage);
  const entry = resolveActiveBinEntry(root, key);
  if (entry === undefined) {
    const active = getActiveVersion(root, key);
    if (active === undefined) {
      console.log(`No ${key} adapter installed. Install one with: newio adapter install ${key}`);
    } else {
      console.log(`Active ${key} adapter ${active} is not resolvable (install may be incomplete).`);
    }
    return;
  }
  // The adapter is launched as `node <entry>`.
  console.log(`node ${entry}`);
}
