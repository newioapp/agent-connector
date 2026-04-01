/**
 * Conversations tools — thin MCP wrappers over NewioApp conversation methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/sdk';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/** Register conversations tools on the MCP server. */
export function registerConversationsTools(server: McpServer, app: NewioApp): void {
  server.registerTool('list_conversations', { description: 'List all conversations this agent is part of' }, () => {
    return json(app.getAllConversations());
  });

  server.registerTool(
    'create_dm',
    {
      description: 'Create or find an existing direct message conversation with a user',
      inputSchema: { username: z.string().describe('Username of the user to DM') },
    },
    async ({ username }) => {
      const userId = await app.resolveUsername(username);
      const conversationId = await app.findOrCreateDm(userId);
      return json({ conversationId });
    },
  );

  server.registerTool(
    'create_work_session',
    {
      description: 'Create a temporary group conversation (work session) — no name, anyone can add members',
      inputSchema: { usernames: z.array(z.string()).describe('Usernames of users to include') },
    },
    async ({ usernames }) => {
      const conversationId = await app.createWorkSession(usernames);
      return json({ conversationId });
    },
  );

  server.registerTool(
    'create_group',
    {
      description: 'Create a named group conversation with admin controls',
      inputSchema: {
        name: z.string().describe('Group name'),
        usernames: z.array(z.string()).describe('Usernames of users to include'),
      },
    },
    async ({ name, usernames }) => {
      const conversationId = await app.createGroup(name, usernames);
      return json({ conversationId });
    },
  );

  server.registerTool(
    'get_conversation',
    {
      description: 'Get details and members of a conversation',
      inputSchema: { conversationId: z.string().describe('Conversation ID') },
    },
    async ({ conversationId }) => {
      const conv = await app.client.getConversation({ conversationId });
      return json(conv);
    },
  );

  server.registerTool(
    'add_members',
    {
      description: 'Add members to a group conversation by usernames',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID'),
        usernames: z.array(z.string()).describe('Usernames of users to add'),
      },
    },
    async ({ conversationId, usernames }) => {
      const memberIds = await Promise.all(usernames.map((u) => app.resolveUsername(u)));
      await app.client.addMembers({ conversationId, memberIds });
      return text(`Added ${usernames.join(', ')} to conversation`);
    },
  );

  server.registerTool(
    'remove_member',
    {
      description: 'Remove a member from a group conversation by username',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID'),
        username: z.string().describe('Username of the member to remove'),
      },
    },
    async ({ conversationId, username }) => {
      const userId = await app.resolveUsername(username);
      await app.client.removeMember({ conversationId, userId });
      return text(`Removed @${username} from conversation`);
    },
  );
}
