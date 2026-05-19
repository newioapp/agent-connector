/**
 * Media tools — upload/download attachments.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import type { IdGetter, ToolCallHook } from '../types.js';
import type { ToolDescriptions } from '../tool-descriptions.js';

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
  app: NewioApp,
  desc: ToolDescriptions,
  getCurrentConversationId: IdGetter,
  onToolCall?: ToolCallHook,
): void {
  const up = desc.uploadAttachmentToCurrentConversation();
  server.registerTool(
    up.toolName,
    {
      description: up.description,
      inputSchema: { filePaths: z.array(z.string()).min(1).max(5).describe(up.params.filePaths) },
    },
    async ({ filePaths }) => {
      onToolCall?.(up.toolName, { filePaths });
      const convId = requireCurrentConversationId(getCurrentConversationId);
      await app.sendMessage(convId, undefined, filePaths);
      return text(`Uploaded ${filePaths.length} file(s) to conversation ${convId}`);
    },
  );

  const dl = desc.downloadAttachment();
  server.registerTool(
    dl.toolName,
    {
      description: dl.description,
      inputSchema: {
        conversationId: z.string().describe(dl.params.conversationId),
        s3Key: z.string().describe(dl.params.s3Key),
        fileName: z.string().describe(dl.params.fileName),
      },
      outputSchema: z.object({
        localPath: z.string().describe(dl.output.localPath),
      }),
    },
    async ({ conversationId, s3Key, fileName }) => {
      onToolCall?.(dl.toolName, { conversationId, s3Key, fileName });
      const localPath = await app.downloadAttachment(conversationId, s3Key, fileName);
      return { content: [{ type: 'text' as const, text: localPath }], structuredContent: { localPath } };
    },
  );
}
