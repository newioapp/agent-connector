import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NewioMcpServer } from '../../src/mcp/server.js';
import type { SessionMode } from '../../src/types.js';
import type { NewioApp, ContactSummary, ConversationSummary, FriendRequestSummary } from '@newio/agent-sdk';

/** Extract text from MCP callTool result (handles unknown content type). */
function getResultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ text: string }>;
  return content[0]!.text;
}

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
    getOrCreateDm: vi.fn().mockResolvedValue('dm-conv-id'),
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
    cancelCron: vi.fn().mockReturnValue('success'),
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
      getMemory: vi.fn().mockResolvedValue({
        data: { summary: null, facts: [{ factId: 'f1', text: 'Test fact', createdAt: 't', updatedAt: 't' }] },
      }),
      batchUpdateMemory: vi.fn().mockResolvedValue({ applied: 1 }),
    },
    getGlobalMemory: vi.fn().mockResolvedValue({
      summary: null,
      facts: [{ factId: 'f1', text: 'Global fact', createdAt: 't', updatedAt: 't' }],
    }),
    getContactMemory: vi.fn().mockResolvedValue({
      summary: { text: 'A developer' },
      facts: [{ factId: 'f2', text: 'Likes Python', createdAt: 't', updatedAt: 't' }],
    }),
    getConversationMemory: vi.fn().mockResolvedValue({ summary: null, facts: [] }),
    addMemory: vi.fn().mockResolvedValue(undefined),
    updateMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    updateMemorySummary: vi.fn().mockResolvedValue(undefined),
  } as unknown as NewioApp;
}

