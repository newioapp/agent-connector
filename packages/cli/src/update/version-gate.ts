/**
 * Backend-driven version gating for the connector.
 *
 * On startup the daemon asks the backend `GET /version/check` whether the running
 * binary is still allowed to run. The backend owns the policy:
 *   - `forceUpdate` → this version is below the minimum supported; the daemon must
 *     refuse to start and tell the user to update.
 *   - `deprecation` → still supported, but scheduled for sunset; the daemon warns
 *     and continues.
 *
 * This is distinct from {@link import('./check.js')} (the CDN self-updater that
 * surfaces "a newer build exists"): that asks *what's latest*; this asks *am I
 * still allowed to run*. The check always fails OPEN — a network blip, a 5xx, or a
 * malformed body must never stop the daemon, so any failure resolves to `unknown`
 * and the caller proceeds as if healthy.
 */
import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 3000;

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

/**
 * Ask the backend whether this version may run. Always resolves — never throws —
 * returning `unknown` on any network/HTTP/parse failure so the daemon fails open.
 */
export async function evaluateVersionGate(opts: VersionGateOptions): Promise<VersionGateResult> {
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
