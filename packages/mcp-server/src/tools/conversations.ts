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
    return json(
      app.getAllConversations().map((c) => ({
        conversationId: c.conversationId,
        type: c.type,
        name: c.name,
        lastMessageAt: c.lastMessageAt,
      })),
    );
  });

  server.registerTool(
    'create_conversation',
    {
      description:
        'Create a conversation. For DM: provide one username. For group: provide multiple usernames and a name.',
      inputSchema: {
        usernames: z.array(z.string()).describe('Usernames of users to include'),
        name: z.string().optional().describe('Group name (required for groups, omit for DMs)'),
      },
    },
    async ({ usernames, name }) => {
      let conversationId: string;
      if (usernames.length === 1 && !name) {
        const userId = await app.resolveUsername(usernames[0] ?? '');
        conversationId = await app.findOrCreateDm(userId);
      } else {
        if (!name) {
          return text('Group conversations require a name');
        }
        conversationId = await app.createGroup(name, usernames);
      }
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
