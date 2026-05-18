/**
 * Media tools — download attachments to local directory.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import type { IdGetter, ToolCallHook } from '../types.js';
import type { ToolDescriptions } from '../tool-descriptions.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

function requireCurrentConversationId(getCurrentConversationId: IdGetter): string {
  const id = getCurrentConversationId();
  if (!id) {
    throw new Error('MCP server has no active conversation — cannot determine target conversation.');
  }
  return id;
}

/** Register media tools on the MCP server. */
export function registerMediaTools(
  server: McpServer,
  app: NewioApp,
  desc: ToolDescriptions,
  getCurrentConversationId: IdGetter,
  onToolCall?: ToolCallHook,
): void {
  const upload = desc.uploadAttachmentToCurrentConversation();
  server.registerTool(
    'upload_attachment_to_current_conversation',
    {
      description: upload.description,
      inputSchema: {
        filePaths: z.array(z.string()).min(1).max(5).describe(upload.params.filePaths),
      },
    },
    async ({ filePaths }) => {
      onToolCall?.('upload_attachment_to_current_conversation', { filePaths });
      const convId = requireCurrentConversationId(getCurrentConversationId);
      await app.sendMessage(convId, undefined, filePaths);
      return json({ sent: filePaths.length, convId });
    },
  );

  const download = desc.downloadAttachment();
  server.registerTool(
    'download_attachment',
    {
      description: download.description,
      inputSchema: {
        conversationId: z.string().describe(download.params.conversationId),
        s3Key: z.string().describe(download.params.s3Key),
        fileName: z.string().describe(download.params.fileName),
      },
    },
    async ({ conversationId, s3Key, fileName }) => {
      onToolCall?.('download_attachment', { conversationId, s3Key, fileName });
      const localPath = await app.downloadAttachment(conversationId, s3Key, fileName);
      return text(localPath);
    },
  );
}
