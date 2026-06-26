import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NewioMcpServer, type MessagingProfile } from '../../src/mcp/server.js';
import { WRITE_SETTLE_DELAY_MS } from '../../src/mcp/tools/conversations.js';
import type { NewioApp, ContactSummary, ConversationSummary, FriendRequestSummary } from '../../src/app/index.js';

/** Representative per-session profiles (see resolveMessagingProfile in agent-instance-impl). */
const ISOLATED_PROFILE: MessagingProfile = { sendMessage: 'current', shareContext: 'explicit' };
const SHARED_PROFILE: MessagingProfile = { sendMessage: 'explicit', shareContext: 'none' };
const CHAT_HUB_PROFILE: MessagingProfile = { sendMessage: 'explicit-guarded', shareContext: 'explicit' };
const CHAT_SPOKE_PROFILE: MessagingProfile = { sendMessage: 'current', shareContext: 'to-hub' };

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
    listConversations: vi.fn().mockReturnValue({ conversations, hasMore: false }),
    createGroup: vi.fn().mockResolvedValue('group-conv-id'),
    createWorkSession: vi.fn().mockResolvedValue('ws-conv-id'),
    getOrCreateDm: vi.fn().mockResolvedValue('dm-conv-id'),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendMessageToManagedConversation: vi.fn().mockResolvedValue(undefined),
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
    getMe: vi.fn().mockResolvedValue({ userId: 'me', username: 'myagent' }),
    getConversationInfo: vi.fn().mockResolvedValue({ conversationId: 'conv-1', type: 'dm', admins: [] }),
    checkIsMember: vi.fn().mockResolvedValue(false),
    listConversationMembers: vi.fn().mockResolvedValue({ members: [], hasMore: false }),
    addMembersByUsername: vi.fn().mockResolvedValue(undefined),
    removeMemberByUsername: vi.fn().mockResolvedValue(undefined),
    listMessages: vi.fn().mockResolvedValue({
      messages: [{ messageId: 'msg-1', senderId: 'u1', content: { text: 'hello' }, createdAt: '2026-01-01T00:00:00Z' }],
    }),
    searchUsers: vi.fn().mockResolvedValue({ users: [{ userId: 'u1', username: 'alice' }] }),
    getUserByUsername: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'alice' }),
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

