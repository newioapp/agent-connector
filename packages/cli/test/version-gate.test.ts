import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  evaluateVersionGate,
  versionCheckUrl,
  resolvePlatform,
  GATE_CHECK_INTERVAL_MS,
} from '../src/update/version-gate';

const API = 'https://api.example.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const OK_BODY = { minSupportedVersion: '1.0.0', forceUpdate: false, updateUrl: 'https://dl.test' };
const FORCED_BODY = { minSupportedVersion: '2.0.0', forceUpdate: true, updateUrl: 'https://dl.test' };

describe('versionCheckUrl', () => {
  it('targets /version/check for the connector software', () => {
    expect(versionCheckUrl(API, '1.2.0')).toBe(
      'https://api.example.test/version/check?currentVersion=1.2.0&software=connector',
    );
  });

  it('includes the platform when provided', () => {
    expect(versionCheckUrl(API, '1.2.0', 'macos')).toContain('platform=macos');
  });

  it('trims a trailing slash from the base URL', () => {
    expect(versionCheckUrl('https://api.example.test/', '1.2.0')).toContain('https://api.example.test/version/check');
  });
});

describe('resolvePlatform', () => {
  it('maps node platforms to the backend enum', () => {
    expect(resolvePlatform('darwin')).toBe('macos');
    expect(resolvePlatform('win32')).toBe('windows');
    expect(resolvePlatform('linux')).toBe('linux');
  });

  it('returns undefined for unmapped platforms', () => {
    expect(resolvePlatform('aix')).toBeUndefined();
  });
});

describe('evaluateVersionGate', () => {
  it('returns "forced" when the backend forces an update', async () => {
    // latestVersion is deprecated and ignored — the gate does not surface it.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        minSupportedVersion: '1.0.0',
        latestVersion: '1.3.0',
        forceUpdate: true,
        updateUrl: 'https://dl.test',
      }),
    );
    const result = await evaluateVersionGate({ apiBaseUrl: API, currentVersion: '0.9.0', fetchImpl });
    expect(result).toEqual({ status: 'forced', minSupportedVersion: '1.0.0', updateUrl: 'https://dl.test' });
  });

  it('returns "deprecated" with the verbatim message when a deprecation block is present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        minSupportedVersion: '1.0.0',
        latestVersion: '1.3.0',
        forceUpdate: false,
        updateUrl: 'https://dl.test',
        deprecation: { sunsetDate: '2026-12-31', message: 'Version 1.0.0 is deprecated.' },
      }),
    );
    const result = await evaluateVersionGate({ apiBaseUrl: API, currentVersion: '1.0.0', fetchImpl });
    expect(result).toEqual({ status: 'deprecated', sunsetDate: '2026-12-31', message: 'Version 1.0.0 is deprecated.' });
  });

  it('returns "ok" for a healthy version', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        minSupportedVersion: '1.0.0',
        latestVersion: '1.3.0',
        forceUpdate: false,
        updateUrl: 'https://dl.test',
      }),
    );
    const result = await evaluateVersionGate({ apiBaseUrl: API, currentVersion: '1.2.0', fetchImpl });
    expect(result).toEqual({ status: 'ok' });
  });

  it('prefers force over deprecation when (improbably) both are present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        minSupportedVersion: '1.0.0',
        latestVersion: '1.3.0',
        forceUpdate: true,
        updateUrl: 'https://dl.test',
        deprecation: { sunsetDate: '2026-12-31', message: 'x' },
      }),
    );
    const result = await evaluateVersionGate({ apiBaseUrl: API, currentVersion: '0.9.0', fetchImpl });
    expect(result.status).toBe('forced');
  });

  it('fails open ("unknown") on a non-OK HTTP status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    const result = await evaluateVersionGate({ apiBaseUrl: API, currentVersion: '1.0.0', fetchImpl });
    expect(result).toEqual({ status: 'unknown' });
  });

  it('fails open ("unknown") on a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await evaluateVersionGate({ apiBaseUrl: API, currentVersion: '1.0.0', fetchImpl });
    expect(result).toEqual({ status: 'unknown' });
  });

  it('fails open ("unknown") on a malformed body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ forceUpdate: 'yes' }));
    const result = await evaluateVersionGate({ apiBaseUrl: API, currentVersion: '1.0.0', fetchImpl });
    expect(result).toEqual({ status: 'unknown' });
  });

  it('passes the platform through to the request URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        minSupportedVersion: '1.0.0',
        latestVersion: '1.3.0',
        forceUpdate: false,
        updateUrl: 'https://dl.test',
      }),
    );
    await evaluateVersionGate({ apiBaseUrl: API, currentVersion: '1.2.0', platform: 'linux', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('platform=linux'), expect.anything());
  });
});

