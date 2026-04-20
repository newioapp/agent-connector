/**
 * Media tools — download attachments to local directory.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/sdk';
import { IdGetter } from '../types';

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
export function registerMediaTools(server: McpServer, app: NewioApp, getCurrentConversationId: IdGetter): void {
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
      const convId = requireCurrentConversationId(getCurrentConversationId);
      await app.sendMessage(convId, undefined, filePaths);
      return json({ sent: filePaths.length, convId });
    },
  );

  server.registerTool(
    'download_attachment',
    {
      description: 'Download a message attachment to a local file and return the file path',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID the attachment belongs to'),
        s3Key: z.string().describe('The s3Key from the message attachment'),
        fileName: z.string().describe('The fileName from the message attachment'),
      },
    },
    async ({ conversationId, s3Key, fileName }) => {
      const localPath = await app.downloadAttachment(conversationId, s3Key, fileName);
      return text(localPath);
    },
  );
}