async function createConnectedClient(
  app: NewioApp,
  profile: MessagingProfile = ISOLATED_PROFILE,
  memoryEnabled = true,
  hubConversationId?: string,
  ownConversationId?: string,
): Promise<Client> {
  const shareContext = vi.fn();
  const server = new NewioMcpServer({
    app,
    shareContext,
    profile,
    ownConversationId,
    hubConversationId,
    memoryEnabled,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP Server', () => {
  it('lists all tools (isolated conversation profile: current send_message + share_context)', async () => {
    const client = await createConnectedClient(mockApp());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'accept_friend_request',
      'add_members',
      'add_memory',
      'cancel_cron',
      'check_is_member',
      'create_dm',
      'create_group',
      'create_work_session',
      'delete_memory',
      'download_attachment',
      'get_conversation',
      'get_memory',
      'get_my_profile',
      'get_user_profile',
      'list_contacts',
      'list_conversation_members',
      'list_conversations',
      'list_crons',
      'list_incoming_friend_requests',
      'list_messages',
      'reject_friend_request',
      'remove_friend',
      'remove_member',
      'schedule_cron',
      'search_users',
      'send_friend_request',
      'send_message',
      'share_context',
      'update_memory',
      'update_memory_summary',
      'upload_attachment_to_current_conversation',
    ]);
    // Deprecated tools are gone.
    expect(names).not.toContain('initiate_conversation');
    expect(names).not.toContain('send_dm');
  });

  it('omits the memory tools when memory is opted out', async () => {
    const client = await createConnectedClient(mockApp(), ISOLATED_PROFILE, false);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const memoryTool of ['get_memory', 'add_memory', 'update_memory', 'delete_memory', 'update_memory_summary']) {
      expect(names).not.toContain(memoryTool);
    }
    // Non-memory tools remain available.
    expect(names).toContain('send_friend_request');
    expect(names).toContain('list_conversations');
  });

  it('lists all tools (shared profile: explicit send_message, no share_context)', async () => {
    const client = await createConnectedClient(mockApp(), SHARED_PROFILE);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'accept_friend_request',
      'add_members',
      'add_memory',
      'cancel_cron',
      'check_is_member',
      'create_dm',
      'create_group',
      'create_work_session',
      'delete_memory',
      'download_attachment',
      'get_conversation',
      'get_memory',
      'get_my_profile',
      'get_user_profile',
      'list_contacts',
      'list_conversation_members',
      'list_conversations',
      'list_crons',
      'list_incoming_friend_requests',
      'list_messages',
      'reject_friend_request',
      'remove_friend',
      'remove_member',
      'schedule_cron',
      'search_users',
      'send_friend_request',
      'send_message',
      'update_memory',
      'update_memory_summary',
      'upload_attachment_to_current_conversation',
    ]);
    // Shared owns every conversation, so no cross-session hand-off; send_dm is gone.
    expect(names).not.toContain('share_context');
    expect(names).not.toContain('send_dm');
  });

  it('chat hub profile exposes explicit send_message + share_context + create_dm', async () => {
    const client = await createConnectedClient(mockApp(), CHAT_HUB_PROFILE);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('share_context');
    expect(names).toContain('send_message');
    expect(names).toContain('create_dm');
    expect(names).toContain('create_work_session');
    expect(names).not.toContain('send_dm');
    expect(names).not.toContain('initiate_conversation');
  });

  it('share_context delegates to the agent instance via the shareContext callback', async () => {
    const app = mockApp();
    const shareContext = vi.fn();
    const server = new NewioMcpServer({
      app,
      shareContext,
      profile: CHAT_HUB_PROFILE,
      memoryEnabled: true,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);

    await client.callTool({
      name: 'share_context',
      arguments: { conversationId: 'work-1', context: 'kick off the migration' },
    });
    expect(shareContext).toHaveBeenCalledWith('work-1', 'kick off the migration');
  });

  it('spoke share_context (to-hub) hands context to the hub conversation, no conversationId arg', async () => {
    const app = mockApp();
    const shareContext = vi.fn();
    const server = new NewioMcpServer({
      app,
      shareContext,
      profile: CHAT_SPOKE_PROFILE,
      hubConversationId: 'owner-dm',
      memoryEnabled: true,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const shareTool = tools.find((t) => t.name === 'share_context')!;
    expect(Object.keys(shareTool.inputSchema.properties ?? {})).toEqual(['context']);

    await client.callTool({ name: 'share_context', arguments: { context: 'progress: migration done' } });
    expect(shareContext).toHaveBeenCalledWith('owner-dm', 'progress: migration done');
  });

  it('list_conversations returns all conversations', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'list_conversations', arguments: {} });
    const parsed = JSON.parse(getResultText(result)) as { conversations: unknown[]; hasMore: boolean };
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.hasMore).toBe(false);
    expect(app.listConversations).toHaveBeenCalled();
  });

  it('list_contacts returns contacts without userIds', async () => {
    const contacts: ContactSummary[] = [
      { username: 'alice', displayName: 'Alice', accountType: 'human' },
      { username: 'bob', displayName: 'Bob', accountType: 'human' },
    ];
    const client = await createConnectedClient(mockApp(contacts));
    const result = await client.callTool({ name: 'list_contacts', arguments: {} });
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

  it('send_message (current profile) targets the responsible conversation, no conversationId arg', async () => {
    const app = mockApp();
    const shareContext = vi.fn();
    // No currentConversationId getter set (as on a share_context turn) — it must use ownConversationId.
    const server = new NewioMcpServer({
      app,
      shareContext,
      profile: CHAT_SPOKE_PROFILE,
      ownConversationId: 'work-1',
      memoryEnabled: true,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const sendTool = tools.find((t) => t.name === 'send_message')!;
    expect(Object.keys(sendTool.inputSchema.properties ?? {}).sort()).toEqual(['filePaths', 'text']);

    await client.callTool({ name: 'send_message', arguments: { text: 'on it' } });
    expect(app.sendMessage).toHaveBeenCalledWith('work-1', 'on it', undefined);
  });

  it('send_message (explicit profile) sends to the given conversation', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app, SHARED_PROFILE);
    await client.callTool({
      name: 'send_message',
      arguments: { conversationId: 'conv-1', text: 'check this', filePaths: ['/tmp/photo.jpg'] },
    });
    expect(app.sendMessage).toHaveBeenCalledWith('conv-1', 'check this', { filePaths: ['/tmp/photo.jpg'] });
  });

  it('send_message (guarded profile) routes through the app guard and surfaces its error', async () => {
    const app = mockApp();
    // The work-session validation lives in the app; the tool stays thin and surfaces the app error.
    (app.sendMessageToManagedConversation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('That is a work session — use share_context to hand it the message instead.'),
    );
    const client = await createConnectedClient(app, CHAT_HUB_PROFILE);
    const result = await client.callTool({
      name: 'send_message',
      arguments: { conversationId: 'work-1', text: 'hi' },
    });
    expect(app.sendMessageToManagedConversation).toHaveBeenCalledWith('work-1', 'hi', undefined);
    expect(result.isError).toBe(true);
    expect(getResultText(result)).toContain('share_context');
    expect(app.sendMessage).not.toHaveBeenCalled();
  });

  it('send_message (guarded profile) sends via the app guard for a normal conversation', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app, CHAT_HUB_PROFILE);
    await client.callTool({ name: 'send_message', arguments: { conversationId: 'conv-1', text: 'hi' } });
    expect(app.sendMessageToManagedConversation).toHaveBeenCalledWith('conv-1', 'hi', undefined);
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
    const server = new NewioMcpServer({
      app,
      shareContext: vi.fn(),
      profile: ISOLATED_PROFILE,
      memoryEnabled: true,
    });
    server.setCurrentConversationIdGetter(() => 'conv-1');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    await client.callTool({
      name: 'upload_attachment_to_current_conversation',
      arguments: { filePaths: ['/tmp/photo.jpg'] },
    });
    expect(app.sendMessage).toHaveBeenCalledWith('conv-1', undefined, { filePaths: ['/tmp/photo.jpg'] });
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
    expect(app.getConversationInfo).toHaveBeenCalledWith('conv-1');
  });

  it('add_members resolves usernames and adds to conversation', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({
      name: 'add_members',
      arguments: { conversationId: 'conv-1', usernames: ['alice', 'bob'] },
    });
    expect(app.addMembersByUsername).toHaveBeenCalledWith('conv-1', ['alice', 'bob']);
  });

  it('remove_member resolves username and removes from conversation', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({
      name: 'remove_member',
      arguments: { conversationId: 'conv-1', username: 'alice' },
    });
    expect(app.removeMemberByUsername).toHaveBeenCalledWith('conv-1', 'alice');
  });

  it('create_dm resolves a username to a conversationId', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app, SHARED_PROFILE);
    const result = await client.callTool({ name: 'create_dm', arguments: { username: 'alice' } });
    expect(app.getOrCreateDm).toHaveBeenCalledWith('alice');
    expect(JSON.parse(getResultText(result))).toHaveProperty('conversationId', 'dm-conv-id');
  });

  it('get_my_profile returns agent profile', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'get_my_profile', arguments: {} });
    const parsed = JSON.parse(getResultText(result)) as Record<string, unknown>;
    expect(parsed).toHaveProperty('username', 'myagent');
    expect(app.getMe).toHaveBeenCalled();
  });

  it('get_user_profile looks up user by username', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'get_user_profile', arguments: { username: 'alice' } });
    const parsed = JSON.parse(getResultText(result)) as Record<string, unknown>;
    expect(parsed).toHaveProperty('username', 'alice');
    expect(app.getUserByUsername).toHaveBeenCalledWith('alice');
  });

  it('list_messages passes pagination params', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({
      name: 'list_messages',
      arguments: { conversationId: 'conv-1', limit: 5, beforeMessageId: 'msg-99' },
    });
    expect(app.listMessages).toHaveBeenCalledWith('conv-1', 5, 'msg-99');
  });

  it('list_messages includes attachment metadata', async () => {
    const app = mockApp();
    (app.listMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
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

describe('write settle delay (issue #269)', () => {
  // After a successful conversation/member write the tool settles for WRITE_SETTLE_DELAY_MS so the
  // backend can finalize member subscriptions before a subsequent send_message — otherwise a
  // freshly added agent can miss the message in its initial context.

  /**
   * Drive a mutation tool under fake timers: assert the write ran but the tool hasn't returned
   * before the delay, then that it returns once the delay elapses.
   */
  async function expectSettles(
    toolName: string,
    args: Record<string, unknown>,
    profile: MessagingProfile = ISOLATED_PROFILE,
  ): Promise<void> {
    vi.useFakeTimers();
    try {
      const app = mockApp();
      const client = await createConnectedClient(app, profile);
      let settled = false;
      const call = client.callTool({ name: toolName, arguments: args }).finally(() => {
        settled = true;
      });

      // The mock write resolves immediately; only the settle timer keeps the tool pending.
      await vi.advanceTimersByTimeAsync(WRITE_SETTLE_DELAY_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await call;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }

  it('uses a hard-coded 3-second delay', () => {
    expect(WRITE_SETTLE_DELAY_MS).toBe(3000);
  });

  it('create_dm settles after the write', async () => {
    await expectSettles('create_dm', { username: 'alice' }, SHARED_PROFILE);
  });

  it('create_work_session settles after the write', async () => {
    await expectSettles('create_work_session', { name: 'Sprint', usernames: ['alice'] });
  });

  it('create_group settles after the write', async () => {
    await expectSettles('create_group', { name: 'Team', usernames: ['alice'] });
  });

  it('add_members settles after the write', async () => {
    await expectSettles('add_members', { conversationId: 'conv-1', usernames: ['alice'] });
  });

  it('remove_member settles after the write', async () => {
    await expectSettles('remove_member', { conversationId: 'conv-1', username: 'alice' });
  });

  it('does not settle when the write fails (error path returns without the delay)', async () => {
    vi.useFakeTimers();
    try {
      const app = mockApp();
      (app.addMembersByUsername as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
      const client = await createConnectedClient(app);
      // No timer advance: a failed write must surface immediately, with no settle delay.
      const result = await client.callTool({
        name: 'add_members',
        arguments: { conversationId: 'conv-1', usernames: ['alice'] },
      });
      expect(result.isError).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not delay send_message (hot path)', async () => {
    vi.useFakeTimers();
    try {
      const app = mockApp();
      const client = await createConnectedClient(app, SHARED_PROFILE);
      // No timer advance: send_message must return without any settle delay.
      await client.callTool({ name: 'send_message', arguments: { conversationId: 'conv-1', text: 'hi' } });
      expect(app.sendMessage).toHaveBeenCalledWith('conv-1', 'hi', undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('onToolCall hook', () => {
  async function createClientWithHook(
    app: NewioApp,
    onToolCall: (toolName: string, args: Readonly<Record<string, unknown>>) => void,
  ): Promise<Client> {
    const server = new NewioMcpServer({
      app,
      shareContext: vi.fn(),
      profile: SHARED_PROFILE,
      memoryEnabled: true,
      onToolCall,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  it('fires hook with tool name and args for send_message', async () => {
    const app = mockApp();
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const client = await createClientWithHook(app, (tool, args) => {
      calls.push({ tool, args: { ...args } });
    });

    await client.callTool({ name: 'send_message', arguments: { conversationId: 'conv-1', text: 'hello' } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('send_message');
    expect(calls[0]!.args).toEqual({ conversationId: 'conv-1', text: 'hello', filePaths: undefined });
  });

  it('fires hook for list_contacts (no args)', async () => {
    const app = mockApp();
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const client = await createClientWithHook(app, (tool, args) => {
      calls.push({ tool, args: { ...args } });
    });

    await client.callTool({ name: 'list_contacts', arguments: {} });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('list_contacts');
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

    await client.callTool({ name: 'list_contacts', arguments: {} });
    await client.callTool({ name: 'list_conversations', arguments: {} });
    await client.callTool({ name: 'send_message', arguments: { conversationId: 'conv-1', text: 'hi' } });

    expect(calls.map((c) => c.tool)).toEqual(['list_contacts', 'list_conversations', 'send_message']);
  });
});
