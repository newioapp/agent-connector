/**
 * Messaging tools — thin MCP wrappers over NewioApp messaging methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import type { IdGetter, ToolCallHook } from '../types';
import type { ToolDescriptions } from '../tool-descriptions.js';
import type { SessionMode } from '../../types';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/** Register messaging tools on the MCP server. */
export function registerMessagingTools(
  server: McpServer,
  app: NewioApp,
  desc: ToolDescriptions,
  initiateConversation: (convId: string, context: string) => void,
  getCurrentConversationId: IdGetter,
  sessionMode: SessionMode,
  onToolCall?: ToolCallHook,
): void {
  if (sessionMode === 'isolated') {
    const ic = desc.initiateConversation();
    server.registerTool(
      'initiate_conversation',
      {
        description: ic.description,
        inputSchema: {
          conversationId: z.string().describe(ic.params.conversationId),
          context: z.string().describe(ic.params.context),
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

  if (sessionMode === 'shared') {
    const sm = desc.sendMessage();
    server.registerTool(
      'send_message',
      {
        description: sm.description,
        inputSchema: {
          conversationId: z.string().describe(sm.params.conversationId),
          text: z.string().describe(sm.params.text),
          filePaths: z.array(z.string()).max(5).optional().describe(sm.params.filePaths),
        },
      },
      async ({ conversationId, text: msgText, filePaths }) => {
        onToolCall?.('send_message', { conversationId, text: msgText, filePaths });
        await app.sendMessage(conversationId, msgText, filePaths);
        return text('Message sent');
      },
    );

    const sd = desc.sendDm();
    server.registerTool(
      'send_dm',
      {
        description: sd.description,
        inputSchema: {
          username: z.string().describe(sd.params.username),
          text: z.string().describe(sd.params.text),
          filePaths: z.array(z.string()).max(5).optional().describe(sd.params.filePaths),
        },
      },
      async ({ username, text: msgText, filePaths }) => {
        onToolCall?.('send_dm', { username, text: msgText, filePaths });
        await app.sendDm(username, msgText, filePaths);
        return text(`DM sent to @${username}`);
      },
    );

    const dmo = desc.dmOwner();
    server.registerTool(
      'dm_owner',
      {
        description: dmo.description,
        inputSchema: {
          text: z.string().describe(dmo.params.text),
          filePaths: z.array(z.string()).max(5).optional().describe(dmo.params.filePaths),
        },
      },
      async ({ text: msgText, filePaths }) => {
        onToolCall?.('dm_owner', { text: msgText, filePaths });
        await app.dmOwner(msgText, filePaths);
        return text('DM sent to owner');
      },
    );
  }

  const lm = desc.listMessages();
  server.registerTool(
    'list_messages',
    {
      description: lm.description,
      inputSchema: {
        conversationId: z.string().describe(lm.params.conversationId),
        limit: z.number().optional().describe(lm.params.limit),
        beforeMessageId: z.string().optional().describe(lm.params.beforeMessageId),
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
