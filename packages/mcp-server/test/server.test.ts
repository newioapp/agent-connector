import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NewioMcpServer } from '../src/server.js';
import type { NewioApp, ContactSummary, ConversationSummary, FriendRequestSummary } from '@newio/sdk';

function mockApp(
  contacts: ContactSummary[] = [{ username: 'alice', displayName: 'Alice', accountType: 'human' }],
  conversations: ConversationSummary[] = [
    { conversationId: 'conv-1', type: 'dm', name: 'Test Conv', lastMessageAt: '2026-01-01T00:00:00Z' },
  ],
): NewioApp {
  return {
    identity: { userId: 'me', username: 'myagent', displayName: 'My Agent' },
    getAllContacts: vi.fn().mockReturnValue(contacts),
    getAllConversations: vi.fn().mockReturnValue(conversations),
    resolveUsername: vi.fn().mockResolvedValue('resolved-id'),
    createGroup: vi.fn().mockResolvedValue('group-conv-id'),
    createWorkSession: vi.fn().mockResolvedValue('ws-conv-id'),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendDm: vi.fn().mockResolvedValue(undefined),
    dmOwner: vi.fn().mockResolvedValue(undefined),
    sendFriendRequestByUsername: vi.fn().mockResolvedValue(undefined),
    listIncomingFriendRequests: vi
      .fn()
      .mockReturnValue([
        { username: 'bob', displayName: 'Bob', accountType: 'human', note: undefined } satisfies FriendRequestSummary,
      ]),
    acceptFriendRequestByUsername: vi.fn().mockResolvedValue(undefined),
    rejectFriendRequestByUsername: vi.fn().mockResolvedValue(undefined),
    removeFriendByUsername: vi.fn().mockResolvedValue(undefined),
    downloadAttachment: vi.fn().mockResolvedValue('/downloads/conv-1/1711929600000-photo.jpg'),
    client: {
      getMe: vi.fn().mockResolvedValue({ userId: 'me', username: 'myagent' }),
      getConversation: vi.fn().mockResolvedValue({ conversationId: 'conv-1', type: 'dm', members: [] }),
      addMembers: vi.fn().mockResolvedValue({}),
      removeMember: vi.fn().mockResolvedValue({}),
      listMessages: vi.fn().mockResolvedValue({
        messages: [
          { messageId: 'msg-1', senderId: 'u1', content: { text: 'hello' }, createdAt: '2026-01-01T00:00:00Z' },
        ],
      }),
      searchUsers: vi.fn().mockResolvedValue({ users: [{ userId: 'u1', username: 'alice' }] }),
      getUserByUsername: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'alice' }),
    },
  } as unknown as NewioApp;
}

async function createConnectedClient(app: NewioApp): Promise<Client> {
  const server = new NewioMcpServer(app);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function createConnectedClientWithSession(app: NewioApp, sessionId: string): Promise<Client> {
  const server = new NewioMcpServer(app);
  server.setSessionId(sessionId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP Server', () => {
  it('lists all tools', async () => {
    const client = await createConnectedClient(mockApp());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'accept_friend_request',
      'add_members',
      'create_group',
      'create_work_session',
      'dm_owner',
      'download_attachment',
      'get_conversation',
      'get_my_profile',
      'get_user_profile',
      'list_conversations',
      'list_friends',
      'list_incoming_friend_requests',
      'list_messages',
      'reject_friend_request',
      'remove_friend',
      'remove_member',
      'search_users',
      'send_dm',
      'send_friend_request',
      'send_message',
    ]);
  });

  it('list_friends returns contacts without userIds', async () => {
    const contacts: ContactSummary[] = [
      { username: 'alice', displayName: 'Alice', accountType: 'human' },
      { username: 'bob', displayName: 'Bob', accountType: 'human' },
    ];
    const client = await createConnectedClient(mockApp(contacts));
    const result = await client.callTool({ name: 'list_friends', arguments: {} });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toHaveProperty('username', 'alice');
    expect(parsed[0]).not.toHaveProperty('userId');
  });

  it('send_friend_request calls app method by username', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'send_friend_request', arguments: { username: 'bob' } });
    expect(app.sendFriendRequestByUsername).toHaveBeenCalledWith('bob', undefined);
  });

  it('accept_friend_request calls app method by username', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'accept_friend_request', arguments: { username: 'bob' } });
    expect(app.acceptFriendRequestByUsername).toHaveBeenCalledWith('bob');
  });

  it('create_work_session creates temp_group with name', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({
      name: 'create_work_session',
      arguments: { name: 'Sprint Planning', usernames: ['alice', 'bob'] },
    });
    expect(app.createWorkSession).toHaveBeenCalledWith('Sprint Planning', ['alice', 'bob'], undefined);
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as { conversationId: string };
    expect(parsed.conversationId).toBe('ws-conv-id');
  });

  it('create_group creates named group', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({
      name: 'create_group',
      arguments: { usernames: ['alice', 'bob'], name: 'Team' },
    });
    expect(app.createGroup).toHaveBeenCalledWith('Team', ['alice', 'bob'], undefined);
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as { conversationId: string };
    expect(parsed.conversationId).toBe('group-conv-id');
  });

  it('send_message supports file attachments', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({
      name: 'send_message',
      arguments: { conversationId: 'conv-1', text: 'check this', filePaths: ['/tmp/photo.jpg'] },
    });
    expect(app.sendMessage).toHaveBeenCalledWith('conv-1', 'check this', ['/tmp/photo.jpg']);
  });

  it('dm_owner sends message to owner', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'dm_owner', arguments: { text: 'hello owner', filePaths: ['/tmp/file.txt'] } });
    expect(app.dmOwner).toHaveBeenCalledWith('hello owner', ['/tmp/file.txt']);
  });

  it('download_attachment returns local file path', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({
      name: 'download_attachment',
      arguments: { conversationId: 'conv-1', s3Key: 'media/photo.jpg', fileName: 'photo.jpg' },
    });
    expect(app.downloadAttachment).toHaveBeenCalledWith('conv-1', 'media/photo.jpg', 'photo.jpg');
    expect((result.content[0] as { text: string }).text).toContain('photo.jpg');
  });

  it('list_messages returns formatted messages', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'list_messages', arguments: { conversationId: 'conv-1' } });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it('search_users returns results', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'search_users', arguments: { query: 'alice' } });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it('create_work_session passes sessionId when set', async () => {
    const app = mockApp();
    const client = await createConnectedClientWithSession(app, 'session-123');
    await client.callTool({
      name: 'create_work_session',
      arguments: { name: 'Sprint', usernames: ['alice'] },
    });
    expect(app.createWorkSession).toHaveBeenCalledWith('Sprint', ['alice'], 'session-123');
  });

  it('create_group passes sessionId when set', async () => {
    const app = mockApp();
    const client = await createConnectedClientWithSession(app, 'session-456');
    await client.callTool({
      name: 'create_group',
      arguments: { name: 'Team', usernames: ['alice'] },
    });
    expect(app.createGroup).toHaveBeenCalledWith('Team', ['alice'], 'session-456');
  });

  it('list_incoming_friend_requests returns summaries', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'list_incoming_friend_requests', arguments: {} });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as FriendRequestSummary[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveProperty('username', 'bob');
    expect(parsed[0]).not.toHaveProperty('userId');
    expect(parsed[0]).not.toHaveProperty('contactId');
  });
});
