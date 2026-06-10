/**
 * Rotating file log sink for the daemon.
 *
 * Used when the daemon runs under launchd (macOS), where it owns its own log
 * file instead of letting launchd capture stdout into an ever-growing file. The
 * launchd plist bakes `NEWIO_LOG_FILE` so the daemon knows to write here; the
 * systemd (Linux) path leaves it unset and logs to stdout → journald, which does
 * its own rotation. Size-based rotation with gzip keeps disk bounded without any
 * external newsyslog/logrotate config, and — because the daemon is the only
 * writer — sidesteps the inode trap of rotating a file out from under launchd's
 * open handle.
 */
import { mkdirSync } from 'fs';
import { dirname, basename } from 'path';
import { format } from 'util';
import { createStream } from 'rotating-file-stream';
import type { LogLevel } from '@newio/agent-sdk';

/** Active file caps at 5 MB; keep 5 gzipped generations (~25 MB ceiling). */
const MAX_SIZE = '5M';
const MAX_FILES = 5;

export interface DaemonFileLog {
  /** Format and append one log line. */
  write(level: LogLevel, name: string, message: string, args: readonly unknown[]): void;
  /** Flush and close the stream, resolving once buffered bytes hit disk. */
  close(): Promise<void>;
}

/**
 * Open a rotating log file at `logPath`. The active file is `logPath` itself
 * (so `newio daemon logs` can keep tailing it); rotated generations become
 * `logPath.1.gz`, `logPath.2.gz`, … and are pruned past {@link MAX_FILES}.
 */
export function createDaemonFileLog(logPath: string): DaemonFileLog {
  mkdirSync(dirname(logPath), { recursive: true });
  const stream = createStream(basename(logPath), {
    path: dirname(logPath),
    size: MAX_SIZE,
    maxFiles: MAX_FILES,
    compress: 'gzip',
  });
  return {
    write(level, name, message, args) {
      // Mirror the console handler's shape (ISO timestamp + [name]) so file and
      // foreground output read identically, with the level made explicit since a
      // file has no stderr/stdout split to convey it.
      const line = format(`${new Date().toISOString()} [${name}] ${level.toUpperCase()}`, message, ...args);
      stream.write(`${line}\n`);
    },
    close() {
      return new Promise((resolve) => stream.end(() => resolve()));
    },
  };
}
