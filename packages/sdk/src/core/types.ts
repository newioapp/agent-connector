// ---------------------------------------------------------------------------
// Enums & Literals
// ---------------------------------------------------------------------------

/** Account type — human or agent. */
export type AccountType = 'human' | 'agent';

/** Conversation type. */
export type ConversationType = 'dm' | 'temp_group' | 'group';

/** Artifact type for media uploads. */
export type ArtifactType = 'media' | 'avatars';

/** Attachment type within a message. */
export type AttachmentType = 'image' | 'file';

/** Agent DM allowlist setting. */
export type DmAllowlist = 'owner_only' | 'owner_and_owner_agents' | 'anyone_in_contacts';

/** Conversation member role. */
export type MemberRole = 'admin' | 'member';

/** Contact relationship status. */
export type ContactStatus = 'pending' | 'accepted';

/** Notification level for a conversation. */
export type NotifyLevel = 'all' | 'mentions' | 'nothing';

/** Ephemeral activity status for typing/thinking indicators. */
export type ActivityStatus = 'typing' | 'thinking' | 'tool_calling' | 'idle';

// ---------------------------------------------------------------------------
// Domain Records (shared nested types — no Request/Response suffix)
// ---------------------------------------------------------------------------

/** A contact (friend) record. */
export interface ContactRecord {
  readonly userId: string;
  readonly contactId: string;
  readonly status: string;
  readonly requesterId: string;
  readonly friendAccountType: AccountType;
  readonly friendUsername?: string;
  readonly friendDisplayName?: string;
  readonly friendAvatarUrl?: string;
  readonly friendName?: string;
  readonly ownerId?: string;
  readonly ownerDisplayName?: string;
  readonly note?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A conversation list item (per-user view including read state). */
export interface ConversationListItem {
  readonly conversationId: string;
  readonly type: ConversationType;
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly createdBy: string;
  readonly settings?: ConversationSettings;
  readonly lastMessageAt?: string;
  readonly disabledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly readUntil?: string;
  readonly notifyLevel?: NotifyLevel;
  /** Session ID for agent members. Only present when the caller is an agent. */
  readonly sessionId?: string;
  readonly showToolCalls?: boolean;
  readonly showThoughts?: boolean;
  readonly acpModel?: string;
  readonly acpMode?: string;
}

/** A conversation member record. */
export interface MemberRecord {
  readonly userId: string;
  readonly role: MemberRole;
  readonly accountType: AccountType;
  readonly canSend?: boolean;
  readonly notifyLevel?: NotifyLevel;
  readonly sessionId?: string;
  readonly showToolCalls?: boolean;
  readonly showThoughts?: boolean;
  readonly acpModel?: string;
  readonly acpMode?: string;
  readonly joinedAt: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

/** A message record. */
export interface MessageRecord {
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly content: MessageContent;
  readonly sequenceNumber: number;
  /** When set, only these userIds see full content. Others receive content as {}. */
  readonly visibleTo?: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string;
}

/** Mention metadata within a message. */
export interface Mentions {
  /** User IDs of specifically @-mentioned users. */
  readonly userIds?: readonly string[];
  /** True if @everyone was used. */
  readonly everyone?: boolean;
  /** True if @here was used. */
  readonly here?: boolean;
}

/** A single option in an action request (e.g. "Allow once", "Reject"). */
export interface ActionOption {
  readonly optionId: string;
  readonly label: string;
  readonly style?: 'primary' | 'danger' | 'secondary';
}

/** Interactive action request sent by an agent (e.g. permission prompt). */
export interface ActionRequest {
  /** Client-generated UUID for correlating request → response. */
  readonly requestId: string;
  /** Categorizes the action (e.g. 'permission', 'slash_command'). */
  readonly type: string;
  readonly title: string;
  readonly description?: string;
  readonly options: ReadonlyArray<ActionOption>;
  /** ISO timestamp — UI shows countdown, agent auto-rejects on expiry. */
  readonly expiresAt?: string;
  /** Type-specific data (e.g. tool call details for permission requests). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Response to a prior action request. */
export interface ActionResponse {
  /** Matches the ActionRequest.requestId this responds to. */
  readonly requestId: string;
  readonly selectedOptionId: string;
}

/** Message content. */
export interface MessageContent {
  readonly text?: string;
  readonly attachments?: readonly Attachment[];
  readonly mentions?: Mentions;
  /** Interactive action request (e.g. permission prompt). */
  readonly action?: ActionRequest;
  /** Response to a prior action request. */
  readonly response?: ActionResponse;
  /** Opaque metadata bag — stored and returned as-is by the backend. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A file or image attachment. */
export interface Attachment {
  readonly attachmentType: AttachmentType;
  readonly s3Key: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly imageMetadata?: ImageMetadata;
}

/** Image-specific metadata. */
export interface ImageMetadata {
  readonly width: number;
  readonly height: number;
  readonly blurhash?: string;
}

/** A block record. */
export interface BlockRecord {
  readonly userId: string;
  readonly blockedUserId: string;
  readonly blockedDisplayName: string;
  readonly blockedUsername?: string;
  readonly blockedAvatarUrl?: string;
  readonly blockedAccountType: AccountType;
  readonly createdAt: string;
}

/** Agent settings. */
export interface AgentSettings {
  readonly requireOwnerApprovalForFriendRequests?: boolean;
  readonly dmAllowlist?: DmAllowlist;
  readonly hideFromOwnerProfile?: boolean;
}

/** Conversation settings (group only). */
export interface ConversationSettings {
  readonly allowMemberInvites?: boolean;
  readonly maxMembers?: number;
}

/** Per-agent member settings for conversation creation and add-members. */
export interface AgentMemberSettings {
  readonly sessionId?: string;
  readonly canSend?: boolean;
  readonly notifyLevel?: NotifyLevel;
}

/** A user's public profile. */
export interface UserProfile {
  readonly userId: string;
  readonly displayName?: string;
  readonly username?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
  readonly email?: string;
  readonly accountType: AccountType;
  readonly ownerId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Minimal user summary for display purposes. */
export interface UserSummary {
  readonly userId: string;
  readonly displayName: string;
  readonly accountType: AccountType;
  readonly username?: string;
  readonly avatarUrl?: string;
  readonly ownerId?: string;
}

/** Owned agent summary. */
export interface AgentSummary {
  readonly agentId: string;
  readonly name: string;
  readonly username?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
  readonly createdAt: string;
}

/** User agent (public agent listing). */
export interface UserAgent {
  readonly agentId: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly username?: string;
}

// ---------------------------------------------------------------------------
// Auth — Request / Response
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  readonly name: string;
}

export interface RegisterResponse {
  readonly agentId: string;
  readonly approvalId: string;
  readonly status: 'pending_approval';
  readonly approvalUrl: string;
}

export interface LoginRequest {
  readonly agentId?: string;
  readonly username?: string;
}

export interface LoginResponse {
  readonly agentId: string;
  readonly approvalId: string;
  readonly status: 'pending_approval';
  readonly approvalUrl: string;
}

export interface PollApprovalStatusResponse {
  readonly status: 'pending_approval' | 'active';
  readonly accessToken?: string;
  readonly refreshToken?: string;
}

export interface RefreshResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
}

// ---------------------------------------------------------------------------
// Users — Request / Response
// ---------------------------------------------------------------------------

export interface GetMeRequest {}

export interface GetMeResponse {
  readonly userId: string;
  readonly displayName: string;
  readonly username?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
  readonly email?: string;
  readonly accountType: AccountType;
  readonly ownerId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateMeRequest {
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly username?: string;
  readonly bio?: string;
}

export interface UpdateMeResponse {
  readonly userId: string;
  readonly displayName: string;
  readonly username?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
  readonly email?: string;
  readonly accountType: AccountType;
  readonly ownerId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CheckUsernameAvailabilityRequest {
  readonly username: string;
}

export interface CheckUsernameAvailabilityResponse {
  readonly username: string;
  readonly available: boolean;
}

export interface GetUserByUsernameRequest {
  readonly username: string;
}

export interface GetUserByUsernameResponse {
  readonly userId: string;
  readonly displayName: string;
  readonly username?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
  readonly email?: string;
  readonly accountType: AccountType;
  readonly ownerId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GetUserRequest {
  readonly userId: string;
}

export interface GetUserResponse {
  readonly userId: string;
  readonly displayName: string;
  readonly username?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
  readonly email?: string;
  readonly accountType: AccountType;
  readonly ownerId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SearchUsersRequest {
  readonly query: string;
}

export interface SearchUsersResponse {
  readonly users: readonly UserProfile[];
}

export interface GetUserSummariesRequest {
  readonly userIds: readonly string[];
}

export interface GetUserSummariesResponse {
  readonly users: readonly UserSummary[];
}

export interface GetUserAgentsRequest {
  readonly userId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface GetUserAgentsResponse {
  readonly agents: readonly UserAgent[];
  readonly cursor?: string;
}

// ---------------------------------------------------------------------------
// Contacts — Request / Response
// ---------------------------------------------------------------------------

export interface ListFriendsRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListFriendsResponse {
  readonly contacts: readonly ContactRecord[];
  readonly cursor?: string;
}

export interface SendFriendRequestRequest {
  readonly contactId: string;
  readonly note?: string;
}

export interface SendFriendRequestResponse {
  readonly userId: string;
  readonly contactId: string;
  readonly status: string;
  readonly requesterId: string;
  readonly note?: string;
  readonly friendAvatarUrl?: string;
  readonly friendAccountType: AccountType;
  readonly createdAt: string;
}

export interface ListIncomingRequestsRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListIncomingRequestsResponse {
  readonly contacts: readonly ContactRecord[];
  readonly cursor?: string;
}

export interface ListOutgoingRequestsRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListOutgoingRequestsResponse {
  readonly contacts: readonly ContactRecord[];
  readonly cursor?: string;
}

export interface RevokeOutgoingRequestRequest {
  readonly contactId: string;
}

export interface RevokeOutgoingRequestResponse {}

export interface AcceptFriendRequestRequest {
  readonly requestId: string;
}

export interface AcceptFriendRequestResponse {
  readonly userId: string;
  readonly contactId: string;
  readonly status: string;
  readonly requesterId: string;
  readonly note?: string;
  readonly friendName?: string;
  readonly friendAvatarUrl?: string;
  readonly friendAccountType: AccountType;
  readonly friendUsername?: string;
  readonly friendDisplayName?: string;
  readonly ownerId?: string;
  readonly ownerDisplayName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RejectFriendRequestRequest {
  readonly requestId: string;
}

export interface RejectFriendRequestResponse {}

export interface UpdateFriendNameRequest {
  readonly contactId: string;
  readonly friendName: string;
}

export interface UpdateFriendNameResponse {
  readonly userId: string;
  readonly contactId: string;
  readonly status: string;
  readonly requesterId: string;
  readonly note?: string;
  readonly friendName?: string;
  readonly friendAvatarUrl?: string;
  readonly friendAccountType: AccountType;
  readonly friendUsername?: string;
  readonly friendDisplayName?: string;
  readonly ownerId?: string;
  readonly ownerDisplayName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemoveFriendRequest {
  readonly userId: string;
}

export interface RemoveFriendResponse {}

// ---------------------------------------------------------------------------
// Blocks — Request / Response
// ---------------------------------------------------------------------------

export interface BlockUserRequest {
  readonly userId: string;
}

export interface BlockUserResponse {
  readonly userId: string;
  readonly blockedUserId: string;
  readonly blockedDisplayName: string;
  readonly blockedUsername?: string;
  readonly blockedAvatarUrl?: string;
  readonly blockedAccountType: AccountType;
  readonly createdAt: string;
}

export interface UnblockUserRequest {
  readonly userId: string;
}

export interface UnblockUserResponse {}

export interface ListBlocksRequest {}

export interface ListBlocksResponse {
  readonly blocks: readonly BlockRecord[];
}

// ---------------------------------------------------------------------------
// Conversations — Request / Response
// ---------------------------------------------------------------------------

export interface CreateConversationRequest {
  readonly type: ConversationType;
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly memberIds: readonly string[];
  readonly agentSettings?: Readonly<Record<string, AgentMemberSettings>>;
}

export interface CreateConversationResponse {
  readonly conversationId: string;
  readonly type: ConversationType;
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly createdBy: string;
  readonly settings?: ConversationSettings;
  readonly lastMessageAt?: string;
  readonly disabledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly members: readonly MemberRecord[];
}

export interface ListConversationsRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListConversationsResponse {
  readonly conversations: readonly ConversationListItem[];
  readonly cursor?: string;
}

export interface GetConversationRequest {
  readonly conversationId: string;
}

export interface GetConversationResponse {
  readonly conversationId: string;
  readonly type: ConversationType;
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly createdBy: string;
  readonly settings?: ConversationSettings;
  readonly lastMessageAt?: string;
  readonly disabledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly members: readonly MemberRecord[];
}

export interface UpdateConversationRequest {
  readonly conversationId: string;
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly type?: ConversationType;
}

export interface UpdateConversationResponse {
  readonly conversationId: string;
  readonly type: ConversationType;
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly createdBy: string;
  readonly settings?: ConversationSettings;
  readonly lastMessageAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateConversationSettingsRequest {
  readonly conversationId: string;
  readonly settings: ConversationSettings;
}

export interface UpdateConversationSettingsResponse {
  readonly conversationId: string;
  readonly type: ConversationType;
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly createdBy: string;
  readonly settings?: ConversationSettings;
  readonly lastMessageAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AddMembersRequest {
  readonly conversationId: string;
  readonly memberIds: readonly string[];
  readonly agentSettings?: Readonly<Record<string, AgentMemberSettings>>;
}

export interface AddMembersResponse {
  readonly members: readonly MemberRecord[];
}

export interface RemoveMemberRequest {
  readonly conversationId: string;
  readonly userId: string;
}

export interface RemoveMemberResponse {}

export interface UpdateMemberRoleRequest {
  readonly conversationId: string;
  readonly userId: string;
  readonly role: MemberRole;
}

export interface UpdateMemberRoleResponse {
  readonly userId: string;
  readonly role: string;
  readonly accountType: string;
  readonly canSend?: boolean;
  readonly joinedAt: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export interface UpdateAgentMemberConfigRequest {
  readonly conversationId: string;
  readonly targetUserId: string;
  readonly acpModel?: string | null;
  readonly acpMode?: string | null;
}

export interface MarkReadRequest {
  readonly conversationId: string;
  readonly readUntil: string;
}

export interface MarkReadResponse {
  readonly conversationId: string;
  readonly readUntil: string;
}

export interface UpdateNotifyLevelRequest {
  readonly conversationId: string;
  readonly notifyLevel: NotifyLevel;
}

export interface UpdateNotifyLevelResponse {
  readonly conversationId: string;
  readonly notifyLevel: NotifyLevel;
}

// ---------------------------------------------------------------------------
// Messages — Request / Response
// ---------------------------------------------------------------------------

export interface SendMessageRequest {
  readonly conversationId: string;
  readonly content: MessageContent;
  /** When set, only these userIds see full content. Others receive content as {}. */
  readonly visibleTo?: ReadonlyArray<string>;
}

export interface SendMessageResponse {
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly content: MessageContent;
  readonly sequenceNumber: number;
  readonly visibleTo?: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string;
}

export interface ListMessagesRequest {
  readonly conversationId: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly afterMessageId?: string;
  readonly beforeMessageId?: string;
}

export interface ListMessagesResponse {
  readonly messages: readonly MessageRecord[];
  readonly cursor?: string;
}

export interface GetMessageRequest {
  readonly conversationId: string;
  readonly messageId: string;
}

export interface GetMessageResponse {
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly content: MessageContent;
  readonly sequenceNumber: number;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string;
}

export interface EditMessageRequest {
  readonly conversationId: string;
  readonly messageId: string;
  readonly content: MessageContent;
}

export interface EditMessageResponse {
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly content: MessageContent;
  readonly sequenceNumber: number;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string;
}

export interface DeleteMessageRequest {
  readonly conversationId: string;
  readonly messageId: string;
}

export interface DeleteMessageResponse {}

// ---------------------------------------------------------------------------
// Media — Request / Response
// ---------------------------------------------------------------------------

export interface GetUploadUrlRequest {
  readonly fileName: string;
  readonly contentType: string;
  readonly artifactType: ArtifactType;
}

export interface GetUploadUrlResponse {
  readonly url: string;
  readonly fields: Record<string, string>;
  readonly s3Key: string;
  readonly cdnUrl?: string;
}

export interface UploadFileRequest {
  readonly fileName: string;
  readonly contentType: string;
  readonly body: Blob | ArrayBuffer;
}

export interface UploadFileResponse {
  readonly s3Key: string;
}

export interface UploadAvatarRequest {
  readonly fileName: string;
  readonly contentType: string;
  readonly body: Blob | ArrayBuffer;
}

export interface UploadAvatarResponse {
  readonly s3Key: string;
}

export interface GetDownloadUrlRequest {
  readonly conversationId: string;
  readonly s3Key: string;
}

export interface GetDownloadUrlResponse {
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Agent Settings — Request / Response
// ---------------------------------------------------------------------------

export interface GetMySettingsRequest {
  readonly agentId: string;
}

export interface GetMySettingsResponse {
  readonly agentId: string;
  readonly settings: AgentSettings;
}

export interface UpdateMySettingsRequest {
  readonly agentId: string;
  readonly settings: Partial<AgentSettings>;
}

export interface UpdateMySettingsResponse {
  readonly agentId: string;
  readonly settings: AgentSettings;
}

export interface UpdateMyProfileRequest {
  readonly agentId: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
}

export interface UpdateMyProfileResponse {
  readonly agentId: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
}

// ---------------------------------------------------------------------------
// Signals — P2P owner ↔ agent communication
// ---------------------------------------------------------------------------

/** Direction of a P2P signal. */
export type SignalIntent = 'request' | 'response' | 'notification';

export type SignalPayload =
  | LiveSessionInfoRequest
  | LiveSessionInfoResponse
  | CancelSessionRequest
  | CancelSessionResponse
  | CompactSessionRequest
  | CompactSessionResponse
  | StartSessionRequest
  | StartSessionResponse
  | ContextWindowUpdatePayload;

export interface SendSignalRequest {
  readonly targetUserId: string;
  readonly requestId: string;
  readonly intent: SignalIntent;
  readonly type: string;
  readonly payload: SignalPayload;
}

export interface SendSignalResponse {
  readonly requestId: string;
}

export interface SignalEventPayload {
  readonly senderId: string;
  readonly requestId: string;
  readonly intent: SignalIntent;
  readonly type: string;
  readonly payload: SignalPayload;
}

export interface SignalEvent {
  readonly type: 'signal';
  readonly payload: SignalEventPayload;
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Agent Info — static metadata reported on startup
// ---------------------------------------------------------------------------

/** Host info as reported by the agent — city and ipAddress are resolved server-side. */
export interface ReportAgentHostInfo {
  readonly hostname?: string;
  readonly os?: string;
  readonly osVersion?: string;
  readonly workingDirectory?: string;
}

export interface ReportAgentInfoRequest {
  readonly agentProtocol: string;
  readonly agentVendor: string;
  readonly agentVendorVersion?: string;
  readonly sessionMode?: 'isolated' | 'shared';
  readonly host?: ReportAgentHostInfo;
}

export interface ReportAgentInfoResponse {
  readonly version: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionRecord {
  readonly sessionId: string;
  readonly agentId: string;
  readonly name: string;
  readonly acpModel?: string;
  readonly acpMode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Config fields that can be applied to a session (subset of SessionRecord). */
export interface SessionConfigUpdate {
  readonly acpModel?: string | null;
  readonly acpMode?: string | null;
}

export type SessionType = 'conversation' | 'contact' | 'cron';

/**
 * ExternalReferenceId used by agents running in shared session mode.
 * A single session serves all conversations, so there is no per-conversation
 * externalReferenceId.
 */
export const SHARED_SESSION_ID = '__shared__' as const;

// ---------------------------------------------------------------------------
// Capabilities — agent remote control
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Signal types — constrained vocabulary
// ---------------------------------------------------------------------------

export type SignalType =
  | 'live_session_info'
  | 'live_session_info_response'
  | 'cancel_session'
  | 'cancel_session_response'
  | 'compact_session'
  | 'compact_session_response'
  | 'start_session'
  | 'start_session_response'
  | 'update_memory'
  | 'update_memory_response'
  | 'rotate_session'
  | 'rotate_session_response'
  | 'context_window_update';

/**
 * Well-known `errorCode` values returned by session-lifecycle signal responses
 * (cancel_session, compact_session, update_memory, rotate_session).
 *
 * - `session_not_live`: No active session for the given sessionType/externalReferenceId.
 * - `session_busy`: The session is currently processing a turn (e.g. responding to a message).
 * - `operation_in_progress`: A different owner-initiated lifecycle operation is already running on this slot.
 * - `invalid_session_type`: The operation does not support the given sessionType (e.g. rotate_session on contact/cron).
 * - `not_implemented`: No handler is registered on the agent side.
 */
export type SignalErrorCode =
  | 'session_not_live'
  | 'session_busy'
  | 'operation_in_progress'
  | 'invalid_session_type'
  | 'not_implemented'
  | 'not_active_for_conversation';

export interface ModelOption {
  readonly value: string;
  readonly label: string;
}

export interface ModeOption {
  readonly value: string;
  readonly label: string;
}

export interface LiveSessionInfoRequest {
  readonly sessionType: SessionType;
  readonly externalReferenceId: string;
}

export interface LiveSessionInfoResponse {
  readonly sessionType: SessionType;
  readonly externalReferenceId: string;
  readonly isLive: boolean;
  readonly availableModels: ReadonlyArray<ModelOption>;
  readonly currentModel?: string;
  readonly availableModes: ReadonlyArray<ModeOption>;
  readonly currentMode?: string;
  readonly canCancel: boolean;
  readonly canCompact: boolean;
  readonly contextWindowSize?: number;
  readonly contextWindowUsed?: number;
}

export interface CancelSessionRequest {
  readonly sessionType: SessionType;
  readonly externalReferenceId: string;
}

export interface CancelSessionResponse {
  readonly success: boolean;
  readonly errorCode?: SignalErrorCode;
  readonly error?: string;
}

export interface CompactSessionRequest {
  readonly sessionType: SessionType;
  readonly externalReferenceId: string;
}

export interface CompactSessionResponse {
  readonly success: boolean;
  readonly errorCode?: SignalErrorCode;
  readonly error?: string;
}

export interface StartSessionRequest {
  readonly sessionType: SessionType;
  readonly externalReferenceId: string;
}

/** Returns the full session info on success, or an error on failure. */
export interface StartSessionResponse {
  readonly success: boolean;
  readonly info?: LiveSessionInfoResponse;
  readonly error?: string;
}

/**
 * UpdateMemory — owner requests the agent run its memory-update prompt
 * (the mid-session variant). The session is expected to continue afterwards.
 */
export interface UpdateMemoryRequest {
  readonly sessionType: SessionType;
  readonly externalReferenceId: string;
}

export interface UpdateMemoryResponse {
  readonly success: boolean;
  readonly errorCode?: SignalErrorCode;
  readonly error?: string;
}

/**
 * RotateSession — owner ends the current session (triggering the session-end
 * prompt, which produces a handoff note). The next inbound event for the same
 * slot creates a fresh session with memory + handoff loaded.
 *
 * Only supported for `sessionType === 'conversation'` (contact/cron sessions
 * are stateless — there is no handoff note to generate).
 */
export interface RotateSessionRequest {
  readonly sessionType: SessionType;
  readonly externalReferenceId: string;
}

export interface RotateSessionResponse {
  readonly success: boolean;
  readonly errorCode?: SignalErrorCode;
  readonly error?: string;
}

export interface ContextWindowUpdatePayload {
  readonly sessionType: SessionType;
  readonly externalReferenceId: string;
  readonly contextWindowSize: number;
  readonly contextWindowUsed: number;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export type MemoryScope = 'global' | 'user' | 'conversation';

export interface MemoryFact {
  readonly factId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryScopeSummary {
  readonly scope: MemoryScope;
  readonly scopeId: string;
  readonly text: string;
  readonly lastInteractionAt: string;
  readonly interactionCount: number;
}

export interface MemoryScopeData {
  readonly summary: MemoryScopeSummary | null;
  readonly facts: ReadonlyArray<MemoryFact>;
}

export type MemoryOperation =
  | { readonly op: 'add'; readonly scope: MemoryScope; readonly scopeId: string; readonly text: string }
  | {
      readonly op: 'update';
      readonly scope: MemoryScope;
      readonly scopeId: string;
      readonly factId: string;
      readonly text: string;
    }
  | { readonly op: 'delete'; readonly scope: MemoryScope; readonly scopeId: string; readonly factId: string }
  | { readonly op: 'update_summary'; readonly scope: MemoryScope; readonly scopeId: string; readonly text: string };

export interface GetMemoryRequest {
  readonly agentId: string;
  readonly scope: MemoryScope;
  readonly scopeId: string;
}

export interface GetMemoryResponse {
  readonly data: MemoryScopeData;
}

export interface BatchUpdateMemoryRequest {
  readonly agentId: string;
  readonly operations: ReadonlyArray<MemoryOperation>;
}

export interface BatchUpdateMemoryResponse {
  readonly applied: number;
}

export interface TouchMemoryScopeRequest {
  readonly agentId: string;
  readonly scope: MemoryScope;
  readonly scopeId: string;
}

export interface TouchMemoryScopeResponse {}

export interface LoadSessionMemoryRequest {
  readonly agentId: string;
  readonly conversationId?: string;
  readonly participantIds?: ReadonlyArray<string>;
}

export interface LoadSessionMemoryResponse {
  readonly global: MemoryScopeData;
  readonly participants: Readonly<Record<string, MemoryScopeData>>;
  readonly conversation: MemoryScopeData;
  readonly topUsers: ReadonlyArray<MemoryScopeSummary>;
  readonly topConversations: ReadonlyArray<MemoryScopeSummary>;
}

// ── Handoff notes ──

export interface GetHandoffNoteRequest {
  readonly agentId: string;
  readonly conversationId: string;
}

export interface GetHandoffNoteResponse {
  readonly text: string | null;
}

export interface PutHandoffNoteRequest {
  readonly agentId: string;
  readonly conversationId: string;
  readonly text: string;
}
