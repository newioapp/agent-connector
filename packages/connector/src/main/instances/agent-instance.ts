/**
 * Agent instance interface — defines the lifecycle contract for running agents.
 *
 * Each agent type (Claude, Kiro CLI) provides its own implementation.
 * The instance manages its own SDK auth, WebSocket connection, and agent-specific logic.
 */
import type { AgentRuntimeStatus } from '../../shared/types';

export interface AgentInstanceListener {
  onStatusChanged(status: AgentRuntimeStatus, error?: string): void;
  onApprovalUrl(approvalUrl: string): void;
  onConfigUpdated(): void;
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
}
