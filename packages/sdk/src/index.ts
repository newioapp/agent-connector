// Logger
export type { Logger, LogLevel, LogHandler } from './core/logger.js';
export { getLogger, setLogHandler, consoleLogHandler } from './core/logger.js';

// Client
export { NewioClient } from './core/client.js';

// WebSocket
export { NewioWebSocket } from './core/websocket.js';
export type {
  ConnectionState,
  ConnectionStateListener,
  SubscribeAck,
  UnsubscribeAck,
  SubscriptionError,
  OnDemandTopicPrefix,
  OnDemandTopic,
  WebSocketLike,
  WebSocketFactory,
} from './core/websocket.js';

// Auth
export { AuthManager, InMemoryTokenStore } from './core/auth.js';
export type { TokenStore, ApprovalHandle, WaitForApprovalOptions } from './core/auth.js';

// HTTP
export type { TokenProvider } from './core/http.js';

// Errors
export type { ErrorCode } from './core/errors.js';
export {
  NewioError,
  ApiError,
  InvalidRequestApiError,
  UnauthenticatedApiError,
  ForbiddenApiError,
  NotFoundApiError,
  ConflictApiError,
  WaitlistPendingApiError,
  ApprovalTimeoutError,
  TokenRefreshError,
} from './core/errors.js';

// Types — Enums & Literals
export type {
  AccountType,
  ConversationType,
  ArtifactType,
  AttachmentType,
  DmAllowlist,
  MemberRole,
  ContactStatus,
  NotifyLevel,
  ActivityStatus,
} from './core/types.js';

// Types — Domain Records (shared nested types)
export type {
  ContactRecord,
  ConversationListItem,
  MemberRecord,
  MessageRecord,
  MessageContent,
  Mentions,
  Attachment,
  ImageMetadata,
  BlockRecord,
  AgentSettings,
  AgentMemberSettings,
  ConversationSettings,
  UserProfile,
  UserSummary,
  AgentSummary,
  UserAgent,
} from './core/types.js';

// Types — Auth Request / Response
export type {
  RegisterRequest,
  RegisterResponse,
  LoginRequest,
  LoginResponse,
  PollApprovalStatusResponse,
  RefreshResponse,
} from './core/types.js';

// Types — Users Request / Response
export type {
  GetMeRequest,
  GetMeResponse,
  UpdateMeRequest,
  UpdateMeResponse,
  CheckUsernameAvailabilityRequest,
  CheckUsernameAvailabilityResponse,
  GetUserByUsernameRequest,
  GetUserByUsernameResponse,
  GetUserRequest,
  GetUserResponse,
  SearchUsersRequest,
  SearchUsersResponse,
  GetUserSummariesRequest,
  GetUserSummariesResponse,
  GetUserAgentsRequest,
  GetUserAgentsResponse,
} from './core/types.js';

// Types — Contacts Request / Response
export type {
  ListFriendsRequest,
  ListFriendsResponse,
  SendFriendRequestRequest,
  SendFriendRequestResponse,
  ListIncomingRequestsRequest,
  ListIncomingRequestsResponse,
  ListOutgoingRequestsRequest,
  ListOutgoingRequestsResponse,
  RevokeOutgoingRequestRequest,
  RevokeOutgoingRequestResponse,
  AcceptFriendRequestRequest,
  AcceptFriendRequestResponse,
  RejectFriendRequestRequest,
  RejectFriendRequestResponse,
  UpdateFriendNameRequest,
  UpdateFriendNameResponse,
  RemoveFriendRequest,
  RemoveFriendResponse,
} from './core/types.js';

// Types — Blocks Request / Response
export type {
  BlockUserRequest,
  BlockUserResponse,
  UnblockUserRequest,
  UnblockUserResponse,
  ListBlocksRequest,
  ListBlocksResponse,
} from './core/types.js';

// Types — Conversations Request / Response
export type {
  CreateConversationRequest,
  CreateConversationResponse,
  ListConversationsRequest,
  ListConversationsResponse,
  GetConversationRequest,
  GetConversationResponse,
  UpdateConversationRequest,
  UpdateConversationResponse,
  UpdateConversationSettingsRequest,
  UpdateConversationSettingsResponse,
  AddMembersRequest,
  AddMembersResponse,
  RemoveMemberRequest,
  RemoveMemberResponse,
  UpdateMemberRoleRequest,
  UpdateMemberRoleResponse,
  MarkReadRequest,
  MarkReadResponse,
  UpdateNotifyLevelRequest,
  UpdateNotifyLevelResponse,
} from './core/types.js';

// Types — Messages Request / Response
export type {
  SendMessageRequest,
  SendMessageResponse,
  ListMessagesRequest,
  ListMessagesResponse,
  GetMessageRequest,
  GetMessageResponse,
  EditMessageRequest,
  EditMessageResponse,
  DeleteMessageRequest,
  DeleteMessageResponse,
} from './core/types.js';

// Types — Media Request / Response
export type {
  GetUploadUrlRequest,
  GetUploadUrlResponse,
  UploadFileRequest,
  UploadFileResponse,
  UploadAvatarRequest,
  UploadAvatarResponse,
  GetDownloadUrlRequest,
  GetDownloadUrlResponse,
} from './core/types.js';

// Types — Agent Settings Request / Response
export type {
  GetMySettingsRequest,
  GetMySettingsResponse,
  UpdateMySettingsRequest,
  UpdateMySettingsResponse,
  UpdateMyProfileRequest,
  UpdateMyProfileResponse,
} from './core/types.js';

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
  ActivityStatusEvent,
  NewioEvent,
  EventMap,
} from './core/events.js';

// NewioApp — high-level agent client
export { NewioApp, NEWIO_API_BASE_URL, NEWIO_WS_URL } from './app/index.js';
export { NewioAppStore } from './app/index.js';
export type { StorePersistence } from './app/index.js';
export type {
  IncomingMessage,
  MessageHandler,
  AppEventHandlers,
  ContactEventInfo,
  ContactSummary,
  ConversationSummary,
  FriendRequestSummary,
  MemberSummary,
  NewioIdentity,
  NewioTokens,
} from './app/index.js';
export type { NewioAppCreateOptions } from './app/index.js';
