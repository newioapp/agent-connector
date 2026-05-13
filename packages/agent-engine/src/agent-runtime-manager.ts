/**
 * Agent runtime manager — manages the lifecycle of running agent instances.
 *
 * Creates the appropriate AgentInstance subclass based on agent type,
 * delegates start/stop to the instance, and relays status events to the UI.
 */
import type { AgentConfigManager } from './agent-config-manager';
import type { CronStore } from './cron-store';
import type { EngineConfig } from './engine-config';
import type { AgentRuntimeStatus, AgentInfo } from './types';
import type { AgentInstance } from './agent-instance';
import { getLogger } from '@newio/agent-sdk';
import { AgentInstanceImpl } from './agent-instance-impl';

const log = getLogger('agent-runtime-manager');

export interface StatusListener {
  onStatusChanged(agentId: string, status: AgentRuntimeStatus, error?: string): void;
  onApprovalUrl(agentId: string, approvalUrl: string): void;
  onPollAttempt(agentId: string): void;
  onConfigUpdated(agentId: string): void;
  onAgentInfo(agentId: string, info: AgentInfo): void;
}

export class AgentRuntimeManager {
  private readonly instances = new Map<string, AgentInstance>();
  private readonly configManager: AgentConfigManager;
  private readonly cronStore: CronStore;
  private readonly listener: StatusListener;
  private readonly engineConfig: EngineConfig;

  constructor(
    configManager: AgentConfigManager,
    cronStore: CronStore,
    listener: StatusListener,
    engineConfig: EngineConfig,
  ) {
    this.configManager = configManager;
    this.cronStore = cronStore;
    this.listener = listener;
    this.engineConfig = engineConfig;
  }

  getStatus(agentId: string): { status: AgentRuntimeStatus; error?: string } {
    const instance = this.instances.get(agentId);
    return instance ? { status: instance.status, error: instance.error } : { status: 'stopped' };
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
    if (username) {
      for (const [id, instance] of this.instances) {
        if (id !== agentId && instance.status !== 'stopped' && instance.status !== 'error') {
          const otherConfig = this.configManager.get(id);
          if (otherConfig?.newio?.username === username) {
            throw new Error(
              `Another agent "${otherConfig.newio.displayName ?? id}" is already running with username @${username}`,
            );
          }
        }
      }
    }

    const instanceListener = {
      onStatusChanged: (status: AgentRuntimeStatus, error?: string) => {
        this.listener.onStatusChanged(agentId, status, error);
      },
      onApprovalUrl: (approvalUrl: string) => {
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

    const instance = new AgentInstanceImpl(
      config,
      this.configManager,
      this.cronStore,
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
