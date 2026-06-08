/**
 * Agent runtime manager — manages the lifecycle of running agent instances.
 *
 * Creates the appropriate AgentInstance subclass based on agent type,
 * delegates start/stop to the instance, and relays status events to the UI.
 */
import type { AgentConfigManager } from './agent-config-manager';
import type { CronStore, CronStoreFactory } from './cron-store';
import type { EngineConfig } from './engine-config';
import type { AgentRuntimeStatus, AgentErrorCode, AgentInfo } from './types';
import type { AgentInstance } from './agent-instance';
import { getLogger } from '@newio/agent-sdk';
import { AgentInstanceImpl } from './agent-instance-impl';

const log = getLogger('agent-runtime-manager');

export interface StatusListener {
  onStatusChanged(agentId: string, status: AgentRuntimeStatus, error?: string, errorCode?: AgentErrorCode): void;
  onApprovalUrl(agentId: string, approvalUrl: string): void;
  onPollAttempt(agentId: string): void;
  onConfigUpdated(agentId: string): void;
  onAgentInfo(agentId: string, info: AgentInfo): void;
}

export class AgentRuntimeManager {
  private readonly instances = new Map<string, AgentInstance>();
  /** Per-agent cron stores, opened on start and closed on stop. */
  private readonly cronStores = new Map<string, CronStore>();
  /** Last browser-approval URL per agent while awaiting approval — for late-attaching clients. */
  private readonly approvalUrls = new Map<string, string>();
  private readonly configManager: AgentConfigManager;
  private readonly cronStoreFactory: CronStoreFactory;
  private readonly listener: StatusListener;
  private readonly engineConfig: EngineConfig;

  constructor(
    configManager: AgentConfigManager,
    cronStoreFactory: CronStoreFactory,
    listener: StatusListener,
    engineConfig: EngineConfig,
  ) {
    this.configManager = configManager;
    this.cronStoreFactory = cronStoreFactory;
    this.listener = listener;
    this.engineConfig = engineConfig;
  }

  getStatus(agentId: string): { status: AgentRuntimeStatus; error?: string; errorCode?: AgentErrorCode } {
    const instance = this.instances.get(agentId);
    return instance
      ? { status: instance.status, error: instance.error, errorCode: instance.errorCode }
      : { status: 'stopped' };
  }

  /** The pending browser-approval URL for an agent, if it is currently awaiting approval. */
  getApprovalUrl(agentId: string): string | undefined {
    return this.approvalUrls.get(agentId);
  }

  start(agentId: string): void {
    const existing = this.instances.get(agentId);
    if (existing && existing.status !== 'stopped' && existing.status !== 'error') {
      return;
    }

    const config = this.configManager.get(agentId);
    if (!config) {
      throw new Error(`Agent ${agentId} not found.`);
    }

    // Prevent two agents with the same Newio username from running simultaneously
    const username = config.newio?.username;
    const normalizedUsername = username?.toLowerCase();
    if (normalizedUsername) {
      for (const [id, instance] of this.instances) {
        if (id !== agentId && instance.status !== 'stopped' && instance.status !== 'error') {
          const otherConfig = this.configManager.get(id);
          if (otherConfig?.newio?.username?.toLowerCase() === normalizedUsername) {
            throw new Error(
              `Another agent "${otherConfig.newio.displayName ?? id}" is already running with username @${username}`,
            );
          }
        }
      }
    }

    const instanceListener = {
      onStatusChanged: (status: AgentRuntimeStatus, error?: string, errorCode?: AgentErrorCode) => {
        // The approval URL is only valid while awaiting approval; drop it once we move on.
        if (status !== 'awaiting_approval') {
          this.approvalUrls.delete(agentId);
        }
        this.listener.onStatusChanged(agentId, status, error, errorCode);
      },
      onApprovalUrl: (approvalUrl: string) => {
        this.approvalUrls.set(agentId, approvalUrl);
        this.listener.onApprovalUrl(agentId, approvalUrl);
      },
      onPollAttempt: () => {
        this.listener.onPollAttempt(agentId);
      },
      onConfigUpdated: () => {
        this.listener.onConfigUpdated(agentId);
      },
      onAgentInfo: (info: AgentInfo) => {
        this.listener.onAgentInfo(agentId, info);
      },
    };

    // Reuse the agent's store across restarts within this manager; open lazily.
    let cronStore = this.cronStores.get(agentId);
    if (!cronStore) {
      cronStore = this.cronStoreFactory(agentId);
      this.cronStores.set(agentId, cronStore);
    }

    const instance: AgentInstance = new AgentInstanceImpl(
      config,
      this.configManager,
      cronStore,
      instanceListener,
      this.engineConfig,
    );

    this.instances.set(agentId, instance);
    log.info(`Starting agent ${agentId} (${username ?? 'no username'})`);
    void instance.start();
  }

  async stop(agentId: string): Promise<void> {
    const instance = this.instances.get(agentId);
    if (!instance) {
      return;
    }
    log.info(`Stopping agent ${agentId}`);
    await instance.stop();
    this.instances.delete(agentId);
    this.approvalUrls.delete(agentId);
    this.cronStores.get(agentId)?.close();
    this.cronStores.delete(agentId);
    log.info(`Agent ${agentId} stopped and removed`);
  }

  async stopAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    log.info(`Stopping all agents (${String(ids.length)})`);
    await Promise.all(ids.map((id) => this.stop(id)));
    log.info('All agents stopped');
  }

  getAgentInfo(agentId: string): AgentInfo | undefined {
    return this.instances.get(agentId)?.getAgentInfo();
  }
}
