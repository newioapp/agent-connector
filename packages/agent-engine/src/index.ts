// Core types and interfaces
export type { EngineConfig } from './engine-config.js';
export type { CronStore, CronJobRow, CronStoreFactory } from './cron-store.js';
export { isSafeAgentId, assertSafeAgentId } from './agent-id.js';
export { JsonCronStore } from './json-cron-store.js';
export type { SessionStore, StoredSession } from './session-store.js';
export { sessionStoreKey } from './session-store.js';
export { JsonSessionStore } from './json-session-store.js';
export type { AgentConfigManager, AgentTokens } from './agent-config-manager.js';
export type {
  AgentConfig,
  AddAgentInput,
  UpdateAgentInput,
  NewioIdentity,
  AgentType,
  AcpConfig,
  AgentRuntimeStatus,
  AgentInfo,
  Capability,
  AgentAuthMethod,
  SessionType,
  SegmentType,
  SessionStreamSegment,
  SessionStatus,
  SessionStatusListener,
  PermissionHandler,
  PermissionRequestOption,
  AgentStatusInfo,
  AgentErrorCode,
  SessionMode,
} from './types.js';
export { DEFAULT_SESSION_IDLE_TIMEOUT_MS, resolveSessionMode } from './types.js';
export { captureEnv, asEnvSyncMode, ENV_SYNC_MODES, DEFAULT_ENV_SYNC_MODE } from './env-capture.js';
export type { EnvSyncMode } from './env-capture.js';
export { getIdentityEnv } from './identity.js';
export type { UserIdentity } from './identity.js';
export { InvalidEnvironmentError } from './errors.js';
export type {
  AgentInstance,
  AgentInstanceListener,
  AgentSessionConfig,
  AgentSessionConfigOption,
} from './agent-instance.js';
export type { AgentSession } from './agent-session.js';

// Runtime manager
export { AgentRuntimeManager } from './agent-runtime-manager.js';
export type { StatusListener } from './agent-runtime-manager.js';

// Agent instances
export { AcpSessionFactory } from './acp-session-factory.js';
export { BaseAgentInstance, AgentInstanceImpl } from './agent-instance-impl.js';
export type { CreateSessionInput, SessionFactory } from './types.js';
export type { NewioAppForAgent, SessionManager, NewioAppForSession, InboundEvent } from './types.js';

// Config manager implementation
export { FileAgentConfigManager } from './file-agent-config-manager.js';
export { serializeEnvVars, parseEnvVars, agentEnvFilePath } from './env-file.js';

// Event queue
export { EventQueue } from './event-queue.js';
export type { AgentEvent, OwnerOpType, OwnerOpResult } from './event-queue.js';

// Prompt system
export { PromptManager, UnsupportedPromptFormatterVersion } from './prompt-manager.js';
export { PromptFormatterImpl } from './prompt-formatter.js';
export type {
  PromptFormatter,
  Instruction,
  PromptFormatterIdentity,
  PromptFormatterOwner,
  SessionPromptRole,
} from './prompt-formatter.js';

// MCP server
export { NewioMcpServer, startUdsServer } from './mcp/index.js';
export type {
  Transport,
  UdsServerOptions,
  ToolCallHook,
  NewioMcpServerOptions,
  NewioAppForMcp,
  McpContactSummary,
  McpMemoryData,
  NewioMcpServerInterface,
  MessagingProfile,
  SendMessageMode,
  ShareContextMode,
} from './mcp/index.js';

// NewioApp — high-level agent client (moved here from @newio/agent-sdk).
// NewioIdentity/NewioTokens are intentionally not re-exported: the app layer's
// NewioIdentity collides with the engine's own (agent-config) NewioIdentity above.
export { NewioApp, NEWIO_API_BASE_URL, NEWIO_WS_URL, getClientConfig, NewioAppStore } from './app/index.js';
export { ActionTimeoutError, ActionAbortedError } from './app/index.js';
export { MessageProcessor, shouldSkipMessage, isMentioned } from './app/index.js';
export { buildMentions } from './app/index.js';
export { CronScheduler, parseCronExpression } from './app/index.js';
export type {
  NewioClientConfig,
  NewioAppCreateOptions,
  StorePersistence,
  IncomingMessage,
  SenderRelationship,
  OwnerInfo,
  ContactSummary,
  ConversationSummary,
  FriendRequestSummary,
  MemberSummary,
  MessageHandler,
  AppEventHandlers,
  ContactEventInfo,
  ContactEvent,
  ContactEventType,
  CronJobDef,
  CronTriggerEvent,
  LiveSessionInfoHandler,
  CancelSessionHandler,
  CompactSessionHandler,
  StartSessionHandler,
  UpdateMemoryHandler,
  RotateSessionHandler,
  MessageNewHandler,
  MessageUpdatedHandler,
  MessageDeletedHandler,
  ContactEventHandler,
  CronTriggeredHandler,
  CronScheduledHandler,
  CronCancelledHandler,
  ConversationMemberUpdatedHandler,
  SessionUpdatedHandler,
  ConversationControls,
} from './app/index.js';
