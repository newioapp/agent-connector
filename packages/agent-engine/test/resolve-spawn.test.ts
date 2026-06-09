import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveSpawn } from '../src/utils';
import { adaptersRoot, setActiveVersion, versionDir } from '../src/adapters/adapter-store';
import type { AcpConfig } from '../src/types';

const CODEX_PKG = '@zed-industries/codex-acp';
const cwd = '/tmp';

function fakeCodexInstall(root: string, version: string): string {
  const pkgDir = join(versionDir(root, 'codex', version), 'node_modules', CODEX_PKG);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: CODEX_PKG, version, bin: { 'codex-acp': 'bin/codex-acp.js' } }),
  );
  setActiveVersion(root, 'codex', version);
  return join(pkgDir, 'bin/codex-acp.js');
}

let tmp: string;
let root: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'resolve-spawn-'));
  root = adaptersRoot(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveSpawn', () => {
  it('launches a managed adapter via `node <entry>` when installed + active', () => {
    const entry = fakeCodexInstall(root, '0.16.0');
    expect(resolveSpawn('codex', { cwd }, root)).toEqual({ command: 'node', args: [entry] });
  });

  it('falls back to the PATH default when the managed adapter is not installed', () => {
    expect(resolveSpawn('codex', { cwd }, root)).toEqual({ command: 'codex-acp', args: [] });
  });

  it('an executablePath override always wins, even with a managed install present', () => {
    fakeCodexInstall(root, '0.16.0');
    const config: AcpConfig = { cwd, executablePath: '/usr/local/bin/codex-acp' };
    expect(resolveSpawn('codex', config, root)).toEqual({ command: '/usr/local/bin/codex-acp', args: [] });
  });

  it('unmanaged types ignore the managed dir entirely', () => {
    expect(resolveSpawn('gemini', { cwd }, root)).toEqual({ command: 'gemini', args: ['--acp'] });
  });

  it('without an adaptersRoot it behaves exactly like resolveCommand', () => {
    expect(resolveSpawn('codex', { cwd })).toEqual({ command: 'codex-acp', args: [] });
  });
});
