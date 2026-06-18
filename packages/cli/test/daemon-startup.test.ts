import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setLogHandler } from '@newio/agent-sdk';
import { runDaemon } from '../src/daemon/index';

const savedHome = process.env['HOME'];
const savedLogFile = process.env['NEWIO_LOG_FILE'];
const savedApiUrl = process.env['NEWIO_API_URL'];
let dir: string | undefined;

function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = saved;
  }
}

afterEach(() => {
  restoreEnv('HOME', savedHome);
  restoreEnv('NEWIO_LOG_FILE', savedLogFile);
  restoreEnv('NEWIO_API_URL', savedApiUrl);
  vi.restoreAllMocks();
  setLogHandler(undefined);
  if (dir && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = undefined;
});

describe('runDaemon startup failures', () => {
  it('logs and flushes the failure to the rotating log file before rejecting', async () => {
    dir = mkdtempSync(join(tmpdir(), 'newio-startup-'));
    const logPath = join(dir, 'daemon.log');
    process.env['NEWIO_LOG_FILE'] = logPath;
    // The HOME check is the earliest startup failure — it rejects before any
    // server/socket setup, so it exercises the catch path in isolation. Under
    // launchd this rejection has no stderr to land on, so it must reach the log.
    delete process.env['HOME'];

    await expect(runDaemon()).rejects.toThrow(/HOME is not set/);

    const contents = readFileSync(logPath, 'utf8');
    expect(contents).toContain('Daemon failed to start');
    expect(contents).toContain('HOME is not set');
  });

  it('aborts startup when the backend forces an update', async () => {
    dir = mkdtempSync(join(tmpdir(), 'newio-startup-'));
    const logPath = join(dir, 'daemon.log');
    process.env['NEWIO_LOG_FILE'] = logPath;
    process.env['HOME'] = dir; // pass the HOME check so startup reaches the version gate
    process.env['NEWIO_API_URL'] = 'https://api.example.test';

    // The gate runs before any socket/agent setup, so a forced response rejects
    // cleanly without binding the socket.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          minSupportedVersion: '99.0.0',
          latestVersion: '99.0.0',
          forceUpdate: true,
          updateUrl: 'https://dl.test',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(runDaemon()).rejects.toThrow(/below the minimum supported version/);

    const contents = readFileSync(logPath, 'utf8');
    expect(contents).toContain('no longer supported');
  });
});
