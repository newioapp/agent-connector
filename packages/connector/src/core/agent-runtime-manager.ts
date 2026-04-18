/**
 * Agent runtime manager — manages the lifecycle of running agent instances.
 *
 * Creates the appropriate AgentInstance subclass based on agent type,
 * delegates start/stop to the instance, and relays status events to the UI.
 */
import type { AgentConfigManager } from './agent-config-manager';
import type { SessionStore } from './session-store';
import type { AgentRuntimeStatus } from './types';
import type { AgentInstance, AgentSessionConfig, ConfigureAgentInput } from './agent-instance';
import { AcpAgentInstance } from './acp-agent-instance';

export interface StatusListener {
  onStatusChanged(agentId: string, status: AgentRuntimeStatus, error?: string): void;
  onApprovalUrl(agentId: string, approvalUrl: string): void;
  onPollAttempt(agentId: string): void;
  onConfigUpdated(agentId: string): void;
}

export class AgentRuntimeManager {
  private readonly instances = new Map<string, AgentInstance>();
  private readonly configManager: AgentConfigManager;
  private readonly sessionStore: SessionStore;
  private readonly listener: StatusListener;

  constructor(configManager: AgentConfigManager, sessionStore: SessionStore, listener: StatusListener) {
    this.configManager = configManager;
    this.sessionStore = sessionStore;
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
      onPollAttempt: () => {
        this.listener.onPollAttempt(agentId);
      },
      onConfigUpdated: () => {
        this.listener.onConfigUpdated(agentId);
      },
    };

    const instance = new AcpAgentInstance(config, this.configManager, this.sessionStore, instanceListener);

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

  listModels(agentId: string): AgentSessionConfig | undefined {
    return this.instances.get(agentId)?.listModels();
  }

  listModes(agentId: string): AgentSessionConfig | undefined {
    return this.instances.get(agentId)?.listModes();
  }

  /** Configure model/mode on one or all sessions, and persist to config. */
  async configureAgent(agentId: string, input: ConfigureAgentInput): Promise<void> {
    const instance = this.instances.get(agentId);
    if (instance) {
      await instance.configureAgent(input);
    }
    // Persist to config
    const existing = this.configManager.get(agentId);
    if (existing?.acp) {
      this.configManager.update(agentId, {
        acp: {
          ...existing.acp,
          ...(input.model !== undefined ? { defaultModel: input.model } : {}),
          ...(input.mode !== undefined ? { defaultMode: input.mode } : {}),
        },
      });
    }
  }
}
