import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  adaptersRoot,
  versionDir,
  listInstalledVersions,
  getActiveVersion,
  setActiveVersion,
  resolveBinEntry,
  resolveActiveBinEntry,
} from '../src/adapters/adapter-store';

const CODEX_PKG = '@zed-industries/codex-acp';

/** Write a fake installed version: node_modules/<pkg>/package.json with a bin. */
function fakeInstall(root: string, key: string, version: string, pkg: string, bin: unknown): void {
  const pkgDir = join(versionDir(root, key, version), 'node_modules', pkg);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, version, bin }));
}

let tmp: string;
let root: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'adapter-store-'));
  root = adaptersRoot(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('adapter-store', () => {
  it('adaptersRoot is <dataDir>/adapters', () => {
    expect(adaptersRoot('/data')).toBe('/data/adapters');
  });

  it('listInstalledVersions returns versions with node_modules, newest-first', () => {
    fakeInstall(root, 'codex', '0.15.0', CODEX_PKG, { 'codex-acp': 'bin/codex-acp.js' });
    fakeInstall(root, 'codex', '0.16.0', CODEX_PKG, { 'codex-acp': 'bin/codex-acp.js' });
    // A bare version dir without node_modules does NOT count as installed.
    mkdirSync(versionDir(root, 'codex', '0.99.0'), { recursive: true });
    expect(listInstalledVersions(root, 'codex')).toEqual(['0.16.0', '0.15.0']);
  });

  it('listInstalledVersions is empty for an unknown / absent adapter dir', () => {
    expect(listInstalledVersions(root, 'codex')).toEqual([]);
  });

  it('setActiveVersion / getActiveVersion round-trips and persists JSON', () => {
    expect(getActiveVersion(root, 'codex')).toBeUndefined();
    setActiveVersion(root, 'codex', '0.16.0');
    expect(getActiveVersion(root, 'codex')).toBe('0.16.0');
    const pointer = JSON.parse(readFileSync(join(root, 'codex', 'active.json'), 'utf8'));
    expect(pointer).toEqual({ version: '0.16.0' });
  });

  it('resolveBinEntry follows the package bin (object form)', () => {
    fakeInstall(root, 'codex', '0.16.0', CODEX_PKG, { 'codex-acp': 'bin/codex-acp.js' });
    expect(resolveBinEntry(root, 'codex', '0.16.0')).toBe(
      join(root, 'codex', '0.16.0', 'node_modules', CODEX_PKG, 'bin/codex-acp.js'),
    );
  });

  it('resolveBinEntry follows the package bin (string form)', () => {
    fakeInstall(root, 'codex', '0.16.0', CODEX_PKG, 'bin/codex-acp.js');
    expect(resolveBinEntry(root, 'codex', '0.16.0')).toBe(
      join(root, 'codex', '0.16.0', 'node_modules', CODEX_PKG, 'bin/codex-acp.js'),
    );
  });

  it('resolveBinEntry is undefined when the version is not installed', () => {
    expect(resolveBinEntry(root, 'codex', '0.16.0')).toBeUndefined();
  });

  it('resolveActiveBinEntry resolves the active version, undefined when none active', () => {
    fakeInstall(root, 'codex', '0.16.0', CODEX_PKG, { 'codex-acp': 'bin/codex-acp.js' });
    expect(resolveActiveBinEntry(root, 'codex')).toBeUndefined();
    setActiveVersion(root, 'codex', '0.16.0');
    expect(resolveActiveBinEntry(root, 'codex')).toBe(
      join(root, 'codex', '0.16.0', 'node_modules', CODEX_PKG, 'bin/codex-acp.js'),
    );
  });

  it('resolveBinEntry is undefined for an unknown adapter key', () => {
    expect(resolveBinEntry(root, 'not-an-adapter', '1.0.0')).toBeUndefined();
  });

  it('setActiveVersion creates the adapter dir if absent', () => {
    expect(existsSync(join(root, 'codex'))).toBe(false);
    setActiveVersion(root, 'codex', '0.16.0');
    expect(existsSync(join(root, 'codex', 'active.json'))).toBe(true);
  });
});
