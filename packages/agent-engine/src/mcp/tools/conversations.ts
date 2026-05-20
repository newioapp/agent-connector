/**
 * Conversations tools — thin MCP wrappers over NewioAppForMcp conversation methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioAppForMcp, ToolCallHook } from '../types.js';
import type { ToolDescriptions } from '../tool-descriptions.js';
import type { SessionMode } from '../../types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const structured = (obj: object) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
  structuredContent: obj as Record<string, unknown>,
});

export function registerConversationsTools(
  server: McpServer,
  app: NewioAppForMcp,
  desc: ToolDescriptions,
  sessionMode: SessionMode,
  onToolCall?: ToolCallHook,
): void {
  // ── list_conversations ──
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
      return structured(app.listConversations(limit, afterConversationId));
    },
  );

  // ── create_dm (isolated only) ──
  if (sessionMode === 'isolated') {
    const cd = desc.createDm();
    server.registerTool(
      cd.toolName,
      {
        description: cd.description,
        inputSchema: { username: z.string().describe(cd.params.username) },
        outputSchema: z.object({ conversationId: z.string().describe(cd.output.conversationId) }),
      },
      async ({ username }) => {
        onToolCall?.(cd.toolName, { username });
        const conversationId = await app.getOrCreateDm(username);
        return structured({ conversationId });
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
      outputSchema: z.object({ conversationId: z.string().describe(cws.output.conversationId) }),
    },
    async ({ name, usernames }) => {
      onToolCall?.(cws.toolName, { name, usernames });
      const conversationId = await app.createWorkSession(name, usernames);
      return structured({ conversationId });
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
      outputSchema: z.object({ conversationId: z.string().describe(cg.output.conversationId) }),
    },
    async ({ name, usernames }) => {
      onToolCall?.(cg.toolName, { name, usernames });
      const conversationId = await app.createGroup(name, usernames);
      return structured({ conversationId });
    },
  );

  // ── get_conversation ──
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
      return structured(await app.getConversationInfo(conversationId));
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
      outputSchema: z.object({ isMember: z.boolean().describe(cim.output.isMember) }),
    },
    async ({ conversationId, username }) => {
      onToolCall?.(cim.toolName, { conversationId, username });
      const isMember = await app.checkIsMember(conversationId, username);
      return structured({ isMember });
    },
  );

  // ── list_conversation_members ──
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
      return structured(await app.listConversationMembers(conversationId, limit, afterUsername));
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
      await app.addMembersByUsername(conversationId, usernames);
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
      await app.removeMemberByUsername(conversationId, username);
      return text(`Removed @${username} from conversation`);
    },
  );
}
