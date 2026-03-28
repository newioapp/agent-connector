import { describe, it, expect, vi, afterEach } from 'vitest';
import { NewioClient } from '../src/client.js';

let fetchCalls: Array<{ url: string; method: string; body?: unknown }>;

function mockFetch(responses: Array<{ status: number; body: unknown }>): void {
  let callIndex = 0;
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, opts?: RequestInit) => {
      fetchCalls.push({
        url,
        method: opts?.method ?? 'GET',
        body: opts?.body ? (JSON.parse(opts.body as string) as unknown) : undefined,
      });
      const res = responses[callIndex++];
      if (!res) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });
      }
      return Promise.resolve({
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: () => Promise.resolve(res.body),
      });
    }),
  );
}

function createClient(): NewioClient {
  return new NewioClient({ baseUrl: 'https://api.test', tokenProvider: () => 'test-token' });
}

describe('NewioClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------

  describe('profile', () => {
    it('getMe', async () => {
      mockFetch([{ status: 200, body: { userId: 'u1', accountType: 'agent' } }]);
      const result = await createClient().getMe({});
      expect(result.userId).toBe('u1');
      expect(fetchCalls[0]?.url).toBe('https://api.test/users/me');
    });

    it('updateMe', async () => {
      mockFetch([{ status: 200, body: { userId: 'u1', displayName: 'New' } }]);
      await createClient().updateMe({ displayName: 'New' });
      expect(fetchCalls[0]?.method).toBe('PUT');
      expect(fetchCalls[0]?.body).toEqual({ displayName: 'New' });
    });

    it('checkUsernameAvailability', async () => {
      mockFetch([{ status: 200, body: { available: true } }]);
      const result = await createClient().checkUsernameAvailability({ username: 'myagent' });
      expect(result.available).toBe(true);
      expect(fetchCalls[0]?.url).toContain('/users/username-available/myagent');
    });
  });

  // -------------------------------------------------------------------------
  // User Discovery
  // -------------------------------------------------------------------------

  describe('user discovery', () => {
    it('getUserByUsername', async () => {
      mockFetch([{ status: 200, body: { userId: 'u2', username: 'alice' } }]);
      const result = await createClient().getUserByUsername({ username: 'alice' });
      expect(result.username).toBe('alice');
    });

    it('getUser', async () => {
      mockFetch([{ status: 200, body: { userId: 'u2' } }]);
      await createClient().getUser({ userId: 'u2' });
      expect(fetchCalls[0]?.url).toContain('/users/u2');
    });

    it('searchUsers', async () => {
      mockFetch([{ status: 200, body: { users: [] } }]);
      await createClient().searchUsers({ query: 'alice' });
      expect(fetchCalls[0]?.url).toContain('search=alice');
    });

    it('getUserSummaries', async () => {
      mockFetch([{ status: 200, body: { users: [] } }]);
      await createClient().getUserSummaries({ userIds: ['u1', 'u2'] });
      expect(fetchCalls[0]?.body).toEqual({ userIds: ['u1', 'u2'] });
    });

    it('getUserAgents', async () => {
      mockFetch([{ status: 200, body: { agents: [] } }]);
      await createClient().getUserAgents({ userId: 'u1', limit: 10 });
      expect(fetchCalls[0]?.url).toContain('/users/u1/agents');
      expect(fetchCalls[0]?.url).toContain('limit=10');
    });
  });

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  describe('contacts', () => {
    it('listFriends', async () => {
      mockFetch([{ status: 200, body: { contacts: [] } }]);
      await createClient().listFriends({ limit: 5 });
      expect(fetchCalls[0]?.url).toContain('limit=5');
    });

    it('sendFriendRequest', async () => {
      mockFetch([{ status: 201, body: { contact: { contactId: 'u2' } } }]);
      await createClient().sendFriendRequest({ contactId: 'u2', note: 'Hello!' });
      expect(fetchCalls[0]?.body).toEqual({ contactId: 'u2', note: 'Hello!' });
    });

    it('listIncomingRequests', async () => {
      mockFetch([{ status: 200, body: { requests: [] } }]);
      await createClient().listIncomingRequests({});
      expect(fetchCalls[0]?.url).toContain('/contacts/requests');
    });

    it('listOutgoingRequests', async () => {
      mockFetch([{ status: 200, body: { requests: [] } }]);
      await createClient().listOutgoingRequests({});
      expect(fetchCalls[0]?.url).toContain('/contacts/requests/outgoing');
    });

    it('revokeOutgoingRequest', async () => {
      mockFetch([{ status: 204, body: null }]);
      await createClient().revokeOutgoingRequest({ contactId: 'u2' });
      expect(fetchCalls[0]?.method).toBe('DELETE');
    });

    it('acceptFriendRequest', async () => {
      mockFetch([{ status: 200, body: { contact: {} } }]);
      await createClient().acceptFriendRequest({ requestId: 'req-1' });
      expect(fetchCalls[0]?.url).toContain('/contacts/requests/req-1/accept');
    });

    it('rejectFriendRequest', async () => {
      mockFetch([{ status: 204, body: null }]);
      await createClient().rejectFriendRequest({ requestId: 'req-1' });
      expect(fetchCalls[0]?.url).toContain('/contacts/requests/req-1/reject');
    });

    it('updateFriendName', async () => {
      mockFetch([{ status: 200, body: { contact: {} } }]);
      await createClient().updateFriendName({ contactId: 'u2', friendName: 'Ally' });
      expect(fetchCalls[0]?.body).toEqual({ friendName: 'Ally' });
    });

    it('removeFriend', async () => {
      mockFetch([{ status: 204, body: null }]);
      await createClient().removeFriend({ userId: 'u2' });
      expect(fetchCalls[0]?.method).toBe('DELETE');
      expect(fetchCalls[0]?.url).toContain('/contacts/u2');
    });
  });

  // -------------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------------

  describe('blocks', () => {
    it('blockUser', async () => {
      mockFetch([{ status: 201, body: { userId: 'u1', blockedUserId: 'u2' } }]);
      await createClient().blockUser({ userId: 'u2' });
      expect(fetchCalls[0]?.method).toBe('POST');
      expect(fetchCalls[0]?.url).toContain('/blocks/u2');
    });

    it('unblockUser', async () => {
      mockFetch([{ status: 204, body: null }]);
      await createClient().unblockUser({ userId: 'u2' });
      expect(fetchCalls[0]?.method).toBe('DELETE');
    });

    it('listBlocks', async () => {
      mockFetch([{ status: 200, body: { blocks: [] } }]);
      await createClient().listBlocks({});
      expect(fetchCalls[0]?.url).toContain('/blocks');
    });
  });

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  describe('conversations', () => {
    it('createConversation', async () => {
      mockFetch([{ status: 201, body: { conversation: { conversationId: 'c1' }, members: [] } }]);
      await createClient().createConversation({ type: 'group', name: 'Test', memberIds: ['u2'] });
      expect(fetchCalls[0]?.body).toEqual({ type: 'group', name: 'Test', memberIds: ['u2'] });
    });

    it('createDm', async () => {
      mockFetch([{ status: 201, body: { conversation: { conversationId: 'c1' }, members: [] } }]);
      await createClient().createDm({ userId: 'u2' });
      expect(fetchCalls[0]?.body).toEqual({ type: 'dm', memberIds: ['u2'] });
    });

    it('listConversations', async () => {
      mockFetch([{ status: 200, body: { conversations: [] } }]);
      await createClient().listConversations({});
      expect(fetchCalls[0]?.url).toContain('/conversations');
    });

    it('getConversation', async () => {
      mockFetch([{ status: 200, body: { conversation: {}, members: [] } }]);
      await createClient().getConversation({ conversationId: 'c1' });
      expect(fetchCalls[0]?.url).toContain('/conversations/c1');
    });

    it('updateConversation', async () => {
      mockFetch([{ status: 200, body: { conversation: {}, members: [] } }]);
      await createClient().updateConversation({ conversationId: 'c1', name: 'Renamed' });
      expect(fetchCalls[0]?.method).toBe('PUT');
    });

    it('updateConversationSettings', async () => {
      mockFetch([{ status: 200, body: { settings: {} } }]);
      await createClient().updateConversationSettings({
        conversationId: 'c1',
        settings: { allowMemberInvites: true },
      });
      expect(fetchCalls[0]?.url).toContain('/conversations/c1/settings');
    });

    it('addMembers', async () => {
      mockFetch([{ status: 201, body: { members: [] } }]);
      await createClient().addMembers({ conversationId: 'c1', memberIds: ['u2', 'u3'] });
      expect(fetchCalls[0]?.body).toEqual({ memberIds: ['u2', 'u3'] });
    });

    it('removeMember', async () => {
      mockFetch([{ status: 204, body: null }]);
      await createClient().removeMember({ conversationId: 'c1', userId: 'u2' });
      expect(fetchCalls[0]?.method).toBe('DELETE');
      expect(fetchCalls[0]?.url).toContain('/conversations/c1/members/u2');
    });

    it('updateMemberRole', async () => {
      mockFetch([{ status: 200, body: { member: {} } }]);
      await createClient().updateMemberRole({ conversationId: 'c1', userId: 'u2', role: 'admin' });
      expect(fetchCalls[0]?.body).toEqual({ role: 'admin' });
    });

    it('markRead', async () => {
      mockFetch([{ status: 200, body: { readUntil: '2026-01-01T00:00:00Z' } }]);
      await createClient().markRead({ conversationId: 'c1', readUntil: '2026-01-01T00:00:00Z' });
      expect(fetchCalls[0]?.url).toContain('/conversations/c1/read');
    });

    it('updateNotifyLevel', async () => {
      mockFetch([{ status: 200, body: { notifyLevel: 'mentions' } }]);
      await createClient().updateNotifyLevel({ conversationId: 'c1', notifyLevel: 'mentions' });
      expect(fetchCalls[0]?.body).toEqual({ notifyLevel: 'mentions' });
    });
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  describe('messages', () => {
    it('sendMessage auto-increments sequenceNumber', async () => {
      mockFetch([
        { status: 201, body: { message: { messageId: 'm1' } } },
        { status: 201, body: { message: { messageId: 'm2' } } },
      ]);
      const client = createClient();
      await client.sendMessage({ conversationId: 'c1', content: { text: 'Hello' } });
      await client.sendMessage({ conversationId: 'c1', content: { text: 'World' } });
      expect(fetchCalls[0]?.body).toEqual({ content: { text: 'Hello' }, sequenceNumber: 1 });
      expect(fetchCalls[1]?.body).toEqual({ content: { text: 'World' }, sequenceNumber: 2 });
    });

    it('sendMessage tracks sequenceNumber per conversation', async () => {
      mockFetch([
        { status: 201, body: { message: { messageId: 'm1' } } },
        { status: 201, body: { message: { messageId: 'm2' } } },
      ]);
      const client = createClient();
      await client.sendMessage({ conversationId: 'c1', content: { text: 'A' } });
      await client.sendMessage({ conversationId: 'c2', content: { text: 'B' } });
      expect(fetchCalls[0]?.body).toEqual({ content: { text: 'A' }, sequenceNumber: 1 });
      expect(fetchCalls[1]?.body).toEqual({ content: { text: 'B' }, sequenceNumber: 1 });
    });

    it('listMessages with pagination', async () => {
      mockFetch([{ status: 200, body: { messages: [] } }]);
      await createClient().listMessages({ conversationId: 'c1', limit: 20, afterMessageId: 'm1' });
      expect(fetchCalls[0]?.url).toContain('limit=20');
      expect(fetchCalls[0]?.url).toContain('afterMessageId=m1');
    });

    it('getMessage', async () => {
      mockFetch([{ status: 200, body: { message: { messageId: 'm1' } } }]);
      await createClient().getMessage({ conversationId: 'c1', messageId: 'm1' });
      expect(fetchCalls[0]?.url).toContain('/conversations/c1/messages/m1');
    });

    it('editMessage', async () => {
      mockFetch([{ status: 200, body: { message: {} } }]);
      await createClient().editMessage({ conversationId: 'c1', messageId: 'm1', content: { text: 'Edited' } });
      expect(fetchCalls[0]?.method).toBe('PUT');
      expect(fetchCalls[0]?.body).toEqual({ content: { text: 'Edited' } });
    });

    it('deleteMessage', async () => {
      mockFetch([{ status: 204, body: null }]);
      await createClient().deleteMessage({ conversationId: 'c1', messageId: 'm1' });
      expect(fetchCalls[0]?.method).toBe('DELETE');
    });
  });

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  describe('media', () => {
    it('getUploadUrl', async () => {
      mockFetch([{ status: 200, body: { uploadUrl: 'https://s3.test', fields: {}, s3Key: 'k1' } }]);
      const result = await createClient().getUploadUrl({
        fileName: 'photo.jpg',
        contentType: 'image/jpeg',
        artifactType: 'media',
      });
      expect(result.s3Key).toBe('k1');
    });

    it('getDownloadUrl', async () => {
      mockFetch([{ status: 200, body: { url: 'https://cdn.test/file' } }]);
      const result = await createClient().getDownloadUrl({ conversationId: 'c1', s3Key: 'media/c1/photo.jpg' });
      expect(result.url).toBe('https://cdn.test/file');
      expect(fetchCalls[0]?.body).toEqual({ conversationId: 'c1', s3Key: 'media/c1/photo.jpg' });
    });
  });

  // -------------------------------------------------------------------------
  // Agent Settings
  // -------------------------------------------------------------------------

  describe('agent settings', () => {
    it('getMySettings', async () => {
      mockFetch([{ status: 200, body: { agentId: 'a1', settings: {} } }]);
      await createClient().getMySettings({ agentId: 'a1' });
      expect(fetchCalls[0]?.url).toContain('/agents/a1/settings');
    });

    it('updateMySettings', async () => {
      mockFetch([{ status: 200, body: { agentId: 'a1', settings: {} } }]);
      await createClient().updateMySettings({ agentId: 'a1', settings: { dmAllowlist: 'anyone_in_contacts' } });
      expect(fetchCalls[0]?.method).toBe('PUT');
      expect(fetchCalls[0]?.body).toEqual({ dmAllowlist: 'anyone_in_contacts' });
    });

    it('updateMyProfile', async () => {
      mockFetch([{ status: 200, body: { agentId: 'a1', displayName: 'Bot' } }]);
      await createClient().updateMyProfile({ agentId: 'a1', displayName: 'Bot' });
      expect(fetchCalls[0]?.url).toContain('/agents/a1/profile');
      expect(fetchCalls[0]?.body).toEqual({ displayName: 'Bot' });
    });
  });
});
