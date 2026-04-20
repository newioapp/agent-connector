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
    scheduleCron: vi.fn(),
    cancelCron: vi.fn(),
    listCrons: vi.fn().mockReturnValue([]),
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
  server.setSessionIdGetter(() => sessionId);
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
      'cancel_cron',
      'create_group',
      'create_work_session',
      'dm_owner',
      'download_attachment',
      'get_conversation',
      'get_my_profile',
      'get_user_profile',
      'list_conversations',
      'list_crons',
      'list_friends',
      'list_incoming_friend_requests',
      'list_messages',
      'reject_friend_request',
      'remove_friend',
      'remove_member',
      'schedule_cron',
      'search_users',
      'send_dm',
      'send_friend_request',
      'send_message',
      'upload_attachment_to_current_conversation',
    ]);
  });

  it('list_conversations returns all conversations', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'list_conversations', arguments: {} });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as unknown[];
    expect(parsed).toHaveLength(1);
    expect(app.getAllConversations).toHaveBeenCalled();
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

  it('create_work_session throws when sessionId is not set', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({
      name: 'create_work_session',
      arguments: { name: 'Sprint Planning', usernames: ['alice', 'bob'] },
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('no session ID');
  });

  it('create_group throws when sessionId is not set', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({
      name: 'create_group',
      arguments: { usernames: ['alice', 'bob'], name: 'Team' },
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('no session ID');
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

  it('upload_attachment_to_current_conversation sends attachment-only message', async () => {
    const app = mockApp();
    const server = new NewioMcpServer(app);
    server.setCurrentConversationIdGetter(() => 'conv-1');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    await client.callTool({
      name: 'upload_attachment_to_current_conversation',
      arguments: { filePaths: ['/tmp/photo.jpg'] },
    });
    expect(app.sendMessage).toHaveBeenCalledWith('conv-1', undefined, ['/tmp/photo.jpg']);
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

  it('schedule_cron calls app.scheduleCron with sessionId', async () => {
    const app = mockApp();
    const client = await createConnectedClientWithSession(app, 'session-789');
    const result = await client.callTool({
      name: 'schedule_cron',
      arguments: { expression: 'every 30m', label: 'Check deadlines' },
    });
    expect(app.scheduleCron).toHaveBeenCalledWith(
      expect.objectContaining({
        expression: 'every 30m',
        newioSessionId: 'session-789',
        label: 'Check deadlines',
      }),
    );
    expect((result.content[0] as { text: string }).text).toContain('Cron scheduled');
  });

  it('schedule_cron errors when no session context', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({
      name: 'schedule_cron',
      arguments: { expression: 'every 1h', label: 'Test' },
    });
    expect((result.content[0] as { text: string }).text).toContain('no session context');
    expect(app.scheduleCron).not.toHaveBeenCalled();
  });

  it('cancel_cron calls app.cancelCron', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'cancel_cron', arguments: { cronId: 'cron_abc' } });
    expect(app.cancelCron).toHaveBeenCalledWith('cron_abc');
  });

  it('list_crons returns active cron jobs', async () => {
    const app = mockApp();
    (app.listCrons as ReturnType<typeof vi.fn>).mockReturnValue([
      { cronId: 'cron_1', expression: 'every 1h', newioSessionId: 's1', label: 'Hourly check' },
    ]);
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'list_crons', arguments: {} });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it('reject_friend_request calls app method by username', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'reject_friend_request', arguments: { username: 'bob' } });
    expect(app.rejectFriendRequestByUsername).toHaveBeenCalledWith('bob');
  });

  it('remove_friend calls app method by username', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'remove_friend', arguments: { username: 'alice' } });
    expect(app.removeFriendByUsername).toHaveBeenCalledWith('alice');
  });

  it('get_conversation returns conversation details', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'get_conversation', arguments: { conversationId: 'conv-1' } });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(parsed).toHaveProperty('conversationId', 'conv-1');
    expect(app.client.getConversation).toHaveBeenCalledWith({ conversationId: 'conv-1' });
  });

  it('add_members resolves usernames and adds to conversation', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({
      name: 'add_members',
      arguments: { conversationId: 'conv-1', usernames: ['alice', 'bob'] },
    });
    expect(app.resolveUsername).toHaveBeenCalledTimes(2);
    expect(app.client.addMembers).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      memberIds: ['resolved-id', 'resolved-id'],
    });
  });

  it('remove_member resolves username and removes from conversation', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({
      name: 'remove_member',
      arguments: { conversationId: 'conv-1', username: 'alice' },
    });
    expect(app.resolveUsername).toHaveBeenCalledWith('alice');
    expect(app.client.removeMember).toHaveBeenCalledWith({ conversationId: 'conv-1', userId: 'resolved-id' });
  });

  it('send_dm sends direct message by username', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'send_dm', arguments: { username: 'alice', text: 'hey' } });
    expect(app.sendDm).toHaveBeenCalledWith('alice', 'hey', undefined);
  });

  it('get_my_profile returns agent profile', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'get_my_profile', arguments: {} });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(parsed).toHaveProperty('username', 'myagent');
    expect(app.client.getMe).toHaveBeenCalled();
  });

  it('get_user_profile looks up user by username', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'get_user_profile', arguments: { username: 'alice' } });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(parsed).toHaveProperty('username', 'alice');
    expect(app.client.getUserByUsername).toHaveBeenCalledWith({ username: 'alice' });
  });

  it('list_messages passes pagination params', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({
      name: 'list_messages',
      arguments: { conversationId: 'conv-1', limit: 5, beforeMessageId: 'msg-99' },
    });
    expect(app.client.listMessages).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      limit: 5,
      beforeMessageId: 'msg-99',
    });
  });

  it('list_messages includes attachment metadata', async () => {
    const app = mockApp();
    (app.client.listMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        {
          messageId: 'msg-2',
          senderId: 'u1',
          content: {
            text: 'see attached',
            attachments: [{ fileName: 'doc.pdf', contentType: 'application/pdf', size: 1024, s3Key: 'media/doc.pdf' }],
          },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'list_messages', arguments: { conversationId: 'conv-1' } });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>[];
    expect(parsed[0]).toHaveProperty('attachments');
    const attachments = parsed[0].attachments as Record<string, unknown>[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      fileName: 'doc.pdf',
      contentType: 'application/pdf',
      size: 1024,
      s3Key: 'media/doc.pdf',
    });
  });

  it('create_work_session returns error when no session ID getter is set', async () => {
    const client = await createConnectedClient(mockApp());
    const result = await client.callTool({
      name: 'create_work_session',
      arguments: { name: 'test', usernames: ['bot'] },
    });
    expect(result.isError).toBe(true);
  });

  it('create_work_session succeeds when session ID getter is wired', async () => {
    const app = mockApp();
    const client = await createConnectedClientWithSession(app, 'session-1');
    await client.callTool({ name: 'create_work_session', arguments: { name: 'test', usernames: ['bot'] } });
    expect(app.createWorkSession).toHaveBeenCalled();
  });
});
