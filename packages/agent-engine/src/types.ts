/**
 * Shared types used across the engine.
 */
import type {
  ActionRequest,
  ActionResponse,
  ActivityStatus,
  AppEventHandlers,
  CancelSessionHandler,
  CompactSessionHandler,
  LiveSessionInfoHandler,
  LoadSessionMemoryResponse,
  MemoryScopeData,
  ReportAgentInfoRequest,
  RotateSessionHandler,
  StartSessionHandler,
  UpdateMemoryHandler,
} from '@newio/agent-sdk';

import type { NewioAppForMcp } from './mcp/types.js';

export type SessionType = 'conversation' | 'contact' | 'cron';

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export type AgentType = 'claude-code' | 'kiro-cli' | 'codex' | 'cursor' | 'gemini' | 'custom';

/** Resolve the command and arguments to spawn an ACP agent process. */
export function resolveCommand(
  type: AgentType,
  config: AcpConfig,
): { readonly command: string; readonly args: readonly string[] } {
  if (type === 'kiro-cli') {
    const command = config.executablePath ?? 'kiro-cli';
    const args = config.kiroCliTrustAllTools !== false ? ['acp', '--trust-all-tools'] : ['acp'];
    return { command, args };
  }

  if (type === 'claude-code') {
    return { command: config.executablePath ?? 'claude-agent-acp', args: [] };
  }

  if (type === 'codex') {
    return { command: config.executablePath ?? 'codex-acp', args: [] };
  }

  if (type === 'cursor') {
    return { command: config.executablePath ?? 'agent', args: ['acp'] };
  }

  if (type === 'gemini') {
    return { command: config.executablePath ?? 'gemini', args: ['--acp'] };
  }

  // custom: user provides the full command string, possibly with args baked in
  if (!config.executablePath) {
    throw new Error('No executable path configured for custom agent type');
  }
  const parts = config.executablePath.trim().split(/\s+/).filter(Boolean);
  const command = parts[0];
  if (command === undefined) {
    throw new Error('No executable path configured for custom agent type');
  }
  return { command, args: parts.slice(1) };
}

export type AgentRuntimeStatus =
  | 'stopped'
  | 'stopping'
  | 'starting'
  | 'awaiting_approval'
  | 'initializing'
  | 'greeting'
  | 'running'
  | 'error';

export interface AcpConfig {
  readonly executablePath?: string;
  readonly cwd: string;
  /** When true, passes --trust-all-tools to the ACP agent (kiro-cli only — skips permission prompts). Default: true. */
  readonly kiroCliTrustAllTools?: boolean;
}

/** Runtime agent info — discovered during initialization, protocol-agnostic. */
export interface AgentInfo {
  readonly protocol: 'acp';
  readonly protocolVersion: string;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly agentTitle?: string;
  readonly capabilities: readonly Capability[];
  readonly authMethods?: readonly AgentAuthMethod[];
}

/** A single capability with its enabled state. */
export interface Capability {
  readonly name: string;
  readonly enabled: boolean;
}

/** Authentication method advertised by the agent. */
export interface AgentAuthMethod {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly description?: string;
}

/** Newio identity — populated after first registration/login, synced on every start. */
export interface NewioIdentity {
  /** Newio user ID (present once registered). */
  readonly agentId?: string;
  /** Newio username (assigned by owner during approval). */
  readonly username?: string;
  /** Newio display name. */
  readonly displayName?: string;
  /** Newio avatar URL. */
  readonly avatarUrl?: string;
}

export interface AgentConfig {
  readonly id: string;
  readonly type: AgentType;

  /** Newio identity — set after first registration, synced on every start. */
  readonly newio?: NewioIdentity;

  /** Session mode: 'isolated' (one session per conversation) or 'shared' (single session for all events). Default: 'isolated'. */
  readonly sessionMode?: SessionMode;

  /** Idle timeout for sessions in ms. Sessions with no activity are stopped. Default: 1 hour. */
  readonly sessionIdleTimeoutMs?: number;

  /** Environment variables passed to the agent process. */
  readonly envVars: Readonly<Record<string, string>>;

  /** Shell used to source envVars (e.g. "/bin/zsh"). */
  readonly envVarsShell?: string;

  readonly acp?: AcpConfig;
}

/** Default session idle timeout: 1 hour. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export interface AddAgentInput {
  readonly displayName: string;
  readonly type: AgentType;
  /** Optional: existing Newio username to login with instead of registering a new agent. */
  readonly newioUsername?: string;
  readonly sessionMode?: SessionMode;
  readonly acp?: AcpConfig;
  /** Optional: initial environment variables (e.g. synced from shell by the desktop app). */
  readonly envVars?: Readonly<Record<string, string>>;
  /** Optional: shell used to source envVars. */
  readonly envVarsShell?: string;
}

export interface UpdateAgentInput {
  readonly displayName?: string;
  readonly newioUsername?: string;
  readonly sessionMode?: SessionMode;
  readonly envVars?: Readonly<Record<string, string>>;
  readonly envVarsShell?: string;
  readonly acp?: AcpConfig;
}

