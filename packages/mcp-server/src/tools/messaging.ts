/**
 * Messaging tools — thin MCP wrappers over NewioApp messaging methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/sdk';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/** Register messaging tools on the MCP server. */
export function registerMessagingTools(server: McpServer, app: NewioApp): void {
  server.registerTool(
    'send_message',
    {
      description: 'Send a message to a conversation, optionally with file attachments (max 5)',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID to send the message to'),
        text: z.string().describe('Message text (supports markdown)'),
        filePaths: z.array(z.string()).max(5).optional().describe('Optional local file paths to attach (max 5)'),
      },
    },
    async ({ conversationId, text: msgText, filePaths }) => {
      await app.sendMessageWithAttachments(conversationId, msgText, filePaths);
      return text('Message sent');
    },
  );

  server.registerTool(
    'send_dm',
    {
      description:
        'Send a direct message to a user by username (creates the DM if needed), optionally with attachments',
      inputSchema: {
        username: z.string().describe('Username of the recipient'),
        text: z.string().describe('Message text (supports markdown)'),
        filePaths: z.array(z.string()).max(5).optional().describe('Optional local file paths to attach (max 5)'),
      },
    },
    async ({ username, text: msgText, filePaths }) => {
      const conversationId = await app.findOrCreateDmByUsername(username);
      await app.sendMessageWithAttachments(conversationId, msgText, filePaths);
      return text(`DM sent to @${username}`);
    },
  );

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
