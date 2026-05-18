/**
 * Conversations tools — thin MCP wrappers over NewioApp conversation methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import type { ToolCallHook } from '../types.js';
import type { ToolDescriptions } from '../tool-descriptions.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/** Register conversations tools on the MCP server. */
export function registerConversationsTools(
  server: McpServer,
  app: NewioApp,
  desc: ToolDescriptions,
  onToolCall?: ToolCallHook,
): void {
  const listConv = desc.listConversations();
  server.registerTool('list_conversations', { description: listConv.description }, () => {
    onToolCall?.('list_conversations', {});
    return json(app.getAllConversations());
  });

  const createDm = desc.createDm();
  server.registerTool(
    'create_dm',
    {
      description: createDm.description,
      inputSchema: { username: z.string().describe(createDm.params.username) },
    },
    async ({ username }) => {
      onToolCall?.('create_dm', { username });
      const conversationId = await app.getOrCreateDm(username);
      return json({ conversationId });
    },
  );

  const createWs = desc.createWorkSession();
  server.registerTool(
    'create_work_session',
    {
      description: createWs.description,
      inputSchema: {
        name: z.string().describe(createWs.params.name),
        usernames: z.array(z.string()).describe(createWs.params.usernames),
      },
    },
    async ({ name, usernames }) => {
      onToolCall?.('create_work_session', { name, usernames });
      const conversationId = await app.createWorkSession(name, usernames);
      return json({ conversationId });
    },
  );

  const createGrp = desc.createGroup();
  server.registerTool(
    'create_group',
    {
      description: createGrp.description,
      inputSchema: {
        name: z.string().describe(createGrp.params.name),
        usernames: z.array(z.string()).describe(createGrp.params.usernames),
      },
    },
    async ({ name, usernames }) => {
      onToolCall?.('create_group', { name, usernames });
      const conversationId = await app.createGroup(name, usernames);
      return json({ conversationId });
    },
  );

  const getConv = desc.getConversation();
  server.registerTool(
    'get_conversation',
    {
      description: getConv.description,
      inputSchema: { conversationId: z.string().describe(getConv.params.conversationId) },
    },
    async ({ conversationId }) => {
      onToolCall?.('get_conversation', { conversationId });
      const conv = await app.client.getConversation({ conversationId });
      return json(conv);
    },
  );

  const addMem = desc.addMembers();
  server.registerTool(
    'add_members',
    {
      description: addMem.description,
      inputSchema: {
        conversationId: z.string().describe(addMem.params.conversationId),
        usernames: z.array(z.string()).describe(addMem.params.usernames),
      },
    },
    async ({ conversationId, usernames }) => {
      onToolCall?.('add_members', { conversationId, usernames });
      const memberIds = await Promise.all(usernames.map((u) => app.resolveUsername(u)));
      await app.client.addMembers({ conversationId, memberIds });
      return text(`Added ${usernames.join(', ')} to conversation`);
    },
  );

  const rmMem = desc.removeMember();
  server.registerTool(
    'remove_member',
    {
      description: rmMem.description,
      inputSchema: {
        conversationId: z.string().describe(rmMem.params.conversationId),
        username: z.string().describe(rmMem.params.username),
      },
    },
    async ({ conversationId, username }) => {
      onToolCall?.('remove_member', { conversationId, username });
      const userId = await app.resolveUsername(username);
      await app.client.removeMember({ conversationId, userId });
      return text(`Removed @${username} from conversation`);
    },
  );
}
