/**
 * Update detection: fetch the CDN version manifest, compare against the running
 * binary, and cache the result so we poll at most once per day.
 *
 * The manifest lives next to the binaries install.sh reads — `version.json` under
 * `${cdnBaseUrl}/downloads/cli` — so the same per-stage CloudFront distribution
 * that serves the download serves "what's latest". The CDN base is resolved from
 * the environment exactly like the API URL (prod hardcoded, dev/integ via
 * NEWIO_CDN_URL), so a `newio-dev` binary checks the dev channel automatically.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { z } from 'zod';
import { isNewer } from './version.js';

/** Poll the manifest at most once per this window (per stage). */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 2000;

/** Published `version.json`. Extra fields are ignored so we can add some later. */
const manifestSchema = z.object({
  version: z.string(),
  publishedAt: z.string().optional(),
});

export type UpdateManifest = z.infer<typeof manifestSchema>;

const cacheSchema = z.object({
  /** Epoch ms of the last successful manifest fetch. */
  lastCheckAt: z.number(),
  /** Latest version seen on the CDN at that time. */
  latestVersion: z.string(),
});

type UpdateCache = z.infer<typeof cacheSchema>;

export interface UpdateStatus {
  readonly currentVersion: string;
  /** Latest known version, or undefined if we've never reached the CDN. */
  readonly latestVersion: string | undefined;
  readonly updateAvailable: boolean;
  /** True when this call hit the network (vs. answered from cache). */
  readonly checkedNow: boolean;
}

/** Build the manifest URL for a CDN base (no trailing slash expected). */
export function manifestUrl(cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/downloads/cli/version.json`;
}

/** Fetch + validate the manifest. Throws on network error or malformed JSON. */
export async function fetchManifest(
  cdnBaseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<UpdateManifest> {
  const res = await fetch(manifestUrl(cdnBaseUrl), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`manifest fetch failed: HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  return manifestSchema.parse(body);
}

function readCache(cachePath: string): UpdateCache | null {
  try {
    const result = cacheSchema.safeParse(JSON.parse(readFileSync(cachePath, 'utf8')));
    return result.success ? result.data : null;
  } catch {
    return null; // missing or corrupt — treat as no cache
  }
}

function writeCache(cachePath: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // A non-writable cache only costs us an extra fetch next run — never fatal.
  }
}

export interface CheckOptions {
  readonly cdnBaseUrl: string;
  readonly currentVersion: string;
  readonly cachePath: string;
  /** Skip the freshness window and always hit the network (used by `newio update`). */
  readonly force?: boolean;
  readonly timeoutMs?: number;
  /** Injectable clock for tests. */
  readonly now?: number;
}

/**
 * Resolve the current update status, fetching the manifest only when forced or
 * when the cache is older than {@link CHECK_INTERVAL_MS}. Network/parse failures
 * fall back to the cached version (if any) and never throw — staying out of the
 * user's way is the whole point.
 */
export async function checkForUpdate(opts: CheckOptions): Promise<UpdateStatus> {
  const now = opts.now ?? Date.now();
  const cache = readCache(opts.cachePath);

  const fresh = cache !== null && now - cache.lastCheckAt < CHECK_INTERVAL_MS;
  if (fresh && opts.force !== true) {
    return status(opts.currentVersion, cache.latestVersion, false);
  }

  try {
    const manifest = await fetchManifest(opts.cdnBaseUrl, opts.timeoutMs);
    writeCache(opts.cachePath, { lastCheckAt: now, latestVersion: manifest.version });
    return status(opts.currentVersion, manifest.version, true);
  } catch {
    // Offline / transient: answer from cache if we have it, else "unknown".
    return status(opts.currentVersion, cache?.latestVersion, false);
  }
}

function status(currentVersion: string, latestVersion: string | undefined, checkedNow: boolean): UpdateStatus {
  return {
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion !== undefined && isNewer(currentVersion, latestVersion),
    checkedNow,
  };
}
