import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setLogHandler } from '@newio/agent-sdk';
import { runDaemon } from '../src/daemon/index';

const savedHome = process.env['HOME'];
const savedLogFile = process.env['NEWIO_LOG_FILE'];
let dir: string | undefined;

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env['HOME'];
  } else {
    process.env['HOME'] = savedHome;
  }
  if (savedLogFile === undefined) {
    delete process.env['NEWIO_LOG_FILE'];
  } else {
    process.env['NEWIO_LOG_FILE'] = savedLogFile;
  }
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
});
