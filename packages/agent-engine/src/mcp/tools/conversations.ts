/**
 * Conversations tools — thin MCP wrappers over NewioApp conversation methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import type { ToolCallHook } from '../types.js';
import type { ToolDescriptions } from '../tool-descriptions.js';
import type { SessionMode } from '../../types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const structured = (obj: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
  structuredContent: obj,
});

export function registerConversationsTools(
  server: McpServer,
  app: NewioApp,
  desc: ToolDescriptions,
  sessionMode: SessionMode,
  onToolCall?: ToolCallHook,
): void {
  // ── list_conversations (paginated, structured) ──
  const lc = desc.listConversations();
  server.registerTool(
    lc.toolName,
    {
      description: lc.description,
      inputSchema: {
        limit: z.number().optional().describe(lc.params.limit),
        afterConversationId: z.string().optional().describe(lc.params.afterConversationId),
      },
      outputSchema: z.object({
        conversations: z.array(
          z.object({
            conversationId: z.string().describe(lc.output.conversationId),
            type: z.string().describe(lc.output.type),
            name: z.string().optional().describe(lc.output.name),
          }),
        ),
        hasMore: z.boolean(),
      }),
    },
    ({ limit, afterConversationId }) => {
      onToolCall?.(lc.toolName, { limit, afterConversationId });
      const all = app.getAllConversations();
      const pageSize = limit ?? 20;
      let startIdx = 0;
      if (afterConversationId) {
        const idx = all.findIndex((c) => c.conversationId === afterConversationId);
        if (idx >= 0) {
          startIdx = idx + 1;
        }
      }
      const page = all.slice(startIdx, startIdx + pageSize);
      const hasMore = startIdx + pageSize < all.length;
      const conversations = page.map((c) => ({
        conversationId: c.conversationId,
        type: c.type,
        ...(c.name ? { name: c.name } : {}),
      }));
      return structured({ conversations, hasMore });
    },
  );

  // ── create_dm (isolated only) ──
  const cd = desc.createDm();
  if (sessionMode === 'isolated') {
    server.registerTool(
      cd.toolName,
      {
        description: cd.description,
        inputSchema: { username: z.string().describe(cd.params.username) },
        outputSchema: z.object({
          conversationId: z.string().describe(cd.output.conversationId),
        }),
      },
      async ({ username }) => {
        onToolCall?.(cd.toolName, { username });
        const conversationId = await app.getOrCreateDm(username);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ conversationId }) }],
          structuredContent: { conversationId },
        };
      },
    );
  }

  // ── create_work_session ──
  const cws = desc.createWorkSession();
  server.registerTool(
    cws.toolName,
    {
      description: cws.description,
      inputSchema: {
        name: z.string().describe(cws.params.name),
        usernames: z.array(z.string()).describe(cws.params.usernames),
      },
      outputSchema: z.object({
        conversationId: z.string().describe(cws.output.conversationId),
      }),
    },
    async ({ name, usernames }) => {
      onToolCall?.(cws.toolName, { name, usernames });
      const conversationId = await app.createWorkSession(name, usernames);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ conversationId }) }],
        structuredContent: { conversationId },
      };
    },
  );

  // ── create_group ──
  const cg = desc.createGroup();
  server.registerTool(
    cg.toolName,
    {
      description: cg.description,
      inputSchema: {
        name: z.string().describe(cg.params.name),
        usernames: z.array(z.string()).describe(cg.params.usernames),
      },
      outputSchema: z.object({
        conversationId: z.string().describe(cg.output.conversationId),
      }),
    },
    async ({ name, usernames }) => {
      onToolCall?.(cg.toolName, { name, usernames });
      const conversationId = await app.createGroup(name, usernames);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ conversationId }) }],
        structuredContent: { conversationId },
      };
    },
  );

  // ── get_conversation (structured, no members) ──
  const gc = desc.getConversation();
  server.registerTool(
    gc.toolName,
    {
      description: gc.description,
      inputSchema: { conversationId: z.string().describe(gc.params.conversationId) },
      outputSchema: z.object({
        conversationId: z.string().describe(gc.output.conversationId),
        type: z.string().describe(gc.output.type),
        name: z.string().optional().describe(gc.output.name),
        admins: z.array(z.string()).describe(gc.output.admins),
      }),
    },
    async ({ conversationId }) => {
      onToolCall?.(gc.toolName, { conversationId });
      const conv = await app.getConversationDetails(conversationId);
      const admins = conv.members.filter((m) => m.role === 'admin').map((m) => m.username ?? m.userId);
      const result = {
        conversationId: conv.conversationId,
        type: conv.type,
        ...(conv.name ? { name: conv.name } : {}),
        admins,
      };
      return structured(result);
    },
  );

  // ── check_is_member ──
  const cim = desc.checkIsMember();
  server.registerTool(
    cim.toolName,
    {
      description: cim.description,
      inputSchema: {
        conversationId: z.string().describe(cim.params.conversationId),
        username: z.string().describe(cim.params.username),
      },
      outputSchema: z.object({
        isMember: z.boolean().describe(cim.output.isMember),
      }),
    },
    async ({ conversationId, username }) => {
      onToolCall?.(cim.toolName, { conversationId, username });
      const conv = await app.getConversationDetails(conversationId);
      const isMember = conv.members.some((m) => m.username?.toLowerCase() === username.toLowerCase());
      return structured({ isMember });
    },
  );

  // ── list_conversation_members (paginated, structured) ──
  const lcm = desc.listConversationMembers();
  server.registerTool(
    lcm.toolName,
    {
      description: lcm.description,
      inputSchema: {
        conversationId: z.string().describe(lcm.params.conversationId),
        limit: z.number().optional().describe(lcm.params.limit),
        afterUsername: z.string().optional().describe(lcm.params.afterUsername),
      },
      outputSchema: z.object({
        members: z.array(
          z.object({
            username: z.string().describe(lcm.output.username),
            displayName: z.string().describe(lcm.output.displayName),
            accountType: z.string().describe(lcm.output.accountType),
            role: z.string().describe(lcm.output.role),
          }),
        ),
        hasMore: z.boolean(),
      }),
    },
    async ({ conversationId, limit, afterUsername }) => {
      onToolCall?.(lcm.toolName, { conversationId, limit, afterUsername });
      const conv = await app.getConversationDetails(conversationId);
      const allMembers = conv.members.map((m) => ({
        username: m.username ?? m.userId,
        displayName: m.displayName ?? m.username ?? m.userId,
        accountType: m.accountType,
        role: m.role,
      }));
      const pageSize = limit ?? 20;
      let startIdx = 0;
      if (afterUsername) {
        const idx = allMembers.findIndex((m) => m.username.toLowerCase() === afterUsername.toLowerCase());
        if (idx >= 0) {
          startIdx = idx + 1;
        }
      }
      const page = allMembers.slice(startIdx, startIdx + pageSize);
      const hasMore = startIdx + pageSize < allMembers.length;
      return structured({ members: page, hasMore });
    },
  );

  // ── add_members ──
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
      await app.addMembers(conversationId, memberIds);
      return text(`Added ${usernames.join(', ')} to conversation`);
    },
  );

  // ── remove_member ──
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
      await app.removeMember(conversationId, userId);
      return text(`Removed @${username} from conversation`);
    },
  );
}
