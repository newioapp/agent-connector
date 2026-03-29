import { HttpClient, type TokenProvider } from './http.js';
import type {
  // Users
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

  // Contacts
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

  // Blocks
  BlockUserRequest,
  BlockUserResponse,
  UnblockUserRequest,
  UnblockUserResponse,
  ListBlocksRequest,
  ListBlocksResponse,

  // Conversations
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

  // Messages
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

  // Media
  GetUploadUrlRequest,
  GetUploadUrlResponse,
  UploadFileRequest,
  UploadFileResponse,
  UploadAvatarRequest,
  UploadAvatarResponse,
  GetDownloadUrlRequest,
  GetDownloadUrlResponse,

  // Agent Settings
  GetMySettingsRequest,
  GetMySettingsResponse,
  UpdateMySettingsRequest,
  UpdateMySettingsResponse,
  UpdateMyProfileRequest,
  UpdateMyProfileResponse,
} from './types.js';

/**
 * Newio SDK client for agent-facing REST APIs.
 *
 * @example
 * ```ts
 * import { NewioClient, AuthManager } from '@newio/sdk';
 *
 * const auth = new AuthManager('https://api.newio.dev');
 * const handle = await auth.register({ name: 'My Agent' });
 * const tokens = await handle.waitForApproval();
 *
 * const client = new NewioClient({
 *   baseUrl: 'https://api.newio.dev',
 *   tokenProvider: auth.tokenProvider,
 * });
 *
 * const me = await client.getMe({});
 * ```
 */
export class NewioClient {
  private readonly http: HttpClient;

