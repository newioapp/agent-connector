/**
 * DaemonConnector — typed application-level API over DaemonClient.
 *
 * Wraps the raw JSON-RPC transport with typed methods for agent and daemon management.
 */
import type { AgentConfig, AddAgentInput, UpdateAgentInput, AgentStatusInfo, AgentInfo } from '@newio/agent-engine';
import { DaemonClient, type DaemonNotificationHandlers } from './client.js';

/** Result of `daemon.handshake` — protocol version plus the daemon's own version. */
export interface DaemonHandshake {
  readonly protocolVersion: number;
  readonly version: string;
}

export class DaemonConnector {
  readonly client: DaemonClient;

  constructor(client: DaemonClient) {
    this.client = client;
  }

  connect(socketPath: string, handlers: DaemonNotificationHandlers = {}): Promise<void> {
    return this.client.connect(socketPath, handlers);
  }

  disconnect(): void {
    this.client.disconnect();
  }

  // Agent methods
  listAgents(): Promise<AgentStatusInfo[]> {
    return this.client.call('agent.list');
  }
  addAgent(input: AddAgentInput): Promise<AgentConfig> {
    return this.client.call('agent.add', [input]);
  }
  updateAgent(agentId: string, updates: UpdateAgentInput): Promise<AgentConfig> {
    return this.client.call('agent.update', [agentId, updates]);
  }
  removeAgent(agentId: string): Promise<void> {
    return this.client.call('agent.remove', [agentId]);
  }
  startAgent(agentId: string): Promise<void> {
    return this.client.call('agent.start', [agentId]);
  }
  stopAgent(agentId: string): Promise<void> {
    return this.client.call('agent.stop', [agentId]);
  }
  getAgentInfo(agentId: string): Promise<AgentInfo | null> {
    return this.client.call('agent.getInfo', [agentId]);
  }
  updateAgentEnvVars(agentId: string, envVars: Record<string, string>, shell?: string): Promise<AgentConfig> {
    return this.client.call('agent.updateEnvVars', [agentId, envVars, shell]);
  }

  // Environment methods
  listShells(): Promise<string[]> {
    return this.client.call('env.listShells');
  }
  getShellEnv(shell: string): Promise<Record<string, string>> {
    return this.client.call('env.getShellEnv', [shell]);
  }

  // Daemon methods
  /** Negotiate protocol version + daemon version. Use to detect client/daemon skew. */
  handshake(): Promise<DaemonHandshake> {
    return this.client.call('daemon.handshake');
  }
  version(): Promise<string> {
    return this.client.call('daemon.version');
  }
  ping(): Promise<'pong'> {
    return this.client.call('daemon.ping');
  }
  reload(): Promise<void> {
    return this.client.call('daemon.reload');
  }
  stop(): Promise<void> {
    return this.client.call('daemon.stop');
  }
}
