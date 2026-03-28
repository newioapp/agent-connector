// Auth
export { AuthManager, InMemoryTokenStore } from './auth.js';
export type { TokenStore, ApprovalHandle, WaitForApprovalOptions } from './auth.js';

// HTTP
export type { TokenProvider } from './http.js';

// Errors
export { NewioError, ApiError, ApprovalTimeoutError, TokenRefreshError } from './errors.js';

// Types
export type {
  // Enums & Literals
  AccountType,
  ConversationType,
  ArtifactType,
  AttachmentType,
  DmAllowlist,
  MemberRole,
  ContactStatus,
  NotifyLevel,

  // Domain Records
  ContactRecord,
  ConversationListItem,
  MemberRecord,
  MessageRecord,
  MessageContent,
  Attachment,
  ImageMetadata,
  BlockRecord,
  AgentSettings,
  ConversationSettings,
  UserProfile,
  AgentSummary,

  // Auth
  RegisterRequest,
  RegisterResponse,
  LoginRequest,
  LoginResponse,
  PollApprovalStatusResponse,
  RefreshResponse,

  // Users
  UpdateProfileRequest,
  UsernameAvailabilityResponse,
  SearchUsersResponse,
  UserSummariesResponse,
  UserAgentsResponse,

  // Contacts
  ListFriendsResponse,
  SendFriendRequestResponse,
  ListIncomingRequestsResponse,
  ListOutgoingRequestsResponse,
  AcceptFriendRequestResponse,
  UpdateFriendNameResponse,

  // Blocks
  ListBlocksResponse,

  // Conversations
  CreateConversationRequest,
  ConversationResponse,
  ListConversationsResponse,
  UpdateConversationRequest,
  MarkReadResponse,
  UpdateNotifyLevelResponse,
  AddMembersResponse,
  UpdateMemberRoleResponse,
  UpdateConversationSettingsResponse,

  // Messages
  SendMessageResponse,
  ListMessagesRequest,
  ListMessagesResponse,
  EditMessageResponse,

  // Media
  UploadUrlResponse,
  DownloadUrlResponse,

  // Agent Settings
  AgentSettingsResponse,
  UpdateAgentProfileResponse,

  // Pagination
  PaginationParams,
} from './types.js';

// Events
export type {
  WebSocketEvent,
  MessageNewEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  ConversationNewEvent,
  ConversationUpdatedEvent,
  ConversationMemberAddedEvent,
  ConversationMemberRemovedEvent,
  ConversationMemberUpdatedEvent,
  ContactRequestReceivedEvent,
  ContactRequestAcceptedEvent,
  ContactRequestRejectedEvent,
  ContactRequestRevokedEvent,
  ContactRemovedEvent,
  ContactRequestPendingApprovalEvent,
  ContactFriendNameUpdatedEvent,
  BlockCreatedEvent,
  BlockRemovedEvent,
  UserProfileUpdatedEvent,
  AgentSettingsUpdatedEvent,
  NewioEvent,
  EventMap,
} from './events.js';
