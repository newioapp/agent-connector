/**
 * Agent instance interface — defines the lifecycle contract for running agents.
 *
 * Each agent type provides its own implementation.
 * The instance manages its own SDK auth, WebSocket connection, and agent-specific logic.
 */
import type { AgentRuntimeStatus, AgentInfo } from './types';

export interface AgentInstanceListener {
  onStatusChanged(status: AgentRuntimeStatus, error?: string): void;
  onApprovalUrl(approvalUrl: string): void;
  onPollAttempt(): void;
  onConfigUpdated(): void;
  onAgentInfo(info: AgentInfo): void;
  onAgentSessionConfigUpdated(sessionId: string, models?: AgentSessionConfig, modes?: AgentSessionConfig): void;
}

export interface ConfigureAgentInput {
  readonly model?: string;
  readonly mode?: string;
  /** If undefined, applies to all sessions. */
  readonly sessionId?: string;
}

export interface AgentSessionConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface AgentSessionConfig {
  readonly options: readonly AgentSessionConfigOption[];
  readonly selectedId: string;
}

export interface AgentInstance {
  /** Start the agent — authenticate, connect WebSocket, begin processing. */
  start(): Promise<void>;
  /** Stop the agent — disconnect, revoke tokens, clean up. */
  stop(): Promise<void>;
  /** Current runtime status. */
  readonly status: AgentRuntimeStatus;
  /** Error message if status is 'error'. */
  readonly error?: string;
  /** Runtime agent info — available after initialization. */
  getAgentInfo(): AgentInfo | undefined;
  /** List available models from the representative session. */
  listModels(): AgentSessionConfig | undefined;
  /** List available modes from the representative session. */
  listModes(): AgentSessionConfig | undefined;
  /** Configure model/mode on one or all sessions. */
  configureAgent(input: ConfigureAgentInput): Promise<void>;
}