async function createConnectedClient(app: NewioApp, sessionMode: SessionMode = 'isolated'): Promise<Client> {
  const initiateConversation = vi.fn();
  const server = new NewioMcpServer({ app, initiateConversation, sessionMode });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP Server', () => {
  it('lists all tools (isolated mode)', async () => {
    const client = await createConnectedClient(mockApp());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'accept_friend_request',
      'add_members',
      'add_memory',
      'cancel_cron',
      'create_dm',
      'create_group',
      'create_work_session',
      'delete_memory',
      'download_attachment',
      'get_conversation',
      'get_memory',
      'get_my_profile',
      'get_user_profile',
      'initiate_conversation',
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
      'send_friend_request',
      'update_memory',
      'update_memory_summary',
      'upload_attachment_to_current_conversation',
    ]);
  });

  it('lists all tools (shared mode)', async () => {
    const client = await createConnectedClient(mockApp(), 'shared');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'accept_friend_request',
      'add_members',
      'add_memory',
      'cancel_cron',
      'create_group',
      'create_work_session',
      'delete_memory',
      'download_attachment',
      'get_conversation',
      'get_memory',
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
      'update_memory',
      'update_memory_summary',
      'upload_attachment_to_current_conversation',
    ]);
  });

  it('list_conversations returns all conversations', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'list_conversations', arguments: {} });
    const parsed = JSON.parse(getResultText(result)) as unknown[];
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
    const parsed = JSON.parse(getResultText(result)) as Record<string, unknown>[];
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

  it('create_work_session calls app.createWorkSession', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({
      name: 'create_work_session',
      arguments: { name: 'Sprint Planning', usernames: ['alice', 'bob'] },
    });
    expect(app.createWorkSession).toHaveBeenCalledWith('Sprint Planning', ['alice', 'bob']);
  });

  it('create_group calls app.createGroup', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({
      name: 'create_group',
      arguments: { usernames: ['alice', 'bob'], name: 'Team' },
    });
    expect(app.createGroup).toHaveBeenCalledWith('Team', ['alice', 'bob']);
  });

  it('initiate_conversation delegates to agent instance', async () => {
    const app = mockApp();
    const initiateConversation = vi.fn();
    const server = new NewioMcpServer({ app, initiateConversation, sessionMode: 'isolated' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    await client.callTool({
      name: 'initiate_conversation',
      arguments: { conversationId: 'conv-1', context: 'Tell them I will be late' },
    });
    expect(initiateConversation).toHaveBeenCalledWith('conv-1', 'Tell them I will be late');
  });

  it('send_message sends to conversation in shared mode', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app, 'shared');
    await client.callTool({
      name: 'send_message',
      arguments: { conversationId: 'conv-1', text: 'check this', filePaths: ['/tmp/photo.jpg'] },
    });
    expect(app.sendMessage).toHaveBeenCalledWith('conv-1', 'check this', ['/tmp/photo.jpg']);
  });

  it('download_attachment returns local file path', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({
      name: 'download_attachment',
      arguments: { conversationId: 'conv-1', s3Key: 'media/photo.jpg', fileName: 'photo.jpg' },
    });
    expect(app.downloadAttachment).toHaveBeenCalledWith('conv-1', 'media/photo.jpg', 'photo.jpg');
    expect(getResultText(result)).toContain('photo.jpg');
  });

  it('upload_attachment_to_current_conversation returns error when no conversation getter is set', async () => {
    const client = await createConnectedClient(mockApp());
    const result = await client.callTool({
      name: 'upload_attachment_to_current_conversation',
      arguments: { filePaths: ['/tmp/photo.jpg'] },
    });
    expect(result.isError).toBe(true);
  });

  it('upload_attachment_to_current_conversation sends attachment-only message', async () => {
    const app = mockApp();
    const initiateConversation = vi.fn();
    const server = new NewioMcpServer({ app, initiateConversation, sessionMode: 'isolated' });
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
    const parsed = JSON.parse(getResultText(result)) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it('search_users returns results', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'search_users', arguments: { query: 'alice' } });
    const parsed = JSON.parse(getResultText(result)) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it('schedule_cron calls app.scheduleCron', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({
      name: 'schedule_cron',
      arguments: { expression: 'every 30m', label: 'Check deadlines' },
    });
    expect(app.scheduleCron).toHaveBeenCalledWith(
      expect.objectContaining({
        expression: 'every 30m',
        label: 'Check deadlines',
      }),
    );
    expect(getResultText(result)).toContain('Cron scheduled');
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
      { cronId: 'cron_1', expression: 'every 1h', label: 'Hourly check' },
    ]);
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'list_crons', arguments: {} });
    const parsed = JSON.parse(getResultText(result)) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it('list_incoming_friend_requests returns summaries', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'list_incoming_friend_requests', arguments: {} });
    const parsed = JSON.parse(getResultText(result)) as FriendRequestSummary[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveProperty('username', 'bob');
    expect(parsed[0]).not.toHaveProperty('userId');
    expect(parsed[0]).not.toHaveProperty('contactId');
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
    const parsed = JSON.parse(getResultText(result)) as Record<string, unknown>;
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
    const client = await createConnectedClient(app, 'shared');
    await client.callTool({ name: 'send_dm', arguments: { username: 'alice', text: 'hey' } });
    expect(app.sendDm).toHaveBeenCalledWith('alice', 'hey', undefined);
  });

  it('get_my_profile returns agent profile', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'get_my_profile', arguments: {} });
    const parsed = JSON.parse(getResultText(result)) as Record<string, unknown>;
    expect(parsed).toHaveProperty('username', 'myagent');
    expect(app.client.getMe).toHaveBeenCalled();
  });

  it('get_user_profile looks up user by username', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'get_user_profile', arguments: { username: 'alice' } });
    const parsed = JSON.parse(getResultText(result)) as Record<string, unknown>;
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
    const parsed = JSON.parse(getResultText(result)) as Record<string, unknown>[];
    expect(parsed[0]).toHaveProperty('attachments');
    const attachments = parsed[0]!.attachments as Record<string, unknown>[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      fileName: 'doc.pdf',
      contentType: 'application/pdf',
      size: 1024,
      s3Key: 'media/doc.pdf',
    });
  });

  // ── Memory tools ──

  it('get_memory with username calls app.getContactMemory', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'get_memory', arguments: { username: 'alice' } });
    expect(app.getContactMemory).toHaveBeenCalledWith('alice');
    const content = getResultText(result);
    expect(content).toContain('Likes Python');
  });

  it('get_memory with no args returns error', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'get_memory', arguments: {} });
    const content = getResultText(result);
    expect(content).toContain('Provide either a username or conversationId');
    expect(result.isError).toBe(true);
  });

  it('get_memory with conversationId calls app.getConversationMemory', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'get_memory', arguments: { conversationId: 'conv-1' } });
    expect(app.getConversationMemory).toHaveBeenCalledWith('conv-1');
  });

  it('add_memory calls app.addMemory with username', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'add_memory', arguments: { text: 'User likes Python.', username: 'alice' } });
    expect(app.addMemory).toHaveBeenCalledWith('User likes Python.', { username: 'alice', conversationId: undefined });
  });

  it('add_memory with own username throws error', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({
      name: 'add_memory',
      arguments: { text: 'I am smart.', username: 'myagent' },
    });
    expect(result.isError).toBe(true);
    const content = getResultText(result);
    expect(content).toContain('omit the username');
  });

  it('update_memory calls app.updateMemory', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({
      name: 'update_memory',
      arguments: { factId: 'f1', text: 'Updated.', conversationId: 'conv-1' },
    });
    expect(app.updateMemory).toHaveBeenCalledWith('f1', 'Updated.', { username: undefined, conversationId: 'conv-1' });
  });

  it('delete_memory calls app.deleteMemory', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'delete_memory', arguments: { factId: 'f1' } });
    expect(app.deleteMemory).toHaveBeenCalledWith('f1', { username: undefined, conversationId: undefined });
  });

  it('update_memory_summary calls app.updateMemorySummary', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'update_memory_summary', arguments: { text: 'A developer.', username: 'alice' } });
    expect(app.updateMemorySummary).toHaveBeenCalledWith('A developer.', {
      username: 'alice',
      conversationId: undefined,
    });
  });
});

