import log from 'electron-log/main';
import { rename, unlink } from 'fs';
import { join, dirname, basename, extname } from 'path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Map our log levels to electron-log levels
const ELECTRON_LOG_LEVEL: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

const MAX_BACKUPS = 3;

let globalLevel: LogLevel = 'info';
let initialized = false;

function initElectronLog(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
  log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}';
  log.transports.console.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}';

  // Numbered backup rotation: main.log → main.1.log → main.2.log → main.3.log
  log.transports.file.archiveLogFn = (oldLogFile) => {
    const dir = dirname(oldLogFile.path);
    const ext = extname(oldLogFile.path);
    const base = basename(oldLogFile.path, ext);

    // Delete the oldest backup if it exists
    const oldest = join(dir, `${base}.${MAX_BACKUPS}${ext}`);
    try {
      unlink(oldest, () => {});
    } catch {
      // ignore
    }

    // Shift existing backups: N-1 → N, N-2 → N-1, ..., 1 → 2
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const from = join(dir, `${base}.${i}${ext}`);
      const to = join(dir, `${base}.${i + 1}${ext}`);
      try {
        rename(from, to, () => {});
      } catch {
        // ignore
      }
    }

    // Move current log to .1
    const firstBackup = join(dir, `${base}.1${ext}`);
    try {
      rename(oldLogFile.path, firstBackup, () => {});
    } catch {
      // ignore
    }
  };
}

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export class Logger {
  private readonly tag: string;

  constructor(tag: string) {
    this.tag = tag;
    initElectronLog();
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[globalLevel]) {
      return;
    }
    const tagged = `[${this.tag}] ${message}`;
    log[ELECTRON_LOG_LEVEL[level]](tagged, ...args);
  }
}
