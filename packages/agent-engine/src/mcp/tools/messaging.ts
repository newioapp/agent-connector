/**
 * Messaging tools — thin MCP wrappers over NewioApp messaging methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IdGetter, NewioAppForMcp, ToolCallHook } from '../types';
import type { SessionMode } from '../../types';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

export function registerMessagingTools(
  server: McpServer,
  app: NewioAppForMcp,
  initiateConversation: (convId: string, context: string) => void,
  getCurrentConversationId: IdGetter,
  sessionMode: SessionMode,
  onToolCall?: ToolCallHook,
): void {
  if (sessionMode === 'isolated') {
    server.registerTool(
      'initiate_conversation',
      {
        description:
          "Delegate a task to another conversation's session. Use this when you need to send a message or perform an action in a DIFFERENT conversation. The target session is another instance of YOU — same agent, same owner, same memory — just in a different conversation. It will compose and send an appropriate message using its own conversational context. This is fire-and-forget — you will not receive a response. Do NOT use this for the current conversation; your reply is delivered automatically.",
        inputSchema: {
          conversationId: z.string().describe('Conversation ID of the target conversation to delegate to'),
          context: z
            .string()
            .describe(
              "What you want communicated and why. The target session already knows who you are and who your owner is — don't re-introduce them. Focus on: what to say, who requested it (e.g. 'owner asked' or 'alice mentioned'), and any relevant details the target session needs.",
            ),
        },
      },
      ({ conversationId, context }) => {
        onToolCall?.('initiate_conversation', { conversationId, context });
        if (getCurrentConversationId() === conversationId) {
          return text("Can't initiate the current conversation — your reply is delivered automatically.");
        }
        initiateConversation(conversationId, context);
        return text('Delegated to target conversation session.');
      },
    );
  }

  if (sessionMode === 'chat-shared') {
    server.registerTool(
      'share_context',
      {
        description:
          "Share context with another of your own sessions, identified by its conversationId. Use this to hand off relevant context to a DIFFERENT conversation's session — most commonly to brief a work session you just created (call create_work_session first) on why it exists, the goal, and any details it needs. The target session is another instance of YOU — same agent, same owner, same memory — running in its own context window. This is fire-and-forget — you will NOT receive a response, and it does NOT send a user-visible message by itself. Do NOT use this for the current conversation; your reply is delivered automatically.",
        inputSchema: {
          conversationId: z.string().describe('Conversation ID of the target session to share context with'),
          context: z
            .string()
            .describe(
              'The context to hand to the target session — what it should know and why. The target already knows who you are and who your owner is; focus on the task, goal, who requested it, and any details it needs to act.',
            ),
        },
      },
      ({ conversationId, context }) => {
        onToolCall?.('share_context', { conversationId, context });
        if (getCurrentConversationId() === conversationId) {
          return text("Can't share context with the current conversation — your reply is delivered automatically.");
        }
        initiateConversation(conversationId, context);
        return text('Context shared with the target session.');
      },
    );
  }

  if (sessionMode === 'shared' || sessionMode === 'chat-shared') {
    server.registerTool(
      'send_message',
      {
        description:
          'Send a message to a group chat or work session, optionally with file attachments (max 5). Use @username to mention members, @everyone to notify all, or @here to notify online members. \u26a0\ufe0f Only use this to send messages to a DIFFERENT conversation. If you are responding to a message in the current conversation, your reply is delivered automatically — do NOT use this tool or the message will be sent twice.',
        inputSchema: {
          conversationId: z.string().describe('Conversation ID to send the message to'),
          text: z.string().describe('Message text (supports markdown)'),
          filePaths: z
            .array(z.string())
            .max(5)
            .optional()
            .describe('Optional local file paths to attach (max 5, absolute or relative)'),
        },
      },
      async ({ conversationId, text: msgText, filePaths }) => {
        onToolCall?.('send_message', { conversationId, text: msgText, filePaths });
        await app.sendMessage(conversationId, msgText, filePaths ? { filePaths } : undefined);
        return text('Message sent');
      },
    );

    server.registerTool(
      'send_dm',
      {
        description:
          'Send a direct message to a user by their exact username (not display name), optionally with attachments. \u26a0\ufe0f Only use this to INITIATE a message to another user. If you are responding to a DM from that user, your reply is delivered automatically — do NOT use this tool or the message will be sent twice.',
        inputSchema: {
          username: z.string().describe('Exact username of the recipient, NOT their display name'),
          text: z.string().describe('Message text (supports markdown)'),
          filePaths: z
            .array(z.string())
            .max(5)
            .optional()
            .describe('Optional local file paths to attach (max 5, absolute or relative)'),
        },
      },
      async ({ username, text: msgText, filePaths }) => {
        onToolCall?.('send_dm', { username, text: msgText, filePaths });
        await app.sendDm(username, msgText, filePaths);
        return text(`DM sent to @${username}`);
      },
    );
  }

  server.registerTool(
    'list_messages',
    {
      description: 'List messages in a conversation (paginated, newest first)',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID'),
        limit: z.number().optional().describe('Max messages to return (default 20)'),
        beforeMessageId: z.string().optional().describe('Get messages before this message ID (for pagination)'),
      },
    },
    async ({ conversationId, limit, beforeMessageId }) => {
      onToolCall?.('list_messages', { conversationId, limit, beforeMessageId });
      const resp = await app.listMessages(conversationId, limit ?? 20, beforeMessageId);
      const messages = resp.messages.map((m) => ({
        messageId: m.messageId,
        senderId: m.senderId,
        text: m.content.text,
        attachments: m.content.attachments?.map((a) => ({
          fileName: a.fileName,
          contentType: a.contentType,
          size: a.size,
          s3Key: a.s3Key,
        })),
        createdAt: m.createdAt,
      }));
      return json(messages);
    },
  );
}
