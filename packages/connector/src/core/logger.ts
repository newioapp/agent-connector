import log from 'electron-log/main';
import { renameSync, unlinkSync } from 'fs';
import { join, dirname, basename, extname } from 'path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MAX_BACKUPS = 3;

let globalLevel: LogLevel = 'info';

/**
 * Configure electron-log file transport. Must be called once from the main
 * process entry point before any Logger instances are created. Renderer
 * processes should NOT call this — they can use Logger directly and
 * electron-log will route messages to the main process via IPC.
 */
export function initElectronLog(): void {
  log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
  log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}';
  log.transports.console.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}';

  // Numbered backup rotation: main.log → main.1.log → main.2.log → main.3.log
  log.transports.file.archiveLogFn = (oldLogFile) => {
    const dir = dirname(oldLogFile.path);
    const ext = extname(oldLogFile.path);
    const base = basename(oldLogFile.path, ext);

    // Delete the oldest backup if it exists
    try {
      unlinkSync(join(dir, `${base}.${MAX_BACKUPS}${ext}`));
    } catch {
      // ignore — file may not exist
    }

    // Shift existing backups: N-1 → N, N-2 → N-1, ..., 1 → 2
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      try {
        renameSync(join(dir, `${base}.${i}${ext}`), join(dir, `${base}.${i + 1}${ext}`));
      } catch {
        // ignore — file may not exist
      }
    }

    // Move current log to .1
    try {
      renameSync(oldLogFile.path, join(dir, `${base}.1${ext}`));
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
    log[level](`[${this.tag}] ${message}`, ...args);
  }
}
