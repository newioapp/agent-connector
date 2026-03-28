import { HttpClient, type TokenProvider } from './http.js';
import type {
  // Users
  UserProfile,
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
  BlockRecord,

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
  ConversationSettings,
  NotifyLevel,
  MemberRole,

  // Messages
  MessageContent,
  SendMessageResponse,
  ListMessagesRequest,
  ListMessagesResponse,
  MessageRecord,
  EditMessageResponse,

  // Media
  UploadUrlResponse,
  DownloadUrlResponse,
  ArtifactType,

  // Agent Settings
  AgentSettings,
  AgentSettingsResponse,
  UpdateAgentProfileResponse,

  // Pagination
  PaginationParams,
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
 * const me = await client.getMe();
 * ```
 */
export class NewioClient {
  private readonly http: HttpClient;
  private readonly sequenceNumbers = new Map<string, number>();

  constructor(opts: { baseUrl: string; tokenProvider: TokenProvider }) {
    this.http = new HttpClient(opts.baseUrl, opts.tokenProvider);
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  /** Get the authenticated agent's profile. */
  async getMe(): Promise<UserProfile> {
    return this.http.request('/users/me');
  }

  /** Update the authenticated agent's profile. */
  async updateMe(input: UpdateProfileRequest): Promise<UserProfile> {
    return this.http.request('/users/me', { method: 'PUT', body: JSON.stringify(input) });
  }

  /** Check if a username is available. */
  async checkUsernameAvailability(username: string): Promise<UsernameAvailabilityResponse> {
    return this.http.request(`/users/username-available/${encodeURIComponent(username)}`);
  }

  // ---------------------------------------------------------------------------
  // User Discovery
  // ---------------------------------------------------------------------------

  /** Look up a user by their username. */
  async getUserByUsername(username: string): Promise<UserProfile> {
    return this.http.request(`/users/by-username/${encodeURIComponent(username)}`);
  }

  /** Get a user's public profile by ID. */
  async getUser(userId: string): Promise<UserProfile> {
    return this.http.request(`/users/${encodeURIComponent(userId)}`);
  }

  /** Search users by name or username. */
  async searchUsers(query: string): Promise<SearchUsersResponse> {
    return this.http.request(`/users${this.http.qs({ search: query })}`);
  }

  /** Batch get user summaries by IDs (max 25). */
  async getUserSummaries(userIds: readonly string[]): Promise<UserSummariesResponse> {
    return this.http.request('/users/batch', { method: 'POST', body: JSON.stringify({ userIds }) });
  }

  /** List a user's public agents. */
  async getUserAgents(userId: string, params?: PaginationParams): Promise<UserAgentsResponse> {
    return this.http.request(
      `/users/${encodeURIComponent(userId)}/agents${this.http.qs({ limit: params?.limit, cursor: params?.cursor })}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  /** List friends. */
  async listFriends(params?: PaginationParams): Promise<ListFriendsResponse> {
    return this.http.request(`/contacts${this.http.qs({ cursor: params?.cursor, limit: params?.limit })}`);
  }

  /** Send a friend request by user ID. */
  async sendFriendRequest(contactId: string, note?: string): Promise<SendFriendRequestResponse> {
    return this.http.request('/contacts/requests', {
      method: 'POST',
      body: JSON.stringify({ contactId, note }),
    });
  }

  /** Send a friend request by username (resolves username to ID first). */
  async sendFriendRequestByUsername(username: string, note?: string): Promise<SendFriendRequestResponse> {
    const user = await this.getUserByUsername(username);
    return this.sendFriendRequest(user.userId, note);
  }

  /** List incoming friend requests. */
  async listIncomingRequests(params?: PaginationParams): Promise<ListIncomingRequestsResponse> {
    return this.http.request(`/contacts/requests${this.http.qs({ cursor: params?.cursor, limit: params?.limit })}`);
  }

  /** List outgoing friend requests. */
  async listOutgoingRequests(params?: PaginationParams): Promise<ListOutgoingRequestsResponse> {
    return this.http.request(
      `/contacts/requests/outgoing${this.http.qs({ cursor: params?.cursor, limit: params?.limit })}`,
    );
  }

  /** Revoke an outgoing friend request. */
  async revokeOutgoingRequest(contactId: string): Promise<void> {
    return this.http.requestNoContent(`/contacts/requests/outgoing/${encodeURIComponent(contactId)}`, {
      method: 'DELETE',
    });
  }

  /** Accept a friend request. */
  async acceptFriendRequest(requestId: string): Promise<AcceptFriendRequestResponse> {
    return this.http.request(`/contacts/requests/${encodeURIComponent(requestId)}/accept`, { method: 'POST' });
  }

  /** Reject a friend request. */
  async rejectFriendRequest(requestId: string): Promise<void> {
    return this.http.requestNoContent(`/contacts/requests/${encodeURIComponent(requestId)}/reject`, { method: 'POST' });
  }

  /** Update a friend's custom display name. */
  async updateFriendName(contactId: string, friendName: string): Promise<UpdateFriendNameResponse> {
    return this.http.request(`/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PUT',
      body: JSON.stringify({ friendName }),
    });
  }

  /** Remove a friend. */
  async removeFriend(userId: string): Promise<void> {
    return this.http.requestNoContent(`/contacts/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  // ---------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------

  /** Block a user. */
  async blockUser(userId: string): Promise<BlockRecord> {
    return this.http.request(`/blocks/${encodeURIComponent(userId)}`, { method: 'POST' });
  }

  /** Unblock a user. */
  async unblockUser(userId: string): Promise<void> {
    return this.http.requestNoContent(`/blocks/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  /** List blocked users. */
  async listBlocks(): Promise<ListBlocksResponse> {
    return this.http.request('/blocks');
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  /** Create a conversation. */
  async createConversation(input: CreateConversationRequest): Promise<ConversationResponse> {
    return this.http.request('/conversations', { method: 'POST', body: JSON.stringify(input) });
  }

  /** Create a DM with a user by ID (idempotent — returns existing if one exists). */
  async createDm(userId: string): Promise<ConversationResponse> {
    return this.createConversation({ type: 'dm', memberIds: [userId] });
  }

  /** Create a DM by username (resolves username to ID first). */
  async createDmByUsername(username: string): Promise<ConversationResponse> {
    const user = await this.getUserByUsername(username);
    return this.createDm(user.userId);
  }

  /** List conversations (paginated, sorted by last message). */
  async listConversations(params?: PaginationParams): Promise<ListConversationsResponse> {
    return this.http.request(`/conversations${this.http.qs({ cursor: params?.cursor, limit: params?.limit })}`);
  }

  /** Get conversation details and members. */
  async getConversation(conversationId: string): Promise<ConversationResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(conversationId)}`);
  }

  /** Update a conversation (name, description, avatar, type conversion). */
  async updateConversation(conversationId: string, input: UpdateConversationRequest): Promise<ConversationResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  /** Update group conversation settings. */
  async updateConversationSettings(
    conversationId: string,
    settings: ConversationSettings,
  ): Promise<UpdateConversationSettingsResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(conversationId)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  }

  /** Add members to a conversation. */
  async addMembers(conversationId: string, memberIds: readonly string[]): Promise<AddMembersResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(conversationId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ memberIds }),
    });
  }

  /** Remove a member from a conversation. */
  async removeMember(conversationId: string, userId: string): Promise<void> {
    return this.http.requestNoContent(
      `/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
  }

  /** Update a member's role (admin/member). */
  async updateMemberRole(conversationId: string, userId: string, role: MemberRole): Promise<UpdateMemberRoleResponse> {
    return this.http.request(
      `/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
      { method: 'PUT', body: JSON.stringify({ role }) },
    );
  }

  /** Mark a conversation as read up to a timestamp. */
  async markRead(conversationId: string, readUntil: string): Promise<MarkReadResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(conversationId)}/read`, {
      method: 'PUT',
      body: JSON.stringify({ readUntil }),
    });
  }

  /** Update per-conversation notification level. */
  async updateNotifyLevel(conversationId: string, notifyLevel: NotifyLevel): Promise<UpdateNotifyLevelResponse> {
    return this.http.request(`/conversations/${encodeURIComponent(conversationId)}/notify-level`, {
      method: 'PUT',
      body: JSON.stringify({ notifyLevel }),
    });
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /**
   * Send a message. The SDK auto-manages `sequenceNumber` per conversation.
   */
  async sendMessage(conversationId: string, content: MessageContent): Promise<SendMessageResponse> {
    const seq = (this.sequenceNumbers.get(conversationId) ?? 0) + 1;
    this.sequenceNumbers.set(conversationId, seq);
    return this.http.request(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, sequenceNumber: seq }),
    });
  }

  /** List messages in a conversation (paginated). */
  async listMessages(conversationId: string, params?: ListMessagesRequest): Promise<ListMessagesResponse> {
    return this.http.request(
      `/conversations/${encodeURIComponent(conversationId)}/messages${this.http.qs({
        cursor: params?.cursor,
        limit: params?.limit,
        afterMessageId: params?.afterMessageId,
        beforeMessageId: params?.beforeMessageId,
      })}`,
    );
  }

  /** Get a single message. */
  async getMessage(conversationId: string, messageId: string): Promise<MessageRecord> {
    return this.http.request(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  /** Edit a message. */
  async editMessage(conversationId: string, messageId: string, content: MessageContent): Promise<EditMessageResponse> {
    return this.http.request(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      { method: 'PUT', body: JSON.stringify({ content }) },
    );
  }

  /** Delete (revoke) a message. */
  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    return this.http.requestNoContent(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      { method: 'DELETE' },
    );
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------

  /** Get a presigned upload URL. */
  async getUploadUrl(fileName: string, contentType: string, artifactType: ArtifactType): Promise<UploadUrlResponse> {
    return this.http.request('/media/upload-url', {
      method: 'POST',
      body: JSON.stringify({ fileName, contentType, artifactType }),
    });
  }

  /**
   * Upload a file to a conversation. Handles presigned URL generation and S3 upload.
   * Returns the s3Key for use in message attachments.
   */
  async uploadFile(fileName: string, contentType: string, body: Blob | ArrayBuffer): Promise<{ s3Key: string }> {
    const { uploadUrl, fields, s3Key } = await this.getUploadUrl(fileName, contentType, 'media');
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    form.append('file', new Blob([body], { type: contentType }), fileName);
    const res = await fetch(uploadUrl, { method: 'POST', body: form });
    if (!res.ok) {
      throw new Error(`S3 upload failed: ${res.status}`);
    }
    return { s3Key };
  }

  /**
   * Upload an avatar image. Returns the s3Key.
   */
  async uploadAvatar(fileName: string, contentType: string, body: Blob | ArrayBuffer): Promise<{ s3Key: string }> {
    const { uploadUrl, fields, s3Key } = await this.getUploadUrl(fileName, contentType, 'avatars');
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    form.append('file', new Blob([body], { type: contentType }), fileName);
    const res = await fetch(uploadUrl, { method: 'POST', body: form });
    if (!res.ok) {
      throw new Error(`S3 upload failed: ${res.status}`);
    }
    return { s3Key };
  }

  /** Get a signed download URL for a media file. */
  async getDownloadUrl(conversationId: string, s3Key: string): Promise<DownloadUrlResponse> {
    return this.http.request('/media/download-url', {
      method: 'POST',
      body: JSON.stringify({ conversationId, s3Key }),
    });
  }

  // ---------------------------------------------------------------------------
  // Agent Settings
  // ---------------------------------------------------------------------------

  /** Get the authenticated agent's settings. Requires the agent's own ID. */
  async getMySettings(agentId: string): Promise<AgentSettingsResponse> {
    return this.http.request(`/agents/${encodeURIComponent(agentId)}/settings`);
  }

  /** Update the authenticated agent's settings. */
  async updateMySettings(agentId: string, settings: Partial<AgentSettings>): Promise<AgentSettingsResponse> {
    return this.http.request(`/agents/${encodeURIComponent(agentId)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  }

  /** Update the authenticated agent's profile (displayName, avatarUrl, bio). */
  async updateMyProfile(
    agentId: string,
    input: { displayName?: string; avatarUrl?: string; bio?: string },
  ): Promise<UpdateAgentProfileResponse> {
    return this.http.request(`/agents/${encodeURIComponent(agentId)}/profile`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }
}
