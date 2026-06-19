/**
 * CLI-layer glue for the backend version gate.
 *
 * A commander `preAction` hook runs {@link enforceVersionGate} before each
 * command (see index.ts): a forced verdict aborts the command before it does any
 * work; a deprecation prints a warning and continues. The pure check + caching
 * lives in {@link import('../update/version-gate.js')}.
 */
import type { Command } from 'commander';
import { cliCommandName } from '../sea.js';
import { evaluateVersionGate } from '../update/version-gate.js';
import type { VersionCheckPlatform } from '../update/version-gate.js';

/**
 * Commands that must keep working even on a forced-out connector: the internal MCP
 * transport, the updater itself, and the daemon manage/inspect verbs a user needs
 * to recover. Everything else is gated, so a too-old connector can update or tear
 * down but not start new work.
 */
const GATE_SKIP: ReadonlySet<string> = new Set([
  'mcp-bridge',
  'update',
  'daemon stop',
  'daemon status',
  'daemon logs',
  'daemon uninstall',
  'daemon reload',
]);

/** Build the space-joined subcommand path, e.g. `daemon stop`, `agent start`, `update`. */
export function commandPathOf(cmd: Command): string {
  const names: string[] = [];
  // Walk up to (but not including) the root program, which has a null parent.
  let c: Command = cmd;
  while (c.parent) {
    names.unshift(c.name());
    c = c.parent;
  }
  return names.join(' ');
}

/** Whether the version gate should run before the given command path. */
export function shouldEnforceVersionGate(commandPath: string): boolean {
  return !GATE_SKIP.has(commandPath);
}

/**
 * The sentinel version an *unreleased* build carries: the monorepo's package.json
 * pins `0.0.0`, and the release workflow overwrites it with the real tag version
 * when building a shipped binary (`npm pkg set version=…`, see
 * release-cli-binaries.yml). So a `0.0.0` build is a local/source/e2e build that
 * was never released — and the backend would force-update any version below its
 * floor, so the gate must never run for it. (Released builds, including dev `0.x`
 * like `0.5.2`, carry a real version and stay gated.)
 */
export const UNRELEASED_VERSION = '0.0.0';

/** Whether `version` is the unreleased sentinel — such builds skip the gate. */
export function isUnreleasedBuild(version: string): boolean {
  return version === UNRELEASED_VERSION;
}

export interface VersionGateContext {
  readonly apiBaseUrl: string;
  readonly currentVersion: string;
  readonly platform: VersionCheckPlatform | undefined;
  readonly cachePath: string;
  /** Launcher name source for stage-correct command hints (`newio` vs `newio-dev`). */
  readonly argv0: string;
}

/**
 * Enforce the backend version gate before a command runs. A forced verdict prints
 * an error and exits(1) — aborting before the command does any work. A deprecation
 * prints a warning (TTY-only, like the update notice) and returns. Any check
 * failure (or healthy verdict) falls open and returns without blocking.
 */
export async function enforceVersionGate(ctx: VersionGateContext): Promise<void> {
  if (isUnreleasedBuild(ctx.currentVersion)) {
    return;
  }
  const gate = await evaluateVersionGate({
    apiBaseUrl: ctx.apiBaseUrl,
    currentVersion: ctx.currentVersion,
    platform: ctx.platform,
    cachePath: ctx.cachePath,
  });
  const cmd = cliCommandName(ctx.argv0);
  if (gate.status === 'forced') {
    console.error(
      `\nThis ${cmd} (${ctx.currentVersion}) is no longer supported — the minimum supported version is ${gate.minSupportedVersion}.\n` +
        `Update to continue: run \`${cmd} update\` (or download from ${gate.updateUrl}).`,
    );
    process.exit(1);
  }
  if (gate.status === 'deprecated' && process.stderr.isTTY) {
    console.error(`\n${gate.message}`);
  }
}
