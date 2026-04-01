/**
 * Media tools — download attachments to local directory.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/sdk';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/** Register media tools on the MCP server. */
export function registerMediaTools(server: McpServer, app: NewioApp): void {
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
