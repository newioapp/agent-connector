import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkForUpdate, CHECK_INTERVAL_MS, manifestUrl } from '../src/update/check';

const CDN = 'https://cdn.example.test';
const NOW = 1_700_000_000_000;

function mockFetch(version: string, ok = true): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ version }), { status: ok ? 200 : 500 }),
  );
}

describe('checkForUpdate', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'newio-update-'));
    cachePath = join(dir, 'update-check.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('points at version.json under the CDN downloads path', () => {
    expect(manifestUrl(CDN)).toBe('https://cdn.example.test/downloads/cli/version.json');
  });

  it('fetches when there is no cache and reports an available update', async () => {
    mockFetch('1.2.0');
    const status = await checkForUpdate({ cdnBaseUrl: CDN, currentVersion: '1.1.0', cachePath, now: NOW });
    expect(status).toMatchObject({ latestVersion: '1.2.0', updateAvailable: true, checkedNow: true });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('persists the fetched result to the cache', async () => {
    mockFetch('1.2.0');
    await checkForUpdate({ cdnBaseUrl: CDN, currentVersion: '1.1.0', cachePath, now: NOW });
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toEqual({ lastCheckAt: NOW, latestVersion: '1.2.0' });
  });

  it('answers from a fresh cache without hitting the network', async () => {
    writeFileSync(cachePath, JSON.stringify({ lastCheckAt: NOW, latestVersion: '1.2.0' }));
    const spy = vi.spyOn(globalThis, 'fetch');
    const status = await checkForUpdate({
      cdnBaseUrl: CDN,
      currentVersion: '1.1.0',
      cachePath,
      now: NOW + CHECK_INTERVAL_MS - 1,
    });
    expect(status).toMatchObject({ latestVersion: '1.2.0', updateAvailable: true, checkedNow: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('re-fetches once the cache is older than the daily window', async () => {
    writeFileSync(cachePath, JSON.stringify({ lastCheckAt: NOW, latestVersion: '1.2.0' }));
    mockFetch('1.3.0');
    const status = await checkForUpdate({
      cdnBaseUrl: CDN,
      currentVersion: '1.1.0',
      cachePath,
      now: NOW + CHECK_INTERVAL_MS + 1,
    });
    expect(status).toMatchObject({ latestVersion: '1.3.0', checkedNow: true });
  });

  it('force bypasses a fresh cache', async () => {
    writeFileSync(cachePath, JSON.stringify({ lastCheckAt: NOW, latestVersion: '1.2.0' }));
    mockFetch('1.4.0');
    const status = await checkForUpdate({
      cdnBaseUrl: CDN,
      currentVersion: '1.1.0',
      cachePath,
      force: true,
      now: NOW + 1000,
    });
    expect(status).toMatchObject({ latestVersion: '1.4.0', checkedNow: true });
  });

  it('falls back to the cached version when the fetch fails', async () => {
    writeFileSync(cachePath, JSON.stringify({ lastCheckAt: NOW, latestVersion: '1.2.0' }));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const status = await checkForUpdate({
      cdnBaseUrl: CDN,
      currentVersion: '1.1.0',
      cachePath,
      now: NOW + CHECK_INTERVAL_MS + 1,
    });
    expect(status).toMatchObject({ latestVersion: '1.2.0', updateAvailable: true, checkedNow: false });
  });

  it('reports unknown (no throw) when the fetch fails with no cache', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const status = await checkForUpdate({ cdnBaseUrl: CDN, currentVersion: '1.1.0', cachePath, now: NOW });
    expect(status).toMatchObject({ latestVersion: undefined, updateAvailable: false, checkedNow: false });
  });

  it('does not flag an update when current is already latest', async () => {
    mockFetch('1.1.0');
    const status = await checkForUpdate({ cdnBaseUrl: CDN, currentVersion: '1.1.0', cachePath, now: NOW });
    expect(status.updateAvailable).toBe(false);
  });
});