describe('evaluateVersionGate caching', () => {
  const NOW = 1_700_000_000_000;
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'newio-gate-'));
    cachePath = join(dir, 'version-gate.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the verdict + version + timestamp to the cache on a successful check', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(OK_BODY));
    const result = await evaluateVersionGate({
      apiBaseUrl: API,
      currentVersion: '1.2.0',
      cachePath,
      now: NOW,
      fetchImpl,
    });
    expect(result).toEqual({ status: 'ok' });
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toEqual({
      lastCheckAt: NOW,
      currentVersion: '1.2.0',
      verdict: { status: 'ok' },
    });
  });

  it('reuses a fresh cached verdict without hitting the network', async () => {
    writeFileSync(cachePath, JSON.stringify({ lastCheckAt: NOW, currentVersion: '1.2.0', verdict: { status: 'ok' } }));
    const fetchImpl = vi.fn();
    const result = await evaluateVersionGate({
      apiBaseUrl: API,
      currentVersion: '1.2.0',
      cachePath,
      now: NOW + GATE_CHECK_INTERVAL_MS - 1,
      fetchImpl,
    });
    expect(result).toEqual({ status: 'ok' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-checks when the cached verdict is stale', async () => {
    writeFileSync(cachePath, JSON.stringify({ lastCheckAt: NOW, currentVersion: '1.2.0', verdict: { status: 'ok' } }));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FORCED_BODY));
    const result = await evaluateVersionGate({
      apiBaseUrl: API,
      currentVersion: '1.2.0',
      cachePath,
      now: NOW + GATE_CHECK_INTERVAL_MS,
      fetchImpl,
    });
    expect(result.status).toBe('forced');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('ignores a cache written for a different binary version', async () => {
    // e.g. after a self-update — the old version's verdict must not apply.
    writeFileSync(
      cachePath,
      JSON.stringify({
        lastCheckAt: NOW,
        currentVersion: '1.1.0',
        verdict: { status: 'forced', minSupportedVersion: '2.0.0', updateUrl: 'x' },
      }),
    );
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(OK_BODY));
    const result = await evaluateVersionGate({
      apiBaseUrl: API,
      currentVersion: '1.2.0',
      cachePath,
      now: NOW,
      fetchImpl,
    });
    expect(result).toEqual({ status: 'ok' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not cache an "unknown" (failed) verdict', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await evaluateVersionGate({
      apiBaseUrl: API,
      currentVersion: '1.2.0',
      cachePath,
      now: NOW,
      fetchImpl,
    });
    expect(result).toEqual({ status: 'unknown' });
    expect(existsSync(cachePath)).toBe(false);
  });

  it('falls back to a stale cached verdict when the re-check fails', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        lastCheckAt: NOW,
        currentVersion: '1.2.0',
        verdict: { status: 'forced', minSupportedVersion: '2.0.0', updateUrl: 'https://dl.test' },
      }),
    );
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await evaluateVersionGate({
      apiBaseUrl: API,
      currentVersion: '1.2.0',
      cachePath,
      now: NOW + GATE_CHECK_INTERVAL_MS, // stale → tries network → fails → falls back
      fetchImpl,
    });
    expect(result).toEqual({ status: 'forced', minSupportedVersion: '2.0.0', updateUrl: 'https://dl.test' });
  });

  it('force bypasses a fresh cache and re-checks', async () => {
    writeFileSync(cachePath, JSON.stringify({ lastCheckAt: NOW, currentVersion: '1.2.0', verdict: { status: 'ok' } }));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FORCED_BODY));
    const result = await evaluateVersionGate({
      apiBaseUrl: API,
      currentVersion: '1.2.0',
      cachePath,
      now: NOW,
      force: true,
      fetchImpl,
    });
    expect(result.status).toBe('forced');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
