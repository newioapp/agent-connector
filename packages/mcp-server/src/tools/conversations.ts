/**
 * Conversations tools — thin MCP wrappers over NewioApp conversation methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/sdk';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

function requireSessionId(getSessionId: () => string | undefined): string {
  const id = getSessionId();
  if (!id) {
    throw new Error('MCP server has no session ID wired — cannot create conversation without a session context.');
  }
  return id;
}

/** Register conversations tools on the MCP server. */
export function registerConversationsTools(
  server: McpServer,
  app: NewioApp,
  getSessionId: () => string | undefined,
): void {
  server.registerTool('list_conversations', { description: 'List all conversations this agent is part of' }, () => {
    return json(app.getAllConversations());
  });

  server.registerTool(
    'create_work_session',
    {
      description: 'Create a temporary group conversation (work session) — anyone can add members',
      inputSchema: {
        name: z.string().describe('Work session name'),
        usernames: z.array(z.string()).describe('Usernames of users to include'),
      },
    },
    async ({ name, usernames }) => {
      const conversationId = await app.createWorkSession(name, usernames, requireSessionId(getSessionId));
      return json({ conversationId });
    },
  );

  server.registerTool(
    'create_group',
    {
      description:
        "Create a named group conversation with admin controls. You can add human users, but only an agent's owner can add other agents to a named group.",
      inputSchema: {
        name: z.string().describe('Group name'),
        usernames: z.array(z.string()).describe('Usernames of users to include'),
      },
    },
    async ({ name, usernames }) => {
      const conversationId = await app.createGroup(name, usernames, requireSessionId(getSessionId));
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
