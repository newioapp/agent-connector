/**
 * AgentSession — common interface for agent-type-specific sessions.
 *
 * Each session maps to one context window on the agent platform side.
 * A single agent instance manages multiple sessions.
 */
import type { SessionStreamSegment, SessionStatusListener, PermissionHandler } from './types';
import type { AgentSessionConfig } from './agent-instance';

export interface AgentSession {
  /** Newio platform assigned session ID. */
  readonly sessionId: string;

  readonly promptFormatterVersion: string;

  /** Agent-platform-specific session ID (e.g., ACP sessionId). */
  readonly correlationId: string;

  /** Whether this session can be disposed (e.g., via idle cleanup). */
  readonly disposable: boolean;

  /** Currently being processed conversation, can be undefined if processing a background task from a cron schedule or a contact event. */
  readonly currentConversationId?: string;

  /** Send a prompt and yield aggregated response segments as they arrive. */
  prompt(text: string, conversationId?: string): AsyncGenerator<SessionStreamSegment>;

  /** Set the model for this session. */
  setModel(modelId: string): Promise<void>;

  /** Set the operational mode for this session. */
  setMode(modeId: string): Promise<void>;

  /** Register a listener for session status changes. Replaces any previous listener. */
  onStatus(listener: SessionStatusListener): void;

  onPermissionRequest(handler: PermissionHandler): void;

  /** List available models for this session. */
  listModels(): AgentSessionConfig | undefined;

  /** List available modes for this session. */
  listModes(): AgentSessionConfig | undefined;

  /** Register a listener for model/mode config changes. */
  onConfigChanged(listener: () => void): void;

  /** Dispose the session (kill process, free resources). */
  dispose(): Promise<void>;
}
