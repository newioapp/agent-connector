/**
 * Agent runtime manager — manages the lifecycle of running agent instances.
 *
 * Creates the appropriate AgentInstance subclass based on agent type,
 * delegates start/stop to the instance, and relays status events to the UI.
 */
import type Store from 'electron-store';
import type { StoreSchema } from './store';
import type { AgentConfigManager } from './agent-config-manager';
import type { AgentRuntimeStatus } from '../shared/types';
import type { AgentInstance } from './instances/agent-instance';
import { ClaudeInstance } from './instances/claude-instance';
import { KiroCliInstance } from './instances/kiro-cli-instance';

export interface StatusListener {
  onStatusChanged(agentId: string, status: AgentRuntimeStatus, error?: string): void;
  onApprovalUrl(agentId: string, approvalUrl: string): void;
  onConfigUpdated(agentId: string): void;
}

export class AgentRuntimeManager {
  private readonly instances = new Map<string, AgentInstance>();
  private readonly store: Store<StoreSchema>;
  private readonly configManager: AgentConfigManager;
  private readonly listener: StatusListener;

  constructor(store: Store<StoreSchema>, configManager: AgentConfigManager, listener: StatusListener) {
    this.store = store;
    this.configManager = configManager;
    this.listener = listener;
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

    const instanceListener = {
      onStatusChanged: (status: AgentRuntimeStatus, error?: string) => {
        this.listener.onStatusChanged(agentId, status, error);
      },
      onApprovalUrl: (approvalUrl: string) => {
        this.listener.onApprovalUrl(agentId, approvalUrl);
      },
      onConfigUpdated: () => {
        this.listener.onConfigUpdated(agentId);
      },
    };

    let instance: AgentInstance;
    switch (config.type) {
      case 'claude-code':
        instance = new ClaudeInstance(config, this.store, this.configManager, instanceListener);
        break;
      case 'kiro-cli':
        instance = new KiroCliInstance(config, this.store, this.configManager, instanceListener);
        break;
    }

    this.instances.set(agentId, instance);
    void instance.start();
  }

  async stop(agentId: string): Promise<void> {
    const instance = this.instances.get(agentId);
    if (!instance) {
      return;
    }
    await instance.stop();
    this.instances.delete(agentId);
  }

  async stopAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }
}
