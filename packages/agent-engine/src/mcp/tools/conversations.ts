/**
 * Conversations tools — thin MCP wrappers over NewioAppForMcp conversation methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioAppForMcp, ToolCallHook } from '../types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const structured = (obj: object) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
  structuredContent: obj as Record<string, unknown>,
});

/**
 * After a conversation/member write returns, the backend still needs a moment to finalize member
 * subscriptions. A message sent immediately can land before a freshly added agent is provisioned
 * and miss its initial context. Settle here — only on the mutation tools, only after the write
 * succeeds — to give provisioning time to catch up. A fixed timer is a probabilistic mitigation;
 * awaiting an actual readiness signal is the longer-term fix (issue #269).
 */
export const WRITE_SETTLE_DELAY_MS = 3000;
const settleAfterWrite = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, WRITE_SETTLE_DELAY_MS));

export function registerConversationsTools(
  server: McpServer,
  app: NewioAppForMcp,
  /** Whether to expose the conversation-creation tools (create_dm/create_group/create_work_session). */
  canCreateConversations: boolean,
  onToolCall?: ToolCallHook,
): void {
  // ── list_conversations ──
  server.registerTool(
    'list_conversations',
    {
      description: 'List conversations this agent is part of (paginated, sorted by most recent activity)',
      inputSchema: {
        limit: z.number().optional().describe('Max conversations to return (default 20)'),
        afterConversationId: z.string().optional().describe('Get conversations after this ID (for pagination)'),
      },
      outputSchema: z.object({
        conversations: z.array(
          z.object({
            conversationId: z.string().describe('Unique conversation identifier'),
            type: z.string().describe('Conversation type: "dm", "group", or "temp_group"'),
            name: z.string().optional().describe('Conversation name (groups only)'),
          }),
        ),
        hasMore: z.boolean(),
      }),
    },
    ({ limit, afterConversationId }) => {
      onToolCall?.('list_conversations', { limit, afterConversationId });
      return structured(app.listConversations(limit, afterConversationId));
    },
  );

  // Conversation-creation tools — gated: chat-shared spokes can't address what they'd create, so the
  // hub owns conversation creation (see MessagingProfile.canCreateConversations).
  if (canCreateConversations) {
    // ── create_dm ──
    server.registerTool(
      'create_dm',
      {
        description:
          'Get or create a DM conversation with a user by their exact username (not display name). Returns the conversationId — use it with send_message (if you are responsible for it) or share_context (otherwise). You can only DM users in your contacts — use list_contacts to find the correct username. If you cannot find the person, ask the user for the exact username.',
        inputSchema: { username: z.string().describe('Exact username from your contacts, NOT the display name') },
        outputSchema: z.object({
          conversationId: z.string().describe('The DM conversation ID (existing or newly created)'),
        }),
      },
      async ({ username }) => {
        onToolCall?.('create_dm', { username });
        const conversationId = await app.getOrCreateDm(username);
        await settleAfterWrite();
        return structured({ conversationId });
      },
    );

    // ── create_work_session ──
    server.registerTool(
      'create_work_session',
      {
        description:
          'Create a work session — a collaborative conversation for you, your owner, and peer agents to coordinate on tasks.',
        inputSchema: {
          name: z.string().describe('Work session name'),
          usernames: z.array(z.string()).describe('Array of exact usernames, NOT display names'),
        },
        outputSchema: z.object({
          conversationId: z.string().describe('The newly created work session conversation ID'),
        }),
      },
      async ({ name, usernames }) => {
        onToolCall?.('create_work_session', { name, usernames });
        const conversationId = await app.createWorkSession(name, usernames);
        await settleAfterWrite();
        return structured({ conversationId });
      },
    );

    // ── create_group ──
    server.registerTool(
      'create_group',
      {
        description:
          "Create a named group conversation with admin controls. You can add human users, but only an agent's owner can add other agents to a named group.",
        inputSchema: {
          name: z.string().describe('Group name'),
          usernames: z.array(z.string()).describe('Array of exact usernames to include, NOT display names'),
        },
        outputSchema: z.object({
          conversationId: z.string().describe('The newly created group conversation ID'),
        }),
      },
      async ({ name, usernames }) => {
        onToolCall?.('create_group', { name, usernames });
        const conversationId = await app.createGroup(name, usernames);
        await settleAfterWrite();
        return structured({ conversationId });
      },
    );
  }

  // ── get_conversation ──
  server.registerTool(
    'get_conversation',
    {
      description:
        'Get metadata of a conversation (type, name, admins). Use list_conversation_members to get the member list.',
      inputSchema: { conversationId: z.string().describe('Conversation ID') },
      outputSchema: z.object({
        conversationId: z.string().describe('Conversation ID'),
        type: z.string().describe('Conversation type: "dm", "group", or "temp_group"'),
        name: z.string().optional().describe('Conversation name (groups only)'),
        admins: z.array(z.string()).describe('Array of admin usernames (groups only)'),
      }),
    },
    async ({ conversationId }) => {
      onToolCall?.('get_conversation', { conversationId });
      return structured(await app.getConversationInfo(conversationId));
    },
  );

  // ── check_is_member ──
  server.registerTool(
    'check_is_member',
    {
      description: 'Check whether a specific user is a member of a conversation',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID to check'),
        username: z.string().describe('Username to look for'),
      },
      outputSchema: z.object({
        isMember: z.boolean().describe('true if the user is a member, false otherwise'),
      }),
    },
    async ({ conversationId, username }) => {
      onToolCall?.('check_is_member', { conversationId, username });
      const isMember = await app.checkIsMember(conversationId, username);
      return structured({ isMember });
    },
  );

  // ── list_conversation_members ──
  server.registerTool(
    'list_conversation_members',
    {
      description: 'List members of a conversation (paginated)',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID'),
        limit: z.number().optional().describe('Max members to return (default 20)'),
        afterUsername: z.string().optional().describe('Get members after this username (for pagination)'),
      },
      outputSchema: z.object({
        members: z.array(
          z.object({
            username: z.string().describe('Member username'),
            displayName: z.string().describe('Member display name'),
            accountType: z.string().describe('Either "human" or "agent"'),
            role: z.string().describe('Member role: "admin" or "member"'),
          }),
        ),
        hasMore: z.boolean(),
      }),
    },
    async ({ conversationId, limit, afterUsername }) => {
      onToolCall?.('list_conversation_members', { conversationId, limit, afterUsername });
      return structured(await app.listConversationMembers(conversationId, limit, afterUsername));
    },
  );

  // ── add_members ──
  server.registerTool(
    'add_members',
    {
      description: 'Add members to a group conversation by their exact usernames.',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID'),
        usernames: z.array(z.string()).describe('Array of exact usernames to add, NOT display names'),
      },
    },
    async ({ conversationId, usernames }) => {
      onToolCall?.('add_members', { conversationId, usernames });
      await app.addMembersByUsername(conversationId, usernames);
      await settleAfterWrite();
      return text(`Added ${usernames.join(', ')} to conversation`);
    },
  );

  // ── remove_member ──
  server.registerTool(
    'remove_member',
    {
      description: 'Remove a member from a group conversation by their exact username.',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID'),
        username: z.string().describe('Exact username of the member to remove, NOT their display name'),
      },
    },
    async ({ conversationId, username }) => {
      onToolCall?.('remove_member', { conversationId, username });
      await app.removeMemberByUsername(conversationId, username);
      await settleAfterWrite();
      return text(`Removed @${username} from conversation`);
    },
  );
}
