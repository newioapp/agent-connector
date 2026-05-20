/**
 * Media tools — upload/download attachments.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IdGetter, NewioAppForMcp, ToolCallHook } from '../types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function requireCurrentConversationId(getter: IdGetter): string {
  const id = getter();
  if (!id) {
    throw new Error('MCP server has no active conversation — cannot determine target conversation.');
  }
  return id;
}

export function registerMediaTools(
  server: McpServer,
  app: NewioAppForMcp,
  getCurrentConversationId: IdGetter,
  onToolCall?: ToolCallHook,
): void {
  server.registerTool(
    'upload_attachment_to_current_conversation',
    {
      description:
        'Upload files to the current active conversation as a message with no text. Only works during an active conversation prompt. To send files to a specific conversation, use send_message with filePaths instead.',
      inputSchema: {
        filePaths: z.array(z.string()).min(1).max(5).describe('Local file paths to upload (1–5, absolute or relative)'),
      },
    },
    async ({ filePaths }) => {
      onToolCall?.('upload_attachment_to_current_conversation', { filePaths });
      const convId = requireCurrentConversationId(getCurrentConversationId);
      await app.sendMessage(convId, undefined, { filePaths });
      return text(`Uploaded ${filePaths.length} file(s) to conversation ${convId}`);
    },
  );

  server.registerTool(
    'download_attachment',
    {
      description: 'Download a message attachment to a local file and return the absolute file path',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID the attachment belongs to'),
        s3Key: z.string().describe('The s3Key from the message attachment'),
        fileName: z.string().describe('The fileName from the message attachment'),
      },
      outputSchema: z.object({
        localPath: z.string().describe('Absolute file path where the attachment was saved'),
      }),
    },
    async ({ conversationId, s3Key, fileName }) => {
      onToolCall?.('download_attachment', { conversationId, s3Key, fileName });
      const localPath = await app.downloadAttachment(conversationId, s3Key, fileName);
      return { content: [{ type: 'text' as const, text: localPath }], structuredContent: { localPath } };
    },
  );
}
