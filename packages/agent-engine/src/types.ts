/**
 * Shared types used across the engine.
 */
import type {
  ActionRequest,
  ActionResponse,
  ActivityStatus,
  CancelSessionHandler,
  CancelSessionRequest,
  CancelSessionResponse,
  CompactSessionHandler,
  CompactSessionRequest,
  CompactSessionResponse,
  ContactEvent,
  ContactEventHandler,
  ConversationMemberUpdatedHandler,
  CronTriggeredHandler,
  CronScheduledHandler,
  CronCancelledHandler,
  CronTriggerEvent,
  IncomingMessage,
  LiveSessionInfoHandler,
  LiveSessionInfoRequest,
  LiveSessionInfoResponse,
  LoadSessionMemoryResponse,
  MemoryScopeData,
  MessageNewHandler,
  MessageUpdatedHandler,
  MessageDeletedHandler,
  ReportAgentInfoRequest,
  RotateSessionHandler,
  RotateSessionRequest,
  RotateSessionResponse,
  SessionConfigUpdate,
  SessionUpdatedHandler,
  StartSessionHandler,
  StartSessionRequest,
  StartSessionResponse,
  UpdateMemoryHandler,
  UpdateMemoryRequest,
  UpdateMemoryResponse,
} from '@newio/agent-sdk';

import { AgentSession } from './agent-session.js';
import { AgentEvent } from './event-queue.js';
import { CronJobRow } from './cron-store.js';

export type SessionType = 'conversation' | 'contact' | 'cron';

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export type AgentType = 'claude-code' | 'kiro-cli' | 'codex' | 'cursor' | 'gemini' | 'custom';

export interface AgentIdentity {
  readonly userId: string;
  readonly username: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly ownerId?: string;
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

export interface ContextWindow {
  readonly size: number;
  readonly used: number;
}

export interface SessionConfig {
  readonly acpModel?: string | null;
  readonly acpMode?: string | null;
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

/**
 * Session mode controls which messaging tools are available:
 * - 'isolated': One session per conversation. Uses `initiate_conversation` for cross-conversation
 *   delegation. `send_dm` and `dm_owner` are blocked.
 * - 'shared': Single session serves all conversations. Uses `send_dm` and `dm_owner` directly.
 *   `initiate_conversation` is not available.
 */
export type SessionMode = 'isolated' | 'shared';

export interface NewioAppForAgent {
  readonly identity: AgentIdentity;

  // ── Identity ──
  getOwnerInfo(): { readonly username: string; readonly displayName: string };

  // ── Lifecycle ──
  init(): Promise<void>;
  dispose(): void;
  onDisconnect(handler: () => void): void;

  // ── Events ──
  onMessageNew(handler: MessageNewHandler): void;
  onMessageUpdated(handler: MessageUpdatedHandler): void;
  onMessageDeleted(handler: MessageDeletedHandler): void;
  onContactEvent(handler: ContactEventHandler): void;
  onCronTriggered(handler: CronTriggeredHandler): void;
  onCronScheduled(handler: CronScheduledHandler): void;
  onCronCancelled(handler: CronCancelledHandler): void;
  onConversationMemberUpdated(handler: ConversationMemberUpdatedHandler): void;
  onSessionUpdated(handler: SessionUpdatedHandler): void;

  // ── Capability handlers (signal routing) ──
  onLiveSessionInfo(handler: LiveSessionInfoHandler): void;
  onCancelSession(handler: CancelSessionHandler): void;
  onCompactSession(handler: CompactSessionHandler): void;
  onStartSession(handler: StartSessionHandler): void;
  onUpdateMemory(handler: UpdateMemoryHandler): void;
  onRotateSession(handler: RotateSessionHandler): void;

  // ── Messaging ──
  sendMessage(
    conversationId: string,
    text?: string,
    opts?: { filePaths?: readonly string[]; metadata?: Record<string, unknown>; visibleTo?: readonly string[] },
  ): Promise<void>;
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
  getSessionConfig(conversationId: string): { acpModel?: string; acpMode?: string } | undefined;

