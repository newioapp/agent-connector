/**
 * Messaging tools — thin MCP wrappers over NewioApp messaging methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import type { IdGetter, ToolCallHook } from '../types';
import type { SessionMode } from '../../types';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/** Register messaging tools on the MCP server. */
export function registerMessagingTools(
  server: McpServer,
  app: NewioApp,
  initiateConversation: (convId: string, context: string) => void,
  getCurrentConversationId: IdGetter,
  sessionMode: SessionMode,
  onToolCall?: ToolCallHook,
): void {
  // Isolated mode: use initiate_conversation for cross-conversation delegation
  if (sessionMode === 'isolated') {
    server.registerTool(
      'initiate_conversation',
      {
        description:
          "Delegate a task to another conversation session. Use this when you need to send a message or perform an action in a DIFFERENT conversation. Instead of sending the message directly, this tool passes your intent and context to that conversation's session, which will formulate and send the message with full conversational context. This is fire-and-forget — you will not receive a response. Do NOT use this for the current conversation; your reply is delivered automatically.",
        inputSchema: {
          conversationId: z.string().describe('Conversation ID of the target conversation to delegate to'),
          context: z
            .string()
            .describe(
              'Full context for the delegation: what you want communicated, why, and any relevant background the target session needs to formulate an appropriate message',
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

  // Shared mode: send_dm, dm_owner, and send_message send messages directly
  if (sessionMode === 'shared') {
    server.registerTool(
      'send_message',
      {
        description:
          'Send a message to a group chat or work session, optionally with file attachments (max 5). Use @username to mention members, @everyone to notify all, or @here to notify online members. ⚠️ Only use this to send messages to a DIFFERENT conversation. If you are responding to a message in the current conversation, your reply is delivered automatically — do NOT use this tool or the message will be sent twice.',
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
        await app.sendMessage(conversationId, msgText, filePaths);
        return text('Message sent');
      },
    );

    server.registerTool(
      'send_dm',
      {
        description:
          'Send a direct message to a user by username, optionally with attachments. ⚠️ Only use this to INITIATE a message to another user. If you are responding to a DM from that user, your reply is delivered automatically — do NOT use this tool or the message will be sent twice.',
        inputSchema: {
          username: z.string().describe('Username of the recipient'),
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

    server.registerTool(
      'dm_owner',
      {
        description:
          "Send a direct message to this agent's owner, optionally with attachments. ⚠️ Only use this to INITIATE a message to your owner. If you are already responding to a DM from your owner, your reply is delivered automatically — do NOT use this tool or the message will be sent twice.",
        inputSchema: {
          text: z.string().describe('Message text (supports markdown)'),
          filePaths: z
            .array(z.string())
            .max(5)
            .optional()
            .describe('Optional local file paths to attach (max 5, absolute or relative)'),
        },
      },
      async ({ text: msgText, filePaths }) => {
        onToolCall?.('dm_owner', { text: msgText, filePaths });
        await app.dmOwner(msgText, filePaths);
        return text('DM sent to owner');
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
      const resp = await app.client.listMessages({
        conversationId,
        limit: limit ?? 20,
        beforeMessageId,
      });
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
