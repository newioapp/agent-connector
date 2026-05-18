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

export function registerConversationsTools(
  server: McpServer,
  app: NewioApp,
  desc: ToolDescriptions,
  onToolCall?: ToolCallHook,
): void {
  const lc = desc.listConversations();
  server.registerTool(lc.toolName, { description: lc.description }, () => {
    onToolCall?.(lc.toolName, {});
    return json(app.getAllConversations());
  });

  const cd = desc.createDm();
  server.registerTool(
    cd.toolName,
    { description: cd.description, inputSchema: { username: z.string().describe(cd.params.username) } },
    async ({ username }) => {
      onToolCall?.(cd.toolName, { username });
      const conversationId = await app.getOrCreateDm(username);
      return json({ conversationId });
    },
  );

  const cws = desc.createWorkSession();
  server.registerTool(
    cws.toolName,
    {
      description: cws.description,
      inputSchema: {
        name: z.string().describe(cws.params.name),
        usernames: z.array(z.string()).describe(cws.params.usernames),
      },
    },
    async ({ name, usernames }) => {
      onToolCall?.(cws.toolName, { name, usernames });
      const conversationId = await app.createWorkSession(name, usernames);
      return json({ conversationId });
    },
  );

  const cg = desc.createGroup();
  server.registerTool(
    cg.toolName,
    {
      description: cg.description,
      inputSchema: {
        name: z.string().describe(cg.params.name),
        usernames: z.array(z.string()).describe(cg.params.usernames),
      },
    },
    async ({ name, usernames }) => {
      onToolCall?.(cg.toolName, { name, usernames });
      const conversationId = await app.createGroup(name, usernames);
      return json({ conversationId });
    },
  );

  const gc = desc.getConversation();
  server.registerTool(
    gc.toolName,
    { description: gc.description, inputSchema: { conversationId: z.string().describe(gc.params.conversationId) } },
    async ({ conversationId }) => {
      onToolCall?.(gc.toolName, { conversationId });
      const conv = await app.client.getConversation({ conversationId });
      return json(conv);
    },
  );

  const am = desc.addMembers();
  server.registerTool(
    am.toolName,
    {
      description: am.description,
      inputSchema: {
        conversationId: z.string().describe(am.params.conversationId),
        usernames: z.array(z.string()).describe(am.params.usernames),
      },
    },
    async ({ conversationId, usernames }) => {
      onToolCall?.(am.toolName, { conversationId, usernames });
      const memberIds = await Promise.all(usernames.map((u) => app.resolveUsername(u)));
      await app.client.addMembers({ conversationId, memberIds });
      return text(`Added ${usernames.join(', ')} to conversation`);
    },
  );

  const rm = desc.removeMember();
  server.registerTool(
    rm.toolName,
    {
      description: rm.description,
      inputSchema: {
        conversationId: z.string().describe(rm.params.conversationId),
        username: z.string().describe(rm.params.username),
      },
    },
    async ({ conversationId, username }) => {
      onToolCall?.(rm.toolName, { conversationId, username });
      const userId = await app.resolveUsername(username);
      await app.client.removeMember({ conversationId, userId });
      return text(`Removed @${username} from conversation`);
    },
  );
}