export interface AgentStatusInfo {
  readonly id: string;
  readonly config: AgentConfig;
  readonly runtimeStatus: AgentRuntimeStatus;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Session stream types
// ---------------------------------------------------------------------------

/** Segment types that the stream aggregates and yields. */
export type SegmentType = 'agent_message_chunk' | 'agent_thought_chunk' | 'tool_call';

/** An aggregated segment yielded by the stream. */
export interface SessionStreamSegment {
  readonly type: SegmentType;
  readonly text: string;
  /** Present for tool_call and tool_call_update segments. */
  readonly toolCallId?: string;
  /** Present for tool_call and tool_call_update segments. */
  readonly toolCallStatus?: string;
}

export type SessionStatus = 'thinking' | 'typing' | 'tool_calling' | 'idle';
export type SessionStatusListener = (status: SessionStatus, conversationId?: string) => void;

/** Per-conversation flags toggled by the owner via capability invocations. */
export interface ConversationFlags {
  readonly showToolCalls: boolean;
  readonly showThoughts: boolean;
}

export interface PermissionRequestOption {
  readonly kind: string;
  readonly name: string;
  readonly optionId: string;
}

export type PermissionHandler = (
  title: string,
  options: ReadonlyArray<PermissionRequestOption>,
  conversationId?: string,
) => Promise<string>;

/** Extract a human-readable message from an unknown error (handles Error instances and plain objects). */
export function extractErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    // ACP errors may have a more detailed message in data.message
    if (typeof obj.data === 'object' && obj.data !== null) {
      const data = obj.data as Record<string, unknown>;
      if (typeof data.message === 'string') {
        return data.message;
      }
    }
    if (err instanceof Error) {
      return err.message;
    }
    if (typeof obj.message === 'string') {
      return obj.message;
    }
  }
  return String(err);
}

/**
 * Session mode controls which messaging tools are available:
 * - 'isolated': One session per conversation. Uses `initiate_conversation` for cross-conversation
 *   delegation. `send_dm` and `dm_owner` are blocked.
 * - 'shared': Single session serves all conversations. Uses `send_dm` and `dm_owner` directly.
 *   `initiate_conversation` is not available.
 */
export type SessionMode = 'isolated' | 'shared';

export interface NewioAppForAgent extends NewioAppForMcp {
  // ── Lifecycle ──
  init(): Promise<void>;
  dispose(): void;
  onDisconnect(handler: () => void): void;

  // ── Events ──
  on<K extends keyof AppEventHandlers>(event: K, handler: AppEventHandlers[K]): void;

  // ── Capability handlers (signal routing) ──
  onLiveSessionInfo(handler: LiveSessionInfoHandler): void;
  onCancelSession(handler: CancelSessionHandler): void;
  onCompactSession(handler: CompactSessionHandler): void;
  onStartSession(handler: StartSessionHandler): void;
  onUpdateMemory(handler: UpdateMemoryHandler): void;
  onRotateSession(handler: RotateSessionHandler): void;

  // ── Messaging ──
  sendActionRequest(
    conversationId: string,
    action: ActionRequest,
    text?: string,
    visibleTo?: readonly string[],
  ): Promise<ActionResponse>;
  setStatus(status: ActivityStatus, conversationId?: string): void;

  // ── Identity & owner ──
  getOrCreateOwnerDmConversationId(): Promise<string>;

  // ── Conversations ──
  /** Get conversation type and name (from cache). */
  getCachedConversationInfo(conversationId: string): { type: string; name?: string } | undefined;
  /** Check if a userId is a member of the conversation (from cache). */
  isConversationMember(conversationId: string, userId: string): boolean;
  /** Get all member userIds for a conversation (from cache). */
  getConversationMemberIds(conversationId: string): readonly string[] | undefined;
  /** Get a member's display info (for context messages). */
  getMemberDisplayInfo(conversationId: string, userId: string): { username?: string; displayName?: string } | undefined;
  /** Get the self member's persisted session config (acpModel/acpMode). */
  getSelfMemberConfig(conversationId: string): { acpModel?: string; acpMode?: string } | undefined;

  // ── Memory ──
  loadSessionMemory(conversationId?: string, participantIds?: readonly string[]): Promise<LoadSessionMemoryResponse>;
  getMemoryScope(scope: string, scopeId: string): Promise<MemoryScopeData>;
  getHandoffNote(conversationId: string): Promise<string | null>;
  putHandoffNote(conversationId: string, text: string): Promise<void>;

  // ── Backend reporting ──
  reportAgentInfo(request: ReportAgentInfoRequest): Promise<void>;
  updateAgentMemberConfig(
    conversationId: string,
    config: { acpModel?: string | null; acpMode?: string | null },
  ): Promise<void>;
  sendContextWindowUpdate(
    targetUserId: string,
    sessionType: SessionType,
    externalReferenceId: string,
    contextWindowSize: number,
    contextWindowUsed: number,
  ): Promise<void>;
}
