/**
 * Log-level resolution + filtering for both the daemon and the client CLI.
 *
 * The SDK logger (see packages/sdk/src/core/logger.ts) forwards every call to the
 * global handler regardless of level — filtering is the handler's job. Both the
 * long-running daemon and the short-lived client commands install a handler here
 * so `getLogger()` diagnostics have a sink everywhere, gated by one threshold.
 *
 * The daemon's level is controlled by `--log-level` on `daemon run`/`start` (a
 * CLI flag, per issue #462 — deliberately not an environment variable); `daemon
 * start` bakes the same `--log-level <level>` into the service unit's argv so the
 * launchd/systemd-launched `daemon run` is driven by the very same flag. The
 * client handler has no flag yet and runs at a fixed `info` default.
 */
import { setLogHandler, type LogLevel } from '@newio/agent-sdk';

/** The connector's log levels, in ascending order of severity. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Numeric severity, so a threshold can suppress everything below it. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Default level for both the daemon and the client handler. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** Narrow an arbitrary string to a known {@link LogLevel}, else `undefined`. */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  return LOG_LEVELS.find((l) => l === value);
}

/**
 * Resolve the effective daemon log level from the `--log-level` flag, falling
 * back to the `info` default when the flag is absent. The flag is the sole
 * control on both the foreground and service paths (the service unit bakes the
 * same flag into its argv), so there is no environment-variable tier. An
 * unrecognized value is ignored rather than fatal so a stale unit never wedges
 * the daemon.
 */
export function resolveLogLevel(flag: string | undefined): LogLevel {
  return parseLogLevel(flag) ?? DEFAULT_LOG_LEVEL;
}

/** True when `level` is at or above the configured `threshold`. */
export function isLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}

/**
 * Install the client-side log handler for a CLI invocation.
 *
 * Unlike the daemon handler (which writes a timestamped, sortable log file), this
 * targets a human running a short-lived command, so it stays terse: just a
 * `[name]` source tag, no timestamp. Every level is written to **stderr** so it
 * never mixes into the stdout a command reserves for its results (e.g. `agent
 * info` JSON). Fixed at the `info` default — there is no client-side flag yet.
 *
 * The daemon's foreground process replaces this with its own handler when it
 * boots, so this only governs true client commands.
 */
export function installClientLogHandler(): void {
  setLogHandler((level, name, message, args) => {
    if (!isLevelEnabled(level, DEFAULT_LOG_LEVEL)) {
      return;
    }
    console.error(`[${name}]`, message, ...args);
  });
}
