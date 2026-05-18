/**
 * Memory tools — read and write agent memory.
 *
 * Scoping is inferred from parameters:
 * - username provided → user-scoped memory
 * - conversationId provided → conversation-scoped memory
 * - neither → global (agent's own) memory (write tools only)
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import { stringify } from 'yaml';
import type { ToolCallHook } from '../types.js';
import type { ToolDescriptions } from '../tool-descriptions.js';

const yaml = (obj: unknown) => ({ content: [{ type: 'text' as const, text: stringify(obj) }] });
const err = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true as const });

/** Register memory tools on the MCP server. */
export function registerMemoryTools(
  server: McpServer,
  app: NewioApp,
  desc: ToolDescriptions,
  onToolCall?: ToolCallHook,
): void {
  function validateNotSelf(username?: string): void {
    if (username && username.toLowerCase() === app.identity.username.toLowerCase()) {
      throw new Error('To update your own memory, omit the username field. Per-user memory is for other people.');
    }
  }

  const getMem = desc.getMemory();
  server.registerTool(
    'get_memory',
    {
      description: getMem.description,
      inputSchema: {
        username: z.string().optional().describe(getMem.params.username),
        conversationId: z.string().optional().describe(getMem.params.conversationId),
      },
    },
    async ({ username, conversationId }) => {
      onToolCall?.('get_memory', { username, conversationId });
      if (username) {
        return yaml(await app.getContactMemory(username));
      }
      if (conversationId) {
        return yaml(await app.getConversationMemory(conversationId));
      }
      return err(
        'Provide either a username or conversationId. Your own memory is already loaded in the session context.',
      );
    },
  );

  const addMem = desc.addMemory();
  server.registerTool(
    'add_memory',
    {
      description: addMem.description,
      inputSchema: {
        text: z.string().describe(addMem.params.text),
        username: z.string().optional().describe(addMem.params.username),
        conversationId: z.string().optional().describe(addMem.params.conversationId),
      },
    },
    async ({ text, username, conversationId }) => {
      onToolCall?.('add_memory', { text, username, conversationId });
      validateNotSelf(username);
      await app.addMemory(text, { username, conversationId });
      return yaml({ stored: true });
    },
  );

  const updateMem = desc.updateMemory();
  server.registerTool(
    'update_memory',
    {
      description: updateMem.description,
      inputSchema: {
        factId: z.string().describe(updateMem.params.factId),
        text: z.string().describe(updateMem.params.text),
        username: z.string().optional().describe(updateMem.params.username),
        conversationId: z.string().optional().describe(updateMem.params.conversationId),
      },
    },
    async ({ factId, text, username, conversationId }) => {
      onToolCall?.('update_memory', { factId, text, username, conversationId });
      validateNotSelf(username);
      await app.updateMemory(factId, text, { username, conversationId });
      return yaml({ updated: true });
    },
  );

  const deleteMem = desc.deleteMemory();
  server.registerTool(
    'delete_memory',
    {
      description: deleteMem.description,
      inputSchema: {
        factId: z.string().describe(deleteMem.params.factId),
        username: z.string().optional().describe(deleteMem.params.username),
        conversationId: z.string().optional().describe(deleteMem.params.conversationId),
      },
    },
    async ({ factId, username, conversationId }) => {
      onToolCall?.('delete_memory', { factId, username, conversationId });
      validateNotSelf(username);
      await app.deleteMemory(factId, { username, conversationId });
      return yaml({ deleted: true });
    },
  );

  const updateSummary = desc.updateMemorySummary();
  server.registerTool(
    'update_memory_summary',
    {
      description: updateSummary.description,
      inputSchema: {
        text: z.string().describe(updateSummary.params.text),
        username: z.string().optional().describe(updateSummary.params.username),
        conversationId: z.string().optional().describe(updateSummary.params.conversationId),
      },
    },
    async ({ text, username, conversationId }) => {
      onToolCall?.('update_memory_summary', { text, username, conversationId });
      validateNotSelf(username);
      await app.updateMemorySummary(text, { username, conversationId });
      return yaml({ updated: true });
    },
  );
}