  scheduleCron(def: CronJobRow): void;

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

export type InboundEvent =
  | { readonly type: 'message'; readonly msg: IncomingMessage }
  | { readonly type: 'contact'; readonly event: ContactEvent }
  | { readonly type: 'cron'; readonly event: CronTriggerEvent }
  | { readonly type: 'initiate_conversation'; readonly conversationId: string; readonly context: string };

export interface ApplySessionConfigUpdateRequest {
  readonly sessionType: SessionType;
  readonly externalReferenceId: string;
  readonly updates: SessionConfigUpdate;
}

/**
 * initialize session and dispatch events to corresponding session.
 */
export interface SessionManager {
  routeInboundEvent(event: InboundEvent): void;
  getLiveSessionInfo(request: LiveSessionInfoRequest): LiveSessionInfoResponse;
  applySessionConfigUpdate(request: ApplySessionConfigUpdateRequest): Promise<void>;
  rotateSession(sessionType: SessionType, externalReferenceId: string): Promise<void>;
  getDmSession(convId: string): Promise<AgentSession>;

  handleStartSession(request: StartSessionRequest): Promise<StartSessionResponse>;
  handleUpdateMemory(request: UpdateMemoryRequest): Promise<UpdateMemoryResponse>;
  handleRotateSession(request: RotateSessionRequest): Promise<RotateSessionResponse>;
  handleCancelSession(request: CancelSessionRequest): Promise<CancelSessionResponse>;
  handleCompactSession(request: CompactSessionRequest): Promise<CompactSessionResponse>;

  startIdleCleanup(): void;
  terminate(): Promise<void>;
}

export interface SessionEventProcessor {
  processEvent(event: AgentEvent, session: AgentSession): Promise<void>;
}

export interface NewioAppForSession {
  handlePermissionRequest(
    title: string,
    options: ReadonlyArray<PermissionRequestOption>,
    conversationId?: string,
  ): Promise<string>;
  loadMemoryForSession(conversationId?: string): Promise<LoadSessionMemoryResponse>;
  getHandoffNote(conversationId: string): Promise<string | null>;
  putHandoffNote(conversationId: string, note: string): Promise<void>;
  getSessionConfig(conversationId: string): Promise<{ acpModel?: string; acpMode?: string } | undefined>;
  updateAgentMemberConfig(
    conversationId: string,
    config: { acpModel?: string | null; acpMode?: string | null },
  ): Promise<void>;
  setStatus(status: ActivityStatus, conversationId?: string): void;
  /** Get memory scope data for a conversation or user (for incremental injection in shared mode). */
  getMemoryScope(scope: string, scopeId: string): Promise<MemoryScopeData>;
  /** Get member user IDs for a conversation (for incremental injection in shared mode). */
  getConversationMemberIds(conversationId: string): readonly string[] | undefined;
  /** Get member display info (for context labels in shared mode). */
  getMemberDisplayInfo(conversationId: string, userId: string): { username?: string; displayName?: string } | undefined;
  /** Get the agent's own userId (for filtering self from member lists). */
  agentUserId: string;
  /** Get the owner DM conversation ID (resolved during agent startup). */
  getOwnerDmConversationId(): string;
}

export interface CreateSessionInput {
  readonly type: SessionType;
  readonly externalReferenceId: string;
  readonly promptFormatterVersion: string;
  readonly mcpSocketPath: string;
  /** Absolute path to the MCP bridge script (node entrypoint). */
  readonly mcpBridgePath: string;
  readonly skipToken: string;
  readonly updateConfig: (config: SessionConfig) => Promise<void>;
  readonly reportContextWindow: (contextWindow: ContextWindow) => Promise<void>;
}

export interface SessionFactory {
  init(): Promise<void>;

  getAgentInfo(): AgentInfo | undefined;

  createSession(input: CreateSessionInput): Promise<AgentSession>;

  destroySession(correlationId: string): Promise<void>;

  terminate(): Promise<void>;

  onAbnormalTermination(abnormalTerminationHandler: (details: string) => void): void;
}
