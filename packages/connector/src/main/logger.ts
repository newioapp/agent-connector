import log from 'electron-log/main';
import { renameSync, unlinkSync } from 'fs';
import { join, dirname, basename, extname } from 'path';

const MAX_BACKUPS = 3;

export function initElectronLog(): void {
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}';
  log.transports.console.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] {text}';

  log.transports.file.archiveLogFn = (oldLogFile) => {
    const dir = dirname(oldLogFile.path);
    const ext = extname(oldLogFile.path);
    const base = basename(oldLogFile.path, ext);
    try {
      unlinkSync(join(dir, `${base}.${MAX_BACKUPS}${ext}`));
    } catch {
      /* ignore */
    }
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      try {
        renameSync(join(dir, `${base}.${i}${ext}`), join(dir, `${base}.${i + 1}${ext}`));
      } catch {
        /* ignore */
      }
    }
    try {
      renameSync(oldLogFile.path, join(dir, `${base}.1${ext}`));
    } catch {
      /* ignore */
    }
  };
}
