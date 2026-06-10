/**
 * AgentSession — common interface for agent-type-specific sessions.
 *
 * Each session maps to one context window on the agent platform side.
 * A single agent instance manages multiple sessions.
 */
import type { SessionStreamSegment, SessionStatusListener, PermissionHandler, SessionType } from './types';
import type {
  LiveSessionInfoResponse,
  CancelSessionResponse,
  CompactSessionResponse,
  SessionConfigUpdate,
} from '@newio/agent-sdk';

export interface AgentSession {
  readonly type: SessionType;
  /** ConversationId, __contact__, cron id job */
  readonly externalReferenceId: string;

  /** Semver version of the prompt formatter used when this session was created. */
  readonly promptFormatterVersion: string;

  /** Agent-platform-specific session ID (e.g., ACP sessionId). */
  readonly correlationId: string;

  /** Whether this session can be disposed (e.g., via idle cleanup). */
  readonly disposable: boolean;

  /** Currently being processed conversation, can be undefined if processing a background task from a cron schedule or a contact event. */
  readonly currentConversationId?: string;

  /** Send a prompt and yield aggregated response segments as they arrive. */
  prompt(text: string, conversationId?: string): AsyncGenerator<SessionStreamSegment>;

  /** Register a listener for session status changes. Replaces any previous listener. */
  onStatus(listener: SessionStatusListener): void;

  onPermissionRequest(handler: PermissionHandler): void;

  /** Register a one-shot callback for context pressure (80% usage). */
  onContextPressure(cb: () => void): void;

  /** Dispose the session (kill process, free resources). */
  dispose(): Promise<void>;

  /** Cancel the current prompt turn. */
  cancel(): Promise<void>;

  /** Get live session info (models, modes, cancel/compact availability). */
  getLiveSessionInfo(): LiveSessionInfoResponse;

  /** Handle cancel session signal. */
  handleCancelSession(): Promise<CancelSessionResponse>;

  /** Handle compact session signal. */
  handleCompactSession(): Promise<CompactSessionResponse>;

  /** Apply session config (acpModel/acpMode) from the backend. Reports corrected values on failure. */
  applySessionConfig(config: SessionConfigUpdate): Promise<void>;
}
