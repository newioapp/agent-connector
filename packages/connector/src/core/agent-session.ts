/**
 * AgentSession — common interface for agent-type-specific sessions.
 *
 * Each session maps to one context window on the agent platform side.
 * A single agent instance manages multiple sessions.
 */

export type SessionStatus = 'thinking' | 'typing' | 'tool_calling' | 'idle';

export type SessionStatusListener = (status: SessionStatus) => void;

export interface AgentSession {
  /** Agent-platform-specific session ID (e.g., ACP sessionId). */
  readonly correlationId: string;

  /** Send a prompt to the session and return the response text. */
  prompt(text: string): Promise<string | undefined>;

  /** Register a listener for session status changes. Replaces any previous listener. */
  onStatus(listener: SessionStatusListener): void;

  /** Dispose the session (kill process, free resources). */
  dispose(): void;
}
