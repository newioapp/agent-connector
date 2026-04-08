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
}

/** A conversation member record. */
export interface MemberRecord {
  readonly userId: string;
  readonly role: MemberRole;
  readonly accountType: AccountType;
  readonly canSend?: boolean;
  readonly notifyLevel?: NotifyLevel;
  readonly sessionId?: string;
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
  readonly sequenceNumber?: number;
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
}

/** A file or image attachment. */
export interface Attachment {
  readonly type: AttachmentType;
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
  readonly sequenceNumber?: number;
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
  readonly sequenceNumber?: number;
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
  readonly sequenceNumber?: number;
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
