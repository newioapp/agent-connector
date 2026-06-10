import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonFileLog } from '../src/daemon/file-log';

let dir: string | undefined;

afterEach(() => {
  if (dir && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = undefined;
});

describe('createDaemonFileLog', () => {
  it('writes formatted, timestamped lines to the log file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'newio-log-'));
    const logPath = join(dir, 'daemon.log');
    const file = createDaemonFileLog(logPath);

    file.write('info', 'daemon', 'started', [{ pid: 42 }]);
    file.write('error', 'daemon', 'boom', []);
    await file.close();

    const contents = readFileSync(logPath, 'utf8');
    expect(contents).toMatch(/\[daemon\] INFO started/);
    expect(contents).toContain('pid: 42');
    expect(contents).toMatch(/\[daemon\] ERROR boom/);
    // ISO-8601 timestamp prefix on each line.
    expect(contents).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m);
  });

  it('creates the log directory if it does not exist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'newio-log-'));
    const logPath = join(dir, 'nested', 'sub', 'daemon.log');
    const file = createDaemonFileLog(logPath);
    file.write('info', 'daemon', 'hello', []);
    await file.close();

    expect(existsSync(logPath)).toBe(true);
  });
});
