/**
 * Messaging tools — send messages, list messages.
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
      description: 'Send a text message to a conversation',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID to send the message to'),
        text: z.string().describe('Message text (supports markdown)'),
      },
    },
    async ({ conversationId, text: msgText }) => {
      await app.sendMessage(conversationId, msgText);
      return text('Message sent');
    },
  );

  server.registerTool(
    'send_dm',
    {
      description: 'Send a direct message to a user by username (creates the DM if needed)',
      inputSchema: {
        username: z.string().describe('Username of the recipient'),
        text: z.string().describe('Message text (supports markdown)'),
      },
    },
    async ({ username, text: msgText }) => {
      await app.sendDm(username, msgText);
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
        attachments: m.content.attachments,
        createdAt: m.createdAt,
      }));
      return json(messages);
    },
  );
}
