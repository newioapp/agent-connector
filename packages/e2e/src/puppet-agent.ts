/**
 * Daemon-tier puppet-agent launch, in two halves so callers can configure many
 * agents and bring a subset online:
 *
 *  - {@link addPuppetAgent}: `agent add` one custom puppet config on a running
 *    {@link DaemonSandbox} (no start). Returns its config id.
 *  - {@link startAddedAgent}: seed an added config's credentials + control socket
 *    and `agent start` it, waiting until it reaches `running`.
 *  - {@link startPuppetAgent}: the common case — add then start in one call.
 *
 * All three drive the CLI the way a user does, so they exercise the full shipped
 * stack: the CLI entry + commands, the daemon process, `runDaemon`'s own
 * EngineConfig, the RPC transport, and on-disk config — where {@link ConnectorHarness}
 * embeds the runtime in-process and skips all of that.
 *
 * The one thing the CLI can't do is inject credentials (tokens only ever come
 * from the approval flow). To keep the test deterministic {@link startAddedAgent}
 * writes the agent's `.credentials.json` directly — the single byte of state the
 * connector's own approval-poll would otherwise have written. Tokens come from
 * `OwnerBackend` (the human side legitimately registers + approves the agent).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionMode } from '@newio/agent-engine';
import type { DaemonSandbox } from './daemon-sandbox.js';
import type { PuppetDriver } from '@newio/acp-puppet';
import type { AgentCredentials } from './backend.js';

export interface AddPuppetAgentOptions {
  /** Newio username the config is attached to (must be an approved account to start). */
  readonly username: string;
  readonly driver: PuppetDriver;
  /** Passed to `agent add --session-mode`; omit to take the CLI default (isolated). */
  readonly sessionMode?: SessionMode;
}

/**
 * `agent add` one custom puppet config (no start), returning its config id. Safe
 * to call repeatedly against one sandbox — including several configs that share a
 * username — to populate a fleet on a single daemon.
 */
export async function addPuppetAgent(sandbox: DaemonSandbox, options: AddPuppetAgentOptions): Promise<string> {
  // Define the agent through the CLI (no JS config code). Use the path-safe
  // --command/--arg form so a runtime/bin path with spaces still works.
  const added = await sandbox.cli([
    'agent',
    'add',
    '--type',
    'custom',
    '--username',
    options.username,
    ...(options.sessionMode ? ['--session-mode', options.sessionMode] : []),
    '--command',
    options.driver.command,
    ...options.driver.args.flatMap((arg) => ['--arg', arg]),
  ]);
  return parseAddedAgentId(added.stdout);
}

export interface StartAddedAgentOptions {
  /** Credentials for the account the config is attached to (seeded as `.credentials.json`). */
  readonly agent: AgentCredentials;
  /** The driver whose control socket the puppet will connect back to. */
  readonly driver: PuppetDriver;
  /** How long to wait for the agent to reach `running` (greeting round-trip completes). */
  readonly startTimeoutMs?: number;
}

/**
 * Seed an already-added config's credentials + control socket, then `agent start`
 * it and wait until it reaches `running`. The sandbox's lifecycle stays with the
 * caller — on failure this throws with the daemon log attached but does NOT stop
 * the sandbox.
 */
export async function startAddedAgent(
  sandbox: DaemonSandbox,
  agentId: string,
  options: StartAddedAgentOptions,
): Promise<void> {
  try {
    // Token seam: write the credentials the approval-poll would have persisted.
    writeFileSync(
      join(sandbox.dataDir, 'agents', agentId, '.credentials.json'),
      JSON.stringify({ accessToken: options.agent.accessToken, refreshToken: options.agent.refreshToken }),
      { mode: 0o600 },
    );

    // Point the puppet at the driver's control socket (merges with the env
    // `agent add` captured, so PATH etc. survive).
    await sandbox.cli(['agent', 'env', 'set', agentId, `PUPPET_CONTROL_SOCKET=${options.driver.socketPath}`]);

    // Start it — blocks until a terminal status (running/error/stopped).
    const started = await sandbox.runCli(['agent', 'start', agentId], options.startTimeoutMs ?? 90_000);
    const reachedRunning = started.stdout
      .split('\n')
      .map((line) => line.trim())
      .includes('running');
    if (!reachedRunning) {
      throw new Error(`agent did not reach running:\n${started.stdout}\n${started.stderr}`);
    }
  } catch (err: unknown) {
    const detail = sandbox.daemonLog.trim();
    throw new Error(`startAddedAgent failed: ${String(err)}${detail ? `\n--- daemon log ---\n${detail}` : ''}`);
  }
}

export interface PuppetAgentOptions {
  readonly agent: AgentCredentials;
  readonly driver: PuppetDriver;
  /** Passed to `agent add --session-mode`; omit to take the CLI default (isolated). */
  readonly sessionMode?: SessionMode;
  /** How long to wait for the agent to reach `running` (greeting round-trip completes). */
  readonly startTimeoutMs?: number;
}

/**
 * Add + start one puppet agent on `sandbox` (the common single-agent path),
 * returning its config id. Composes {@link addPuppetAgent} + {@link startAddedAgent}.
 */
export async function startPuppetAgent(sandbox: DaemonSandbox, options: PuppetAgentOptions): Promise<string> {
  const agentId = await addPuppetAgent(sandbox, {
    username: options.agent.username,
    driver: options.driver,
    sessionMode: options.sessionMode,
  });
  await startAddedAgent(sandbox, agentId, {
    agent: options.agent,
    driver: options.driver,
    startTimeoutMs: options.startTimeoutMs,
  });
  return agentId;
}

/** Parse the agent id out of `agent add`'s "Added agent <id> for @username." line. */
function parseAddedAgentId(stdout: string): string {
  const match = /Added agent (\S+) for/.exec(stdout);
  if (!match?.[1]) {
    throw new Error(`could not parse agent id from \`agent add\` output: ${stdout}`);
  }
  return match[1];
}
