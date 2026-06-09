import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, chmodSync } from 'fs';
import { join, delimiter } from 'path';
import { tmpdir } from 'os';
import { resolveLauncherPath, cliCommandName } from '../src/sea';

describe('cliCommandName', () => {
  it('returns a recognizable newio* command basename', () => {
    expect(cliCommandName('newio')).toBe('newio');
    expect(cliCommandName('newio-dev')).toBe('newio-dev');
    expect(cliCommandName('/home/u/.local/bin/newio-integ')).toBe('newio-integ');
  });

  it('falls back to newio for anything else (e.g. node from source)', () => {
    expect(cliCommandName('node')).toBe('newio');
    expect(cliCommandName('/usr/bin/node')).toBe('newio');
    expect(cliCommandName('')).toBe('newio');
  });
});

describe('resolveLauncherPath', () => {
  const origBinDir = process.env['NEWIO_BIN_DIR'];
  const origPath = process.env['PATH'];
  const dirs: string[] = [];

  function makeTmpDir(): string {
    // realpath so macOS /var -> /private/var symlink doesn't confuse comparisons.
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'newio-sea-')));
    dirs.push(d);
    return d;
  }

  // A versioned binary + a `bin/newio` symlink pointing at it. Returns the
  // resolved (versioned) execPath and the stable launcher symlink path.
  function makeInstall(): { execPath: string; launcher: string; binDir: string } {
    const dir = makeTmpDir();
    mkdirSync(join(dir, 'versions'), { recursive: true });
    const target = join(dir, 'versions', '0.1.0');
    writeFileSync(target, '#!/bin/sh\n');
    chmodSync(target, 0o755);
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const launcher = join(binDir, 'newio');
    symlinkSync(target, launcher);
    return { execPath: target, launcher, binDir };
  }

  function restoreEnv(key: 'NEWIO_BIN_DIR' | 'PATH', orig: string | undefined): void {
    if (orig === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = orig;
    }
  }

  afterEach(() => {
    restoreEnv('NEWIO_BIN_DIR', origBinDir);
    restoreEnv('PATH', origPath);
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('uses the invoked launcher path (argv0) even without NEWIO_BIN_DIR', () => {
    const { execPath, launcher } = makeInstall();
    delete process.env['NEWIO_BIN_DIR'];
    // Invoked by absolute symlink path (the reviewer's custom-bin-dir case).
    expect(resolveLauncherPath(execPath, launcher)).toBe(launcher);
  });

  it('resolves a bare argv0 command name via PATH', () => {
    const { execPath, launcher, binDir } = makeInstall();
    delete process.env['NEWIO_BIN_DIR'];
    process.env['PATH'] = `${binDir}${delimiter}${origPath ?? ''}`;
    expect(resolveLauncherPath(execPath, 'newio')).toBe(launcher);
  });

  it('falls back to NEWIO_BIN_DIR when argv0 does not resolve to the binary', () => {
    const { execPath, launcher, binDir } = makeInstall();
    process.env['NEWIO_BIN_DIR'] = binDir;
    expect(resolveLauncherPath(execPath, '/nonexistent/elsewhere')).toBe(launcher);
  });

  it('uses the stage-named command for the NEWIO_BIN_DIR fallback', () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, 'versions'), { recursive: true });
    const target = join(dir, 'versions', '0.1.0');
    writeFileSync(target, '#!/bin/sh\n');
    chmodSync(target, 0o755);
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const launcher = join(binDir, 'newio-dev'); // stage-named symlink
    symlinkSync(target, launcher);
    process.env['NEWIO_BIN_DIR'] = binDir;
    // argv0 basename is newio-dev → the fallback looks for `newio-dev`, not `newio`.
    expect(resolveLauncherPath(target, '/nonexistent/newio-dev')).toBe(launcher);
  });

  it('falls back to execPath when nothing resolves back to the binary', () => {
    const dir = makeTmpDir();
    const exec = join(dir, 'newio'); // a plain file, no symlink points at it
    writeFileSync(exec, '');
    process.env['NEWIO_BIN_DIR'] = join(dir, 'bin'); // empty / no launcher
    expect(resolveLauncherPath(exec, '/nonexistent')).toBe(exec);
  });
});
