import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server.js';
import type { NewioApp } from '@newio/sdk';
import type { ContactRecord, ConversationListItem } from '@newio/sdk';

function makeContact(overrides: Partial<ContactRecord> = {}): ContactRecord {
  return {
    userId: 'me',
    contactId: overrides.contactId ?? 'contact-1',
    status: 'accepted',
    requesterId: 'me',
    friendAccountType: 'human',
    friendUsername: 'alice',
    friendDisplayName: 'Alice',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    conversationId: overrides.conversationId ?? 'conv-1',
    type: 'dm',
    name: 'Test Conv',
    lastMessageAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockApp(
  contacts: ContactRecord[] = [makeContact()],
  conversations: ConversationListItem[] = [makeConversation()],
): NewioApp {
  return {
    identity: { userId: 'me', username: 'myagent', displayName: 'My Agent' },
    getAllContacts: vi.fn().mockReturnValue(contacts),
    getAllConversations: vi.fn().mockReturnValue(conversations),
    resolveUsername: vi.fn().mockResolvedValue('resolved-id'),
    findOrCreateDm: vi.fn().mockResolvedValue('dm-conv-id'),
    createGroup: vi.fn().mockResolvedValue('group-conv-id'),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendDm: vi.fn().mockResolvedValue(undefined),
    client: {
      getMe: vi.fn().mockResolvedValue({ userId: 'me', username: 'myagent' }),
      sendFriendRequest: vi.fn().mockResolvedValue({}),
      listIncomingRequests: vi.fn().mockResolvedValue({ requests: [] }),
      acceptFriendRequest: vi.fn().mockResolvedValue({}),
      rejectFriendRequest: vi.fn().mockResolvedValue({}),
      removeFriend: vi.fn().mockResolvedValue({}),
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
      getDownloadUrl: vi.fn().mockResolvedValue({ url: 'https://example.com/file' }),
    },
  } as unknown as NewioApp;
}

async function createConnectedClient(app: NewioApp): Promise<Client> {
  const server = createMcpServer(app);
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
      'create_dm',
      'create_group',
      'get_conversation',
      'get_download_url',
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

  it('list_friends returns contacts', async () => {
    const contacts = [
      makeContact({ contactId: 'u1', friendUsername: 'alice', friendDisplayName: 'Alice' }),
      makeContact({ contactId: 'u2', friendUsername: 'bob', friendDisplayName: 'Bob' }),
    ];
    const client = await createConnectedClient(mockApp(contacts));
    const result = await client.callTool({ name: 'list_friends', arguments: {} });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it('send_dm calls app.sendDm', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'send_dm', arguments: { username: 'alice', text: 'hello' } });
    expect(app.sendDm).toHaveBeenCalledWith('alice', 'hello');
  });

  it('send_friend_request resolves username then sends', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    await client.callTool({ name: 'send_friend_request', arguments: { username: 'bob' } });
    expect(app.resolveUsername).toHaveBeenCalledWith('bob');
    expect(app.client.sendFriendRequest).toHaveBeenCalledWith({ contactId: 'resolved-id' });
  });

  it('create_group returns conversation ID', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({
      name: 'create_group',
      arguments: { name: 'Team', usernames: ['alice', 'bob'] },
    });
    expect(app.createGroup).toHaveBeenCalledWith('Team', ['alice', 'bob']);
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as { conversationId: string };
    expect(parsed.conversationId).toBe('group-conv-id');
  });

  it('list_messages returns formatted messages', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'list_messages', arguments: { conversationId: 'conv-1' } });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as unknown[];
    expect(parsed).toHaveLength(1);
    expect(app.client.listMessages).toHaveBeenCalledWith({ conversationId: 'conv-1', limit: 20 });
  });

  it('get_download_url returns signed URL', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({
      name: 'get_download_url',
      arguments: { conversationId: 'conv-1', s3Key: 'media/file.jpg' },
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as { url: string };
    expect(parsed.url).toBe('https://example.com/file');
  });

  it('search_users returns results', async () => {
    const app = mockApp();
    const client = await createConnectedClient(app);
    const result = await client.callTool({ name: 'search_users', arguments: { query: 'alice' } });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as unknown[];
    expect(parsed).toHaveLength(1);
  });
});
