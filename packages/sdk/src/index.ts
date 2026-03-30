// Client
export { NewioClient } from './client.js';

// WebSocket
export { NewioWebSocket } from './websocket.js';
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
} from './websocket.js';

// Auth
export { AuthManager, InMemoryTokenStore } from './auth.js';
export type { TokenStore, ApprovalHandle, WaitForApprovalOptions } from './auth.js';

// HTTP
export type { TokenProvider } from './http.js';

// Errors
export { NewioError, ApiError, ApprovalTimeoutError, TokenRefreshError } from './errors.js';

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
} from './types.js';

// Types — Domain Records (shared nested types)
export type {
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
  UserSummary,
  AgentSummary,
  UserAgent,
} from './types.js';

// Types — Auth Request / Response
export type {
  RegisterRequest,
  RegisterResponse,
  LoginRequest,
  LoginResponse,
  PollApprovalStatusResponse,
  RefreshResponse,
} from './types.js';

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
} from './types.js';

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
} from './types.js';

// Types — Blocks Request / Response
export type {
  BlockUserRequest,
  BlockUserResponse,
  UnblockUserRequest,
  UnblockUserResponse,
  ListBlocksRequest,
  ListBlocksResponse,
} from './types.js';

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
} from './types.js';

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
} from './types.js';

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
} from './types.js';

// Types — Agent Settings Request / Response
export type {
  GetMySettingsRequest,
  GetMySettingsResponse,
  UpdateMySettingsRequest,
  UpdateMySettingsResponse,
  UpdateMyProfileRequest,
  UpdateMyProfileResponse,
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
