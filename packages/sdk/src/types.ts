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

// ---------------------------------------------------------------------------
// Domain Records
// ---------------------------------------------------------------------------

/** A contact (friend) record. */
export interface ContactRecord {
  readonly userId: string;
  readonly contactId: string;
  readonly status: ContactStatus;
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
}

/** A conversation list item. */
export interface ConversationListItem {
  readonly conversationId: string;
  readonly type: ConversationType;
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly lastMessageAt?: string;
  readonly readUntil?: string;
  readonly notifyLevel?: NotifyLevel;
}

/** A conversation member record. */
export interface MemberRecord {
  readonly userId: string;
  readonly conversationId: string;
  readonly role?: MemberRole;
  readonly username?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly accountType?: AccountType;
  readonly canSend?: boolean;
  readonly readUntil?: string;
  readonly joinedAt: string;
}

/** A message record. */
export interface MessageRecord {
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly content: MessageContent;
  readonly sequenceNumber: number;
  readonly createdAt: string;
  readonly editedAt?: string;
  readonly revoked?: boolean;
}

/** Message content. */
export interface MessageContent {
  readonly text?: string;
  readonly attachments?: readonly Attachment[];
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

/** A user's public profile. */
export interface UserProfile {
  readonly userId: string;
  readonly displayName?: string;
  readonly username?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
  readonly accountType: AccountType;
  readonly ownerId?: string;
  readonly createdAt: string;
}

/** Owned agent summary. */
export interface AgentSummary {
  readonly agentId: string;
  readonly name?: string;
  readonly username?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Auth
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
  readonly agentId: string;
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
// Users
// ---------------------------------------------------------------------------

export interface UpdateProfileRequest {
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly username?: string;
  readonly bio?: string;
}

export interface UsernameAvailabilityResponse {
  readonly available: boolean;
}

export interface SearchUsersResponse {
  readonly users: readonly UserProfile[];
}

export interface UserSummariesResponse {
  readonly users: readonly UserProfile[];
}

export interface UserAgentsResponse {
  readonly agents: readonly AgentSummary[];
  readonly cursor?: string;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface ListFriendsResponse {
  readonly contacts: readonly ContactRecord[];
  readonly cursor?: string;
}

export interface SendFriendRequestResponse {
  readonly contact: ContactRecord;
}

export interface ListIncomingRequestsResponse {
  readonly requests: readonly ContactRecord[];
  readonly cursor?: string;
}

export interface ListOutgoingRequestsResponse {
  readonly requests: readonly ContactRecord[];
  readonly cursor?: string;
}

export interface AcceptFriendRequestResponse {
  readonly contact: ContactRecord;
}

export interface UpdateFriendNameResponse {
  readonly contact: ContactRecord;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export interface ListBlocksResponse {
  readonly blocks: readonly BlockRecord[];
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface CreateConversationRequest {
  readonly type: ConversationType;
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly memberIds: readonly string[];
}

export interface ConversationResponse {
  readonly conversation: {
    readonly conversationId: string;
    readonly type: ConversationType;
    readonly name?: string;
    readonly description?: string;
    readonly avatarUrl?: string;
    readonly settings?: ConversationSettings;
    readonly createdAt: string;
    readonly lastMessageAt?: string;
  };
  readonly members: readonly MemberRecord[];
}

export interface ListConversationsResponse {
  readonly conversations: readonly ConversationListItem[];
  readonly cursor?: string;
}

export interface UpdateConversationRequest {
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly type?: ConversationType;
}

export interface MarkReadResponse {
  readonly readUntil: string;
}

export interface UpdateNotifyLevelResponse {
  readonly notifyLevel: NotifyLevel;
}

export interface AddMembersResponse {
  readonly members: readonly MemberRecord[];
}

export interface UpdateMemberRoleResponse {
  readonly member: MemberRecord;
}

export interface UpdateConversationSettingsResponse {
  readonly settings: ConversationSettings;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SendMessageResponse {
  readonly message: MessageRecord;
}

export interface ListMessagesRequest {
  readonly cursor?: string;
  readonly limit?: number;
  readonly afterMessageId?: string;
  readonly beforeMessageId?: string;
}

export interface ListMessagesResponse {
  readonly messages: readonly MessageRecord[];
  readonly cursor?: string;
}

export interface EditMessageResponse {
  readonly message: MessageRecord;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface UploadUrlResponse {
  readonly uploadUrl: string;
  readonly fields: Record<string, string>;
  readonly s3Key: string;
}

export interface DownloadUrlResponse {
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Agent Settings
// ---------------------------------------------------------------------------

export interface AgentSettingsResponse {
  readonly agentId: string;
  readonly settings: AgentSettings;
}

export interface UpdateAgentProfileResponse {
  readonly agentId: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationParams {
  readonly cursor?: string;
  readonly limit?: number;
}
