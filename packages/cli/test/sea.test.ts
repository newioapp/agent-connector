import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveLauncherPath } from '../src/sea';

describe('resolveLauncherPath', () => {
  const origBinDir = process.env['NEWIO_BIN_DIR'];
  const dirs: string[] = [];

  function makeTmpDir(): string {
    // realpath so macOS /var -> /private/var symlink doesn't confuse comparisons.
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'newio-sea-')));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    if (origBinDir === undefined) {
      delete process.env['NEWIO_BIN_DIR'];
    } else {
      process.env['NEWIO_BIN_DIR'] = origBinDir;
    }
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('returns the launcher symlink when it resolves to the running binary', () => {
    const dir = makeTmpDir();
    const versions = join(dir, 'versions');
    mkdirSync(versions, { recursive: true });
    const target = join(versions, '0.1.0'); // the versioned real binary
    writeFileSync(target, '#!/bin/sh\n');
    chmodSync(target, 0o755);
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const launcher = join(binDir, 'newio');
    symlinkSync(target, launcher);
    process.env['NEWIO_BIN_DIR'] = binDir;

    // execPath is the resolved (versioned) path, as Node reports it via a symlink.
    expect(resolveLauncherPath(target)).toBe(launcher);
  });

  it('falls back to execPath when the launcher points elsewhere', () => {
    const dir = makeTmpDir();
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const other = join(dir, 'other-binary');
    writeFileSync(other, '');
    symlinkSync(join(dir, 'does-not-exist'), join(binDir, 'newio'));
    process.env['NEWIO_BIN_DIR'] = binDir;

    expect(resolveLauncherPath(other)).toBe(other);
  });

  it('falls back to execPath when no launcher symlink exists', () => {
    const dir = makeTmpDir();
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const exec = join(dir, 'newio');
    writeFileSync(exec, '');
    process.env['NEWIO_BIN_DIR'] = binDir;

    expect(resolveLauncherPath(exec)).toBe(exec);
  });
});
