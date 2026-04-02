/** Log level. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A log handler receives all log calls. */
export type LogHandler = (level: LogLevel, name: string, message: string, args: unknown[]) => void;

/** Named logger instance. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

let handler: LogHandler | undefined;

/** Set the global log handler. Pass `undefined` to disable logging. */
export function setLogHandler(h: LogHandler | undefined): void {
  handler = h;
}

/** Get a named logger. Calls are forwarded to the global handler (if set). */
export function getLogger(name: string): Logger {
  return {
    debug: (msg, ...args) => handler?.('debug', name, msg, args),
    info: (msg, ...args) => handler?.('info', name, msg, args),
    warn: (msg, ...args) => handler?.('warn', name, msg, args),
    error: (msg, ...args) => handler?.('error', name, msg, args),
  };
}

/** Built-in console log handler with `[Newio:<name>]` prefix. */
export const consoleLogHandler: LogHandler = (level, name, message, args) => {
  const prefix = `[Newio:${name}]`;
  switch (level) {
    case 'debug':
      console.debug(prefix, message, ...args);
      break;
    case 'info':
      console.info(prefix, message, ...args);
      break;
    case 'warn':
      console.warn(prefix, message, ...args);
      break;
    case 'error':
      console.error(prefix, message, ...args);
      break;
  }
};
