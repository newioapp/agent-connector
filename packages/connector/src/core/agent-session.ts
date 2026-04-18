/**
 * AgentSession — common interface for agent-type-specific sessions.
 *
 * Each session maps to one context window on the agent platform side.
 * A single agent instance manages multiple sessions.
 */
import type { SessionStreamSegment } from './session-stream';

export type SessionStatus = 'thinking' | 'typing' | 'tool_calling' | 'idle';

export type SessionStatusListener = (status: SessionStatus) => void;

export interface AgentSession {
  /** Agent-platform-specific session ID (e.g., ACP sessionId). */
  readonly correlationId: string;

  /** Send a prompt and yield aggregated response segments as they arrive. */
  prompt(text: string): AsyncGenerator<SessionStreamSegment>;

  /** Set the model for this session. */
  setModel(modelId: string): Promise<void>;

  /** Set the operational mode for this session. */
  setMode(modeId: string): Promise<void>;

  /** Register a listener for session status changes. Replaces any previous listener. */
  onStatus(listener: SessionStatusListener): void;

  /** Dispose the session (kill process, free resources). */
  dispose(): void;
}
