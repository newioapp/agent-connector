/**
 * AgentSession — common interface for agent-type-specific sessions.
 *
 * Each session maps to one context window on the agent platform side.
 * A single agent instance manages multiple sessions.
 */
import type { SessionStreamSegment, SessionStatusListener, PermissionHandler } from './types';
import type { AgentCapability, InvokeCapabilityPayload, InvokeCapabilityResponsePayload } from '@newio/agent-sdk';

export interface AgentSession {
  /** Newio platform assigned session ID. */
  readonly sessionId: string;

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

  /** Dispose the session (kill process, free resources). */
  dispose(): Promise<void>;

  /** Cancel the current prompt turn. */
  cancel(): Promise<void>;

  /** Get the capabilities this session supports. */
  getCapabilities(): readonly AgentCapability[];

  /** Handle a session-scoped capability invocation. */
  handleCapabilityInvocation(invocation: InvokeCapabilityPayload): Promise<InvokeCapabilityResponsePayload>;
}
