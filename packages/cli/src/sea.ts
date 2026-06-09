/**
 * Self-invocation helpers that work whether `newio` runs as a plain Node script
 * (`node dist/cli.js …`) or as a bundled Single Executable Application (SEA).
 *
 * In a SEA build there is no separate script path: `process.execPath` IS the
 * `newio` binary and it re-enters its own command dispatch directly (the daemon
 * service unit and the MCP bridge both re-invoke the CLI, so they must not
 * assume an `argv[1]` script path that only exists for the `node script.js`
 * form). As a side benefit, the service unit then runs the signed `newio`
 * binary itself — so macOS attributes the daemon to our code signature rather
 * than to the generic, Node.js-Foundation-signed `node` it would otherwise use.
 */
import { realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * True when running as an injected Single Executable Application.
 *
 * Resolved via `process.getBuiltinModule('node:sea')` rather than a static
 * `import … from 'node:sea'`: the bundler rewrites the bare import and strips
 * the `node:` prefix, which the SEA embedder's `require` then rejects.
 * `getBuiltinModule` (Node ≥ 20.16) is a plain runtime call the bundler leaves
 * untouched, and returns the live builtin inside the SEA.
 */
export function isSeaBinary(): boolean {
  try {
    const sea = process.getBuiltinModule('node:sea');
    return sea.isSea();
  } catch {
    // Older Node without `node:sea`, or any lookup failure → not a SEA.
    return false;
  }
}

export interface SelfExec {
  /** Executable to spawn to re-invoke this CLI. */
  readonly execPath: string;
  /**
   * Leading args before the subcommand: the resolved script path for the
   * `node script.js` form, empty for a SEA (the binary dispatches itself).
   */
  readonly entryArgs: readonly string[];
}

/**
 * Resolve how to re-invoke this CLI as a child process or service unit.
 *
 * SEA: `[<newio>, <subcommand…>]`. Plain Node: `[<node>, <cli.js>, <subcommand…>]`.
 */
export function resolveSelfExec(): SelfExec {
  if (isSeaBinary()) {
    return { execPath: process.execPath, entryArgs: [] };
  }
  const cliEntry = process.argv[1];
  if (typeof cliEntry !== 'string' || cliEntry.length === 0) {
    throw new Error('Cannot resolve the CLI entrypoint (process.argv[1] is unset).');
  }
  // Resolve symlinks (npm bin shim) to the real dist/cli.js.
  return { execPath: process.execPath, entryArgs: [realpathSync(cliEntry)] };
}

/**
 * The stable, on-PATH path to run the daemon *service* from.
 *
 * The versioned installer (install.sh) puts the binary at
 * `~/.local/share/newio/versions/<version>` with a stable `~/.local/bin/newio`
 * symlink. `process.execPath` resolves through that symlink to the versioned
 * file, so baking it into the launchd plist / systemd unit would pin the service
 * to one version and break when that version is pruned on update. Prefer the
 * stable launcher symlink when it points back at this binary, so a version flip
 * applies on the daemon's next start without rewriting the unit.
 *
 * Falls back to `execPath` when there's no such symlink (custom install dir,
 * running from a build dir, or the `node script.js` form — where `execPath` is
 * `node`, not a `newio` launcher).
 */
export function resolveLauncherPath(execPath: string): string {
  const binDir = process.env['NEWIO_BIN_DIR'] ?? join(homedir(), '.local', 'bin');
  const launcher = join(binDir, 'newio');
  try {
    if (realpathSync(launcher) === realpathSync(execPath)) {
      return launcher;
    }
  } catch {
    // No launcher symlink (or it doesn't resolve) — use the binary directly.
  }
  return execPath;
}
