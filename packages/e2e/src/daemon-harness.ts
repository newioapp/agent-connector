/**
 * DaemonHarness — boots the connector exactly as it ships and configures it the
 * way a user does: a real `newio` daemon ({@link DaemonSandbox}) driven by the
 * real CLI subcommands (`agent add` / `agent env set` / `agent start`), wired to
 * a deterministic puppet.
 *
 * Where {@link ConnectorHarness} embeds the agent runtime in-process (fast, but
 * skips the CLI/daemon/RPC plumbing and hand-rolls its own EngineConfig), this
 * runs the full shipped stack: the CLI entry + commands, the daemon process,
 * `runDaemon`'s own EngineConfig (bridge command via `resolveSelfExec`,
 * stage-suffixed dirs), the RPC transport, and on-disk config — all defined
 * through the CLI rather than JavaScript.
 *
 * The one thing the CLI can't do is inject credentials (tokens only ever come
 * from the approval flow). To keep the test deterministic we write the agent's
 * `.credentials.json` directly — the single byte of state the connector's own
 * approval-poll would otherwise have written. Tokens come from `OwnerBackend`
 * (the human side legitimately registers + approves the agent).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonSandbox } from './daemon-sandbox.js';
import type { PuppetDriver } from '@newio/acp-puppet';
import type { AgentCredentials } from './backend.js';

export interface DaemonHarnessOptions {
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
  readonly agent: AgentCredentials;
  readonly driver: PuppetDriver;
  /** How long to wait for the agent to reach `running` (greeting round-trip completes). */
  readonly startTimeoutMs?: number;
}

export class DaemonHarness {
  private constructor(
    private readonly sandbox: DaemonSandbox,
    readonly agentConfigId: string,
  ) {}

  static async start(options: DaemonHarnessOptions): Promise<DaemonHarness> {
    const sandbox = await DaemonSandbox.start({ apiBaseUrl: options.apiBaseUrl, wsUrl: options.wsUrl });
    try {
      // Define the agent through the CLI (no JS config code). Use the path-safe
      // --command/--arg form so a runtime/bin path with spaces still works.
      const added = await sandbox.cli([
        'agent',
        'add',
        '--type',
        'custom',
        '--username',
        options.agent.username,
        '--command',
        options.driver.command,
        ...options.driver.args.flatMap((arg) => ['--arg', arg]),
      ]);
      const agentId = parseAddedAgentId(added.stdout);

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

      return new DaemonHarness(sandbox, agentId);
    } catch (err: unknown) {
      const detail = sandbox.daemonLog.trim();
      await sandbox.stop();
      throw new Error(
        `DaemonHarness failed to start: ${String(err)}${detail ? `\n--- daemon log ---\n${detail}` : ''}`,
      );
    }
  }

  async stop(): Promise<void> {
    await this.sandbox.stop();
  }
}

/** Parse the agent id out of `agent add`'s "Added agent <id> for @username." line. */
function parseAddedAgentId(stdout: string): string {
  const match = /Added agent (\S+) for/.exec(stdout);
  if (!match?.[1]) {
    throw new Error(`could not parse agent id from \`agent add\` output: ${stdout}`);
  }
  return match[1];
}
