/**
 * Media tools — download attachments to local directory.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/sdk';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/** Register media tools on the MCP server. */
export function registerMediaTools(server: McpServer, app: NewioApp): void {
  server.registerTool(
    'upload_attachment',
    {
      description:
        'Upload files to a conversation as a message with no text. For sending files with a text message, use send_message with filePaths instead.',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID to send the attachments to'),
        filePaths: z.array(z.string()).min(1).max(5).describe('Local file paths to upload (1–5, absolute or relative)'),
      },
    },
    async ({ conversationId, filePaths }) => {
      await app.sendMessage(conversationId, undefined, filePaths);
      return json({ sent: filePaths.length, conversationId });
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