describe('onToolCall hook', () => {
  async function createClientWithHook(
    app: NewioApp,
    onToolCall: (toolName: string, args: Readonly<Record<string, unknown>>) => void,
  ): Promise<Client> {
    const initiateConversation = vi.fn();
    const server = new NewioMcpServer({ app, initiateConversation, sessionMode: 'shared', onToolCall });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  it('fires hook with tool name and args for send_dm', async () => {
    const app = mockApp();
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const client = await createClientWithHook(app, (tool, args) => {
      calls.push({ tool, args: { ...args } });
    });

    await client.callTool({ name: 'send_dm', arguments: { username: 'alice', text: 'hello' } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('send_dm');
    expect(calls[0]!.args).toEqual({ username: 'alice', text: 'hello', filePaths: undefined });
  });

  it('fires hook for list_friends (no args)', async () => {
    const app = mockApp();
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const client = await createClientWithHook(app, (tool, args) => {
      calls.push({ tool, args: { ...args } });
    });

    await client.callTool({ name: 'list_friends', arguments: {} });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('list_friends');
    expect(calls[0]!.args).toEqual({});
  });

  it('fires hook for memory tools', async () => {
    const app = mockApp();
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const client = await createClientWithHook(app, (tool, args) => {
      calls.push({ tool, args: { ...args } });
    });

    await client.callTool({ name: 'add_memory', arguments: { text: 'Alice likes cats', username: 'alice' } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('add_memory');
    expect(calls[0]!.args.text).toBe('Alice likes cats');
    expect(calls[0]!.args.username).toBe('alice');
  });

  it('captures multiple tool calls in order', async () => {
    const app = mockApp();
    const calls: Array<{ tool: string }> = [];
    const client = await createClientWithHook(app, (tool) => {
      calls.push({ tool });
    });

    await client.callTool({ name: 'list_friends', arguments: {} });
    await client.callTool({ name: 'list_conversations', arguments: {} });
    await client.callTool({ name: 'send_dm', arguments: { username: 'marcus42', text: 'hi' } });

    expect(calls.map((c) => c.tool)).toEqual(['list_friends', 'list_conversations', 'send_dm']);
  });
});
