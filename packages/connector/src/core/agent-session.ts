/**
 * AgentSession — common interface for agent-type-specific sessions.
 *
 * Each session maps to one context window on the agent platform side.
 * A single agent instance manages multiple sessions.
 */
import type { SessionStreamSegment, SessionStatusListener } from './types';

export interface AgentSession {
  /** Agent-platform-specific session ID (e.g., ACP sessionId). */
  readonly correlationId: string;

  /** Whether this session can be disposed (e.g., via idle cleanup). */
  readonly disposable: boolean;

  /** Send a prompt and yield aggregated response segments as they arrive. */
  prompt(text: string): AsyncGenerator<SessionStreamSegment>;

  /** Set the model for this session. */
  setModel(modelId: string): Promise<void>;

  /** Set the operational mode for this session. */
  setMode(modeId: string): Promise<void>;

  /** Register a listener for session status changes. Replaces any previous listener. */
  onStatus(listener: SessionStatusListener): void;

  /** Dispose the session (kill process, free resources). */
  dispose(): Promise<void>;
}