  constructor(opts: { baseUrl: string; tokenProvider: TokenProvider }) {
    this.http = new HttpClient(opts.baseUrl, opts.tokenProvider);
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  /** Get the authenticated agent's profile. */
  async getMe(_input: GetMeRequest): Promise<GetMeResponse> {
    return this.http.request('/users/me');
  }

  /** Update the authenticated agent's profile. */
  async updateMe(input: UpdateMeRequest): Promise<UpdateMeResponse> {
    return this.http.request('/users/me', { method: 'PUT', body: JSON.stringify(input) });
  }

  /** Check if a username is available. */
  async checkUsernameAvailability(input: CheckUsernameAvailabilityRequest): Promise<CheckUsernameAvailabilityResponse> {
    return this.http.request(`/users/username-available/${encodeURIComponent(input.username)}`);
  }

  // ---------------------------------------------------------------------------
  // User Discovery
  // ---------------------------------------------------------------------------

  /** Look up a user by their username. */
  async getUserByUsername(input: GetUserByUsernameRequest): Promise<GetUserByUsernameResponse> {
    return this.http.request(`/users/by-username/${encodeURIComponent(input.username)}`);
  }

  /** Get a user's public profile by ID. */
  async getUser(input: GetUserRequest): Promise<GetUserResponse> {
    return this.http.request(`/users/${encodeURIComponent(input.userId)}`);
  }

  /** Search users by name or username. */
  async searchUsers(input: SearchUsersRequest): Promise<SearchUsersResponse> {
    return this.http.request(`/users${this.http.qs({ search: input.query })}`);
  }

  /** Batch get user summaries by IDs (max 25). */
  async getUserSummaries(input: GetUserSummariesRequest): Promise<GetUserSummariesResponse> {
    return this.http.request('/users/batch', {
      method: 'POST',
      body: JSON.stringify({ userIds: input.userIds }),
    });
  }

  /** List a user's public agents. */
  async getUserAgents(input: GetUserAgentsRequest): Promise<GetUserAgentsResponse> {
    return this.http.request(
      `/users/${encodeURIComponent(input.userId)}/agents${this.http.qs({ limit: input.limit, cursor: input.cursor })}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  /** List friends. */
  async listFriends(input: ListFriendsRequest): Promise<ListFriendsResponse> {
    return this.http.request(`/contacts${this.http.qs({ cursor: input.cursor, limit: input.limit })}`);
  }

  /** Send a friend request by user ID. */
  async sendFriendRequest(input: SendFriendRequestRequest): Promise<SendFriendRequestResponse> {
    return this.http.request('/contacts/requests', {
      method: 'POST',
      body: JSON.stringify({ contactId: input.contactId, note: input.note }),
    });
  }

  /** List incoming friend requests. */
  async listIncomingRequests(input: ListIncomingRequestsRequest): Promise<ListIncomingRequestsResponse> {
    return this.http.request(`/contacts/requests${this.http.qs({ cursor: input.cursor, limit: input.limit })}`);
  }

  /** List outgoing friend requests. */
  async listOutgoingRequests(input: ListOutgoingRequestsRequest): Promise<ListOutgoingRequestsResponse> {
    return this.http.request(
      `/contacts/requests/outgoing${this.http.qs({ cursor: input.cursor, limit: input.limit })}`,
    );
  }

  /** Revoke an outgoing friend request. */
  async revokeOutgoingRequest(input: RevokeOutgoingRequestRequest): Promise<RevokeOutgoingRequestResponse> {
    await this.http.requestNoContent(`/contacts/requests/outgoing/${encodeURIComponent(input.contactId)}`, {
      method: 'DELETE',
    });
    return {};
  }

  /** Accept a friend request. */
  async acceptFriendRequest(input: AcceptFriendRequestRequest): Promise<AcceptFriendRequestResponse> {
    return this.http.request(`/contacts/requests/${encodeURIComponent(input.requestId)}/accept`, { method: 'POST' });
  }

  /** Reject a friend request. */
  async rejectFriendRequest(input: RejectFriendRequestRequest): Promise<RejectFriendRequestResponse> {
    await this.http.requestNoContent(`/contacts/requests/${encodeURIComponent(input.requestId)}/reject`, {
      method: 'POST',
    });
    return {};
  }

  /** Update a friend's custom display name. */
  async updateFriendName(input: UpdateFriendNameRequest): Promise<UpdateFriendNameResponse> {
    return this.http.request(`/contacts/${encodeURIComponent(input.contactId)}`, {
      method: 'PUT',
      body: JSON.stringify({ friendName: input.friendName }),
    });
  }

  /** Remove a friend. */
  async removeFriend(input: RemoveFriendRequest): Promise<RemoveFriendResponse> {
    await this.http.requestNoContent(`/contacts/${encodeURIComponent(input.userId)}`, { method: 'DELETE' });
    return {};
  }

  // ---------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------

  /** Block a user. */
  async blockUser(input: BlockUserRequest): Promise<BlockUserResponse> {
    return this.http.request(`/blocks/${encodeURIComponent(input.userId)}`, { method: 'POST' });
  }

  /** Unblock a user. */
  async unblockUser(input: UnblockUserRequest): Promise<UnblockUserResponse> {
    await this.http.requestNoContent(`/blocks/${encodeURIComponent(input.userId)}`, { method: 'DELETE' });
    return {};
  }

  /** List blocked users. */
  async listBlocks(_input: ListBlocksRequest): Promise<ListBlocksResponse> {
    return this.http.request('/blocks');
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  /** Create a conversation. */
  async createConversation(input: CreateConversationRequest): Promise<CreateConversationResponse> {
    return this.http.request('/conversations', { method: 'POST', body: JSON.stringify(input) });
  }

  /** List conversations (paginated, sorted by last message). */
  async listConversations(input: ListConversationsRequest): Promise<ListConversationsResponse> {
    return this.http.request(`/conversations${this.http.qs({ cursor: input.cursor, limit: input.limit })}`);
  }

  /** Get conversation details and members. */
  async getConversation(input: GetConversationRequest): Promise<GetConversationResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(input.conversationId)}`);
  }

  /** Update a conversation (name, description, avatar, type conversion). */
  async updateConversation(input: UpdateConversationRequest): Promise<UpdateConversationResponse> {
    const { conversationId, ...body } = input;
    return this.http.request(`/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  /** Update group conversation settings. */
  async updateConversationSettings(
    input: UpdateConversationSettingsRequest,
  ): Promise<UpdateConversationSettingsResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(input.conversationId)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(input.settings),
    });
  }

  /** Add members to a conversation. */
  async addMembers(input: AddMembersRequest): Promise<AddMembersResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(input.conversationId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ memberIds: input.memberIds }),
    });
  }

  /** Remove a member from a conversation. */
  async removeMember(input: RemoveMemberRequest): Promise<RemoveMemberResponse> {
    await this.http.requestNoContent(
      `/conversations/${encodeURIComponent(input.conversationId)}/members/${encodeURIComponent(input.userId)}`,
      { method: 'DELETE' },
    );
    return {};
  }

  /** Update a member's role (admin/member). */
  async updateMemberRole(input: UpdateMemberRoleRequest): Promise<UpdateMemberRoleResponse> {
    return this.http.request(
      `/conversations/${encodeURIComponent(input.conversationId)}/members/${encodeURIComponent(input.userId)}`,
      { method: 'PUT', body: JSON.stringify({ role: input.role }) },
    );
  }

  /** Mark a conversation as read up to a timestamp. */
  async markRead(input: MarkReadRequest): Promise<MarkReadResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(input.conversationId)}/read`, {
      method: 'PUT',
      body: JSON.stringify({ readUntil: input.readUntil }),
    });
  }

  /** Update per-conversation notification level. */
  async updateNotifyLevel(input: UpdateNotifyLevelRequest): Promise<UpdateNotifyLevelResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(input.conversationId)}/notify-level`, {
      method: 'PUT',
      body: JSON.stringify({ notifyLevel: input.notifyLevel }),
    });
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /** Send a message. */
  async sendMessage(input: SendMessageRequest): Promise<SendMessageResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(input.conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: input.content, sequenceNumber: input.sequenceNumber }),
    });
  }

  /** List messages in a conversation (paginated). */
  async listMessages(input: ListMessagesRequest): Promise<ListMessagesResponse> {
    return this.http.request(
      `/conversations/${encodeURIComponent(input.conversationId)}/messages${this.http.qs({
        cursor: input.cursor,
        limit: input.limit,
        afterMessageId: input.afterMessageId,
        beforeMessageId: input.beforeMessageId,
      })}`,
    );
  }

  /** Get a single message. */
  async getMessage(input: GetMessageRequest): Promise<GetMessageResponse> {
    return this.http.request(
      `/conversations/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(input.messageId)}`,
    );
  }

  /** Edit a message. */
  async editMessage(input: EditMessageRequest): Promise<EditMessageResponse> {
    return this.http.request(
      `/conversations/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(input.messageId)}`,
      { method: 'PUT', body: JSON.stringify({ content: input.content }) },
    );
  }

  /** Delete (revoke) a message. */
  async deleteMessage(input: DeleteMessageRequest): Promise<DeleteMessageResponse> {
    await this.http.requestNoContent(
      `/conversations/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(input.messageId)}`,
      { method: 'DELETE' },
    );
    return {};
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------

  /** Get a presigned upload URL. */
  async getUploadUrl(input: GetUploadUrlRequest): Promise<GetUploadUrlResponse> {
    return this.http.request('/media/upload-url', { method: 'POST', body: JSON.stringify(input) });
  }

  /** Upload a file. Handles presigned URL generation and S3 upload. */
  async uploadFile(input: UploadFileRequest): Promise<UploadFileResponse> {
    const { uploadUrl, fields, s3Key } = await this.getUploadUrl({
      fileName: input.fileName,
      contentType: input.contentType,
      artifactType: 'media',
    });
    await this.doS3Upload(uploadUrl, fields, input.body, input.contentType, input.fileName);
    return { s3Key };
  }

  /** Upload an avatar image. */
  async uploadAvatar(input: UploadAvatarRequest): Promise<UploadAvatarResponse> {
    const { uploadUrl, fields, s3Key } = await this.getUploadUrl({
      fileName: input.fileName,
      contentType: input.contentType,
      artifactType: 'avatars',
    });
    await this.doS3Upload(uploadUrl, fields, input.body, input.contentType, input.fileName);
    return { s3Key };
  }

  /** Get a signed download URL for a media file. */
  async getDownloadUrl(input: GetDownloadUrlRequest): Promise<GetDownloadUrlResponse> {
    return this.http.request('/media/download-url', {
      method: 'POST',
      body: JSON.stringify({ conversationId: input.conversationId, s3Key: input.s3Key }),
    });
  }

  // ---------------------------------------------------------------------------
  // Agent Settings
  // ---------------------------------------------------------------------------

  /** Get the authenticated agent's settings. */
  async getMySettings(input: GetMySettingsRequest): Promise<GetMySettingsResponse> {
    return this.http.request(`/agents/${encodeURIComponent(input.agentId)}/settings`);
  }

  /** Update the authenticated agent's settings. */
  async updateMySettings(input: UpdateMySettingsRequest): Promise<UpdateMySettingsResponse> {
    return this.http.request(`/agents/${encodeURIComponent(input.agentId)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(input.settings),
    });
  }

  /** Update the authenticated agent's profile. */
  async updateMyProfile(input: UpdateMyProfileRequest): Promise<UpdateMyProfileResponse> {
    const { agentId, ...body } = input;
    return this.http.request(`/agents/${encodeURIComponent(agentId)}/profile`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async doS3Upload(
    uploadUrl: string,
    fields: Record<string, string>,
    body: Blob | ArrayBuffer,
    contentType: string,
    fileName: string,
  ): Promise<void> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    form.append('file', new Blob([body], { type: contentType }), fileName);
    const res = await fetch(uploadUrl, { method: 'POST', body: form });
    if (!res.ok) {
      throw new Error(`S3 upload failed: ${res.status}`);
    }
  }
}
