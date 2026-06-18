/**
 * Backend-driven version gating for the connector.
 *
 * The CLI asks the backend `GET /version/check` whether the running binary is
 * still allowed to operate. The backend owns the policy:
 *   - `forceUpdate` → this version is below the minimum supported; the CLI must
 *     abort the command and tell the user to update.
 *   - `deprecation` → still supported, but scheduled for sunset; warn and continue.
 *
 * Like the CDN self-updater's once-per-day check, the verdict is cached to a
 * per-stage file so the gate that runs before each command doesn't re-hit the
 * backend every time — within {@link GATE_CHECK_INTERVAL_MS} a command reuses the
 * last verdict. (Running per-command, not once at daemon startup, is deliberate:
 * the daemon process is launched once and rarely restarts, whereas users touch the
 * client commands constantly.)
 *
 * This is distinct from {@link import('./check.js')} (the CDN self-updater that
 * surfaces "a newer build exists"): that asks *what's latest*; this asks *am I
 * still allowed to run*. The check always fails OPEN — a network blip, a 5xx, or a
 * malformed body must never block the user, so any failure resolves to `unknown`
 * (or the last cached verdict) and the caller proceeds as if healthy.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Re-check the gate at most once per this window; daemon restarts within it reuse
 * the cached verdict. 4h matches the desktop app's force-update re-check cadence.
 */
export const GATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Platform values the backend's `/version/check` accepts. */
export type VersionCheckPlatform = 'macos' | 'windows' | 'linux';

/** Map a Node `process.platform` to the backend's platform enum (undefined if unmapped). */
export function resolvePlatform(platform: NodeJS.Platform = process.platform): VersionCheckPlatform | undefined {
  switch (platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return undefined;
  }
}

/**
 * Mirrors the relevant fields of the backend `CheckVersionResponse`; extra fields
 * (including the deprecated `latestVersion`) are ignored. The latest available
 * version is sourced from the CDN release manifest, not this endpoint.
 */
const responseSchema = z.object({
  minSupportedVersion: z.string(),
  forceUpdate: z.boolean(),
  updateUrl: z.string(),
  deprecation: z
    .object({
      sunsetDate: z.string(),
      message: z.string(),
    })
    .optional(),
});

/**
 * Outcome of the gate. `forced`/`deprecated` carry the fields the caller prints;
 * `unknown` means the check itself failed and the caller should fail open.
 */
export type VersionGateResult =
  | { readonly status: 'ok' }
  | { readonly status: 'deprecated'; readonly sunsetDate: string; readonly message: string }
  | { readonly status: 'forced'; readonly minSupportedVersion: string; readonly updateUrl: string }
  | { readonly status: 'unknown' };

/** Verdicts worth caching — everything except the transient `unknown` failure. */
const cacheableVerdictSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('deprecated'), sunsetDate: z.string(), message: z.string() }),
  z.object({ status: z.literal('forced'), minSupportedVersion: z.string(), updateUrl: z.string() }),
]);

const cacheSchema = z.object({
  /** Epoch ms of the last successful check. */
  lastCheckAt: z.number(),
  /** The binary version the verdict was computed for — a self-update invalidates it. */
  currentVersion: z.string(),
  verdict: cacheableVerdictSchema,
});

type GateCache = z.infer<typeof cacheSchema>;

export interface VersionGateOptions {
  /** Backend API base URL (no trailing slash), e.g. `https://api.newio.app`. */
  readonly apiBaseUrl: string;
  /** The running binary's version. */
  readonly currentVersion: string;
  /** Reporting platform; omitted from the query when undefined. */
  readonly platform?: VersionCheckPlatform;
  readonly timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
  /** Where to persist/read the cached verdict. Omit to disable caching (always fetch). */
  readonly cachePath?: string;
  /** Bypass a fresh cache and force a network check. */
  readonly force?: boolean;
  /** Injectable clock for tests. */
  readonly now?: number;
}

/** Build the `/version/check` URL for the connector software. */
export function versionCheckUrl(apiBaseUrl: string, currentVersion: string, platform?: VersionCheckPlatform): string {
  const base = apiBaseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ currentVersion, software: 'connector' });
  if (platform !== undefined) {
    params.set('platform', platform);
  }
  return `${base}/version/check?${params.toString()}`;
}

function readCache(cachePath: string): GateCache | null {
  try {
    const result = cacheSchema.safeParse(JSON.parse(readFileSync(cachePath, 'utf8')));
    return result.success ? result.data : null;
  } catch {
    return null; // missing or corrupt — treat as no cache
  }
}

function writeCache(cachePath: string, cache: GateCache): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // A non-writable cache only costs an extra check on the next start — never fatal.
  }
}

/**
 * Hit the backend and translate the response into a verdict. Always resolves —
 * never throws — returning `unknown` on any network/HTTP/parse failure.
 */
async function fetchVersionGate(opts: VersionGateOptions): Promise<VersionGateResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = versionCheckUrl(opts.apiBaseUrl, opts.currentVersion, opts.platform);
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      return { status: 'unknown' };
    }
    const body: unknown = await res.json();
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 'unknown' };
    }
    const data = parsed.data;
    if (data.forceUpdate) {
      return { status: 'forced', minSupportedVersion: data.minSupportedVersion, updateUrl: data.updateUrl };
    }
    if (data.deprecation !== undefined) {
      return { status: 'deprecated', sunsetDate: data.deprecation.sunsetDate, message: data.deprecation.message };
    }
    return { status: 'ok' };
  } catch {
    // Offline / timeout / 5xx / malformed body: never block the daemon on the
    // check itself — proceed as if healthy.
    return { status: 'unknown' };
  }
}

/**
 * Resolve the version gate, fetching from the backend only when forced or when the
 * cached verdict is missing/stale/for a different binary version. A successful
 * verdict is cached; a failed check reuses the last cached verdict (so a backend
 * blip never un-gates a forced client) or falls open to `unknown`.
 */
export async function evaluateVersionGate(opts: VersionGateOptions): Promise<VersionGateResult> {
  const now = opts.now ?? Date.now();
  const cached = opts.cachePath !== undefined ? readCache(opts.cachePath) : null;
  // Reusable only if computed for THIS binary version (a self-update invalidates it).
  const usable = cached !== null && cached.currentVersion === opts.currentVersion ? cached : null;

  if (usable !== null && opts.force !== true && now - usable.lastCheckAt < GATE_CHECK_INTERVAL_MS) {
    return usable.verdict;
  }

  const verdict = await fetchVersionGate(opts);
  if (verdict.status !== 'unknown') {
    if (opts.cachePath !== undefined) {
      writeCache(opts.cachePath, { lastCheckAt: now, currentVersion: opts.currentVersion, verdict });
    }
    return verdict;
  }

  // The check itself failed: prefer the last known verdict for this version (even
  // if stale) over nothing, else fail open.
  return usable !== null ? usable.verdict : { status: 'unknown' };
}
