/**
 * Media tools — get download URLs for message attachments.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/sdk';

const json = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] });

/** Register media tools on the MCP server. */
export function registerMediaTools(server: McpServer, app: NewioApp): void {
  server.registerTool(
    'get_download_url',
    {
      description: 'Get a signed download URL for a message attachment',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID the attachment belongs to'),
        s3Key: z.string().describe('The s3Key from the message attachment'),
      },
    },
    async ({ conversationId, s3Key }) => {
      const resp = await app.client.getDownloadUrl({ conversationId, s3Key });
      return json(resp);
    },
  );
}
