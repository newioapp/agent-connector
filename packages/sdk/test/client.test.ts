import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  return new NewioClient({
    baseUrl: 'https://api.test',
    tokenProvider: () => 'test-token',
  });
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
      const client = createClient();
      const result = await client.getMe();
      expect(result.userId).toBe('u1');
      expect(fetchCalls[0]?.url).toBe('https://api.test/users/me');
    });

    it('updateMe', async () => {
      mockFetch([{ status: 200, body: { userId: 'u1', displayName: 'New Name' } }]);
      const client = createClient();
      await client.updateMe({ displayName: 'New Name' });
      expect(fetchCalls[0]?.method).toBe('PUT');
      expect(fetchCalls[0]?.body).toEqual({ displayName: 'New Name' });
    });

    it('checkUsernameAvailability', async () => {
      mockFetch([{ status: 200, body: { available: true } }]);
      const client = createClient();
      const result = await client.checkUsernameAvailability('myagent');
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
      const client = createClient();
      const result = await client.getUserByUsername('alice');
      expect(result.username).toBe('alice');
      expect(fetchCalls[0]?.url).toContain('/users/by-username/alice');
    });

    it('getUser', async () => {
      mockFetch([{ status: 200, body: { userId: 'u2' } }]);
      const client = createClient();
      await client.getUser('u2');
      expect(fetchCalls[0]?.url).toContain('/users/u2');
    });

    it('searchUsers', async () => {
      mockFetch([{ status: 200, body: { users: [] } }]);
      const client = createClient();
      await client.searchUsers('alice');
      expect(fetchCalls[0]?.url).toContain('search=alice');
    });

    it('getUserSummaries', async () => {
      mockFetch([{ status: 200, body: { users: [] } }]);
      const client = createClient();
      await client.getUserSummaries(['u1', 'u2']);
      expect(fetchCalls[0]?.body).toEqual({ userIds: ['u1', 'u2'] });
    });

    it('getUserAgents', async () => {
      mockFetch([{ status: 200, body: { agents: [] } }]);
      const client = createClient();
      await client.getUserAgents('u1', { limit: 10 });
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
      const client = createClient();
      await client.listFriends({ limit: 5 });
      expect(fetchCalls[0]?.url).toContain('limit=5');
    });

    it('sendFriendRequest', async () => {
      mockFetch([{ status: 201, body: { contact: { contactId: 'u2' } } }]);
      const client = createClient();
      await client.sendFriendRequest('u2', 'Hello!');
      expect(fetchCalls[0]?.body).toEqual({ contactId: 'u2', note: 'Hello!' });
    });

    it('sendFriendRequestByUsername resolves username first', async () => {
      mockFetch([
        { status: 200, body: { userId: 'u2', username: 'alice' } },
        { status: 201, body: { contact: { contactId: 'u2' } } },
      ]);
      const client = createClient();
      await client.sendFriendRequestByUsername('alice', 'Hi');
      expect(fetchCalls[0]?.url).toContain('/users/by-username/alice');
      expect(fetchCalls[1]?.body).toEqual({ contactId: 'u2', note: 'Hi' });
    });

    it('listIncomingRequests', async () => {
      mockFetch([{ status: 200, body: { requests: [] } }]);
      const client = createClient();
      await client.listIncomingRequests();
      expect(fetchCalls[0]?.url).toContain('/contacts/requests');
    });

    it('listOutgoingRequests', async () => {
      mockFetch([{ status: 200, body: { requests: [] } }]);
      const client = createClient();
      await client.listOutgoingRequests();
      expect(fetchCalls[0]?.url).toContain('/contacts/requests/outgoing');
    });

    it('revokeOutgoingRequest', async () => {
      mockFetch([{ status: 204, body: null }]);
      const client = createClient();
      await client.revokeOutgoingRequest('u2');
      expect(fetchCalls[0]?.method).toBe('DELETE');
    });

    it('acceptFriendRequest', async () => {
      mockFetch([{ status: 200, body: { contact: {} } }]);
      const client = createClient();
      await client.acceptFriendRequest('req-1');
      expect(fetchCalls[0]?.url).toContain('/contacts/requests/req-1/accept');
    });

    it('rejectFriendRequest', async () => {
      mockFetch([{ status: 204, body: null }]);
      const client = createClient();
      await client.rejectFriendRequest('req-1');
      expect(fetchCalls[0]?.url).toContain('/contacts/requests/req-1/reject');
    });

    it('updateFriendName', async () => {
      mockFetch([{ status: 200, body: { contact: {} } }]);
      const client = createClient();
      await client.updateFriendName('u2', 'Ally');
      expect(fetchCalls[0]?.body).toEqual({ friendName: 'Ally' });
    });

    it('removeFriend', async () => {
      mockFetch([{ status: 204, body: null }]);
      const client = createClient();
      await client.removeFriend('u2');
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
      const client = createClient();
      await client.blockUser('u2');
      expect(fetchCalls[0]?.method).toBe('POST');
      expect(fetchCalls[0]?.url).toContain('/blocks/u2');
    });

    it('unblockUser', async () => {
      mockFetch([{ status: 204, body: null }]);
      const client = createClient();
      await client.unblockUser('u2');
      expect(fetchCalls[0]?.method).toBe('DELETE');
    });

    it('listBlocks', async () => {
      mockFetch([{ status: 200, body: { blocks: [] } }]);
      const client = createClient();
      await client.listBlocks();
      expect(fetchCalls[0]?.url).toContain('/blocks');
    });
  });

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  describe('conversations', () => {
    it('createConversation', async () => {
      mockFetch([{ status: 201, body: { conversation: { conversationId: 'c1' }, members: [] } }]);
      const client = createClient();
      await client.createConversation({ type: 'group', name: 'Test', memberIds: ['u2'] });
      expect(fetchCalls[0]?.body).toEqual({ type: 'group', name: 'Test', memberIds: ['u2'] });
    });

    it('createDm', async () => {
      mockFetch([{ status: 201, body: { conversation: { conversationId: 'c1', type: 'dm' }, members: [] } }]);
      const client = createClient();
      await client.createDm('u2');
      expect(fetchCalls[0]?.body).toEqual({ type: 'dm', memberIds: ['u2'] });
    });

    it('createDmByUsername resolves username first', async () => {
      mockFetch([
        { status: 200, body: { userId: 'u2', username: 'alice' } },
        { status: 201, body: { conversation: { conversationId: 'c1' }, members: [] } },
      ]);
      const client = createClient();
      await client.createDmByUsername('alice');
      expect(fetchCalls[0]?.url).toContain('/users/by-username/alice');
      expect(fetchCalls[1]?.body).toEqual({ type: 'dm', memberIds: ['u2'] });
    });

    it('listConversations', async () => {
      mockFetch([{ status: 200, body: { conversations: [] } }]);
      const client = createClient();
      await client.listConversations();
      expect(fetchCalls[0]?.url).toContain('/conversations');
    });

    it('getConversation', async () => {
      mockFetch([{ status: 200, body: { conversation: {}, members: [] } }]);
      const client = createClient();
      await client.getConversation('c1');
      expect(fetchCalls[0]?.url).toContain('/conversations/c1');
    });

    it('updateConversation', async () => {
      mockFetch([{ status: 200, body: { conversation: {}, members: [] } }]);
      const client = createClient();
      await client.updateConversation('c1', { name: 'Renamed' });
      expect(fetchCalls[0]?.method).toBe('PUT');
    });

    it('updateConversationSettings', async () => {
      mockFetch([{ status: 200, body: { settings: {} } }]);
      const client = createClient();
      await client.updateConversationSettings('c1', { allowMemberInvites: true });
      expect(fetchCalls[0]?.url).toContain('/conversations/c1/settings');
    });

    it('addMembers', async () => {
      mockFetch([{ status: 201, body: { members: [] } }]);
      const client = createClient();
      await client.addMembers('c1', ['u2', 'u3']);
      expect(fetchCalls[0]?.body).toEqual({ memberIds: ['u2', 'u3'] });
    });

    it('removeMember', async () => {
      mockFetch([{ status: 204, body: null }]);
      const client = createClient();
      await client.removeMember('c1', 'u2');
      expect(fetchCalls[0]?.method).toBe('DELETE');
      expect(fetchCalls[0]?.url).toContain('/conversations/c1/members/u2');
    });

    it('updateMemberRole', async () => {
      mockFetch([{ status: 200, body: { member: {} } }]);
      const client = createClient();
      await client.updateMemberRole('c1', 'u2', 'admin');
      expect(fetchCalls[0]?.body).toEqual({ role: 'admin' });
    });

    it('markRead', async () => {
      mockFetch([{ status: 200, body: { readUntil: '2026-01-01T00:00:00Z' } }]);
      const client = createClient();
      await client.markRead('c1', '2026-01-01T00:00:00Z');
      expect(fetchCalls[0]?.url).toContain('/conversations/c1/read');
    });

    it('updateNotifyLevel', async () => {
      mockFetch([{ status: 200, body: { notifyLevel: 'mentions' } }]);
      const client = createClient();
      await client.updateNotifyLevel('c1', 'mentions');
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
      await client.sendMessage('c1', { text: 'Hello' });
      await client.sendMessage('c1', { text: 'World' });
      expect(fetchCalls[0]?.body).toEqual({ content: { text: 'Hello' }, sequenceNumber: 1 });
      expect(fetchCalls[1]?.body).toEqual({ content: { text: 'World' }, sequenceNumber: 2 });
    });

    it('sendMessage tracks sequenceNumber per conversation', async () => {
      mockFetch([
        { status: 201, body: { message: { messageId: 'm1' } } },
        { status: 201, body: { message: { messageId: 'm2' } } },
      ]);
      const client = createClient();
      await client.sendMessage('c1', { text: 'A' });
      await client.sendMessage('c2', { text: 'B' });
      expect(fetchCalls[0]?.body).toEqual({ content: { text: 'A' }, sequenceNumber: 1 });
      expect(fetchCalls[1]?.body).toEqual({ content: { text: 'B' }, sequenceNumber: 1 });
    });

    it('listMessages with pagination', async () => {
      mockFetch([{ status: 200, body: { messages: [] } }]);
      const client = createClient();
      await client.listMessages('c1', { limit: 20, afterMessageId: 'm1' });
      expect(fetchCalls[0]?.url).toContain('limit=20');
      expect(fetchCalls[0]?.url).toContain('afterMessageId=m1');
    });

    it('getMessage', async () => {
      mockFetch([{ status: 200, body: { messageId: 'm1' } }]);
      const client = createClient();
      await client.getMessage('c1', 'm1');
      expect(fetchCalls[0]?.url).toContain('/conversations/c1/messages/m1');
    });

    it('editMessage', async () => {
      mockFetch([{ status: 200, body: { message: {} } }]);
      const client = createClient();
      await client.editMessage('c1', 'm1', { text: 'Edited' });
      expect(fetchCalls[0]?.method).toBe('PUT');
      expect(fetchCalls[0]?.body).toEqual({ content: { text: 'Edited' } });
    });

    it('deleteMessage', async () => {
      mockFetch([{ status: 204, body: null }]);
      const client = createClient();
      await client.deleteMessage('c1', 'm1');
      expect(fetchCalls[0]?.method).toBe('DELETE');
    });
  });

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  describe('media', () => {
    it('getUploadUrl', async () => {
      mockFetch([{ status: 200, body: { uploadUrl: 'https://s3.test', fields: {}, s3Key: 'k1' } }]);
      const client = createClient();
      const result = await client.getUploadUrl('photo.jpg', 'image/jpeg', 'media');
      expect(result.s3Key).toBe('k1');
      expect(fetchCalls[0]?.body).toEqual({ fileName: 'photo.jpg', contentType: 'image/jpeg', artifactType: 'media' });
    });

    it('getDownloadUrl', async () => {
      mockFetch([{ status: 200, body: { url: 'https://cdn.test/file' } }]);
      const client = createClient();
      const result = await client.getDownloadUrl('c1', 'media/c1/photo.jpg');
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
      const client = createClient();
      await client.getMySettings('a1');
      expect(fetchCalls[0]?.url).toContain('/agents/a1/settings');
    });

    it('updateMySettings', async () => {
      mockFetch([{ status: 200, body: { agentId: 'a1', settings: {} } }]);
      const client = createClient();
      await client.updateMySettings('a1', { dmAllowlist: 'anyone_in_contacts' });
      expect(fetchCalls[0]?.method).toBe('PUT');
      expect(fetchCalls[0]?.body).toEqual({ dmAllowlist: 'anyone_in_contacts' });
    });

    it('updateMyProfile', async () => {
      mockFetch([{ status: 200, body: { agentId: 'a1', displayName: 'Bot' } }]);
      const client = createClient();
      await client.updateMyProfile('a1', { displayName: 'Bot' });
      expect(fetchCalls[0]?.url).toContain('/agents/a1/profile');
      expect(fetchCalls[0]?.body).toEqual({ displayName: 'Bot' });
    });
  });
});
