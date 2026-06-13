/**
 * ConnectorHarness — boots the real connector runtime (AgentRuntimeManager +
 * AgentInstanceImpl) against a live backend, wired to a deterministic puppet
 * instead of a real ACP agent.
 *
 * This is the production code path (same as the daemon), minus the launchd/systemd
 * service shell: a FileAgentConfigManager seeded with a `custom` agent pointing at
 * the puppet binary plus pre-obtained agent tokens, so no browser approval is
 * needed. The puppet's behavior is scripted live through the PuppetDriver.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  AgentRuntimeManager,
  FileAgentConfigManager,
  JsonCronStore,
  type EngineConfig,
  type StatusListener,
  type SessionMode,
} from '@newio/agent-engine';
import type { PuppetDriver } from '@newio/acp-puppet';
import type { AgentCredentials } from './backend.js';

export interface ConnectorHarnessOptions {
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
  readonly stage?: 'dev' | 'integ' | 'prod';
  readonly agent: AgentCredentials;
  readonly driver: PuppetDriver;
  readonly sessionMode?: SessionMode;
  /** How long to wait for the agent to reach `running` (greeting round-trip completes). */
  readonly startTimeoutMs?: number;
}

export class ConnectorHarness {
  private constructor(
    private readonly manager: AgentRuntimeManager,
    private readonly dataDir: string,
    readonly agentConfigId: string,
  ) {}

  static async start(options: ConnectorHarnessOptions): Promise<ConnectorHarness> {
    const dataDir = mkdtempSync(join(tmpdir(), 'newio-e2e-'));
    const configManager = new FileAgentConfigManager(dataDir);

    const config = configManager.add({
      type: 'custom',
      newioUsername: options.agent.username,
      sessionMode: options.sessionMode ?? 'isolated',
      acp: {
        command: options.driver.command,
        args: [...options.driver.args],
        cwd: dataDir,
      },
      // Mirror what env-sync would capture in real use: the puppet needs the
      // control socket, and the connector's `node` preflight + MCP bridge need a
      // PATH that resolves `node` (the spawn env is otherwise an identity-only
      // allowlist that may omit it).
      envVars: {
        PUPPET_CONTROL_SOCKET: options.driver.socketPath,
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      },
    });
    configManager.setNewioIdentity(config.id, {
      agentId: options.agent.agentId,
      username: options.agent.username,
    });
    configManager.setTokens(config.id, {
      accessToken: options.agent.accessToken,
      refreshToken: options.agent.refreshToken,
    });

    // Run the MCP bridge the same way evals do — `node <engine bridge entry>` —
    // since the engine is always present in this workspace. createRequire().resolve
    // honors the package's `./mcp-bridge` export and works under both tsx/vitest
    // and the bundled build (unlike import.meta.resolve, absent in vitest's SSR).
    const mcpBridgePath = createRequire(import.meta.url).resolve('@newio/agent-engine/mcp-bridge');
    const engineConfig: EngineConfig = {
      apiBaseUrl: options.apiBaseUrl,
      wsUrl: options.wsUrl,
      stage: options.stage ?? 'dev',
      appDisplayName: 'Newio E2E Harness',
      appVersion: '0.0.0-e2e',
      dataDir,
      mcpBridgeCommand: process.execPath,
      mcpBridgeArgsPrefix: [mcpBridgePath],
      mcpBridgeIsSelfContained: false,
    };

    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const listener: StatusListener = {
      onStatusChanged: (_agentId, status, error) => {
        if (status === 'running') {
          resolveReady();
        } else if (status === 'error') {
          rejectReady(new Error(`Agent entered error state: ${error ?? 'unknown'}`));
        }
      },
      onApprovalUrl: () => rejectReady(new Error('Agent unexpectedly awaiting approval — tokens were not accepted')),
      onPollAttempt: () => {},
      onConfigUpdated: () => {},
      onAgentInfo: () => {},
    };

    const cronStoreFactory = (agentId: string): JsonCronStore =>
      new JsonCronStore(join(dataDir, 'agents', agentId, 'cron.json'));

    const manager = new AgentRuntimeManager(configManager, cronStoreFactory, listener, engineConfig);
    manager.start(config.id);

    try {
      await withTimeout(ready, options.startTimeoutMs ?? 60_000, 'agent did not reach running state');
    } catch (err) {
      await manager.stopAll().catch(() => {});
      rmSync(dataDir, { recursive: true, force: true });
      throw err;
    }

    return new ConnectorHarness(manager, dataDir, config.id);
  }

  async stop(): Promise<void> {
    await this.manager.stopAll();
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label} (${ms}ms)`)), ms)),
  ]);
}
