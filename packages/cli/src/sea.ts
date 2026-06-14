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
import { join, resolve, delimiter, basename } from 'path';

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

/**
 * The on-PATH command name this CLI is installed as: `newio` (prod), or the
 * stage-named `newio-dev` / `newio-integ` for internal-testing builds. Derived
 * from how the CLI was invoked (`argv0`), defaulting to `newio` for anything
 * that isn't a recognizable `newio*` command (e.g. `node` when run from source).
 *
 * Used both to locate the stable launcher symlink (so a stage-named install
 * resolves to its own symlink) and to print correct command hints in help text.
 */
export function cliCommandName(argv0: string = process.argv0): string {
  const base = basename(argv0);
  return base.startsWith('newio') ? base : 'newio';
}

/**
 * The first subcommand token (e.g. `update`, `mcp-bridge`), or undefined if none.
 *
 * SEA-aware: a SEA's `process.argv` is `[execPath, ...userArgs]` with NO script
 * slot, so the subcommand is at index 1; the `node script.js …` form has the
 * script at index 1, pushing the subcommand to index 2. Mirrors the offset logic
 * in {@link resolveSelfExec}, which is why the two must agree on SEA detection.
 */
export function cliSubcommand(argv: readonly string[] = process.argv): string | undefined {
  return argv[isSeaBinary() ? 1 : 2];
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
 * `~/.local/share/newio/versions/<version>` with a stable launcher symlink (by
 * default `~/.local/bin/newio`, or a custom `NEWIO_BIN_DIR`). `process.execPath`
 * resolves *through* that symlink to the versioned file, so baking it into the
 * launchd plist / systemd unit would pin the service to one version and break
 * when that version is pruned on update. Prefer a stable launcher symlink that
 * resolves back to this binary, so a version flip applies on the daemon's next
 * start without rewriting the unit.
 *
 * Candidates, best first:
 *   1. how the CLI was actually invoked — `process.argv0` preserves the
 *      un-resolved launcher path (or the PATH command name), so this captures a
 *      custom install dir even when `NEWIO_BIN_DIR` isn't set at daemon-start
 *      time (unlike `execPath`/`argv[0]`, which Node resolves);
 *   2. an explicit `NEWIO_BIN_DIR`;
 *   3. the default `~/.local/bin`.
 * Falls back to `execPath` when none resolve back to this binary (e.g. invoked
 * by its versioned real path, a build dir, or the `node script.js` form where
 * `execPath` is `node`).
 */
export function resolveLauncherPath(execPath: string, argv0: string = process.argv0): string {
  let realExec: string;
  try {
    realExec = realpathSync(execPath);
  } catch {
    return execPath;
  }

  // The installed command name (newio / newio-dev / newio-integ) the stable
  // launcher symlink is named after — derived from how this CLI was invoked.
  const cmdName = cliCommandName(argv0);
  const candidates: string[] = [];
  const invoked = resolveInvokedLauncher(argv0);
  if (invoked !== undefined) {
    candidates.push(invoked);
  }
  const binEnv = process.env['NEWIO_BIN_DIR'];
  if (typeof binEnv === 'string' && binEnv.length > 0) {
    candidates.push(join(binEnv, cmdName));
  }
  candidates.push(join(homedir(), '.local', 'bin', cmdName));

  for (const launcher of candidates) {
    // Want a *different* path that resolves to the same binary (a stable
    // symlink), not the versioned file itself.
    if (launcher === realExec) {
      continue;
    }
    try {
      if (realpathSync(launcher) === realExec) {
        return launcher;
      }
    } catch {
      // not a real path — skip
    }
  }
  return execPath;
}

/**
 * Turn `process.argv0` into an absolute path: a slash-containing path is
 * resolved against cwd; a bare command name is looked up on `PATH` (the shell
 * runs the first match, so that's the launcher that was invoked).
 */
function resolveInvokedLauncher(argv0: string): string | undefined {
  if (argv0.length === 0) {
    return undefined;
  }
  if (argv0.includes('/')) {
    return resolve(argv0);
  }
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = join(dir, argv0);
    try {
      realpathSync(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}
