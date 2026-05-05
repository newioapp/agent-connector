export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let globalLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

function write(level: LogLevel, tag: string, message: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[globalLevel]) return;
  const ts = new Date().toISOString();
  const extra = args.length
    ? ' ' + args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(' ')
    : '';
  process.stderr.write(`${ts} [${level.toUpperCase()}] [${tag}] ${message}${extra}\n`);
}

export class Logger {
  constructor(private readonly tag: string) {}
  debug(msg: string, ...args: unknown[]): void {
    write('debug', this.tag, msg, args);
  }
  info(msg: string, ...args: unknown[]): void {
    write('info', this.tag, msg, args);
  }
  warn(msg: string, ...args: unknown[]): void {
    write('warn', this.tag, msg, args);
  }
  error(msg: string, ...args: unknown[]): void {
    write('error', this.tag, msg, args);
  }
}
