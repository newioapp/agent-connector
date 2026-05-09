/**
 * Memory tools — read and write agent memory.
 *
 * Scoping is inferred from parameters:
 * - username provided → user-scoped memory
 * - conversationId provided → conversation-scoped memory
 * - neither → global (agent-wide) memory
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import { stringify } from 'yaml';

const yaml = (obj: unknown) => ({ content: [{ type: 'text' as const, text: stringify(obj) }] });

/** Register memory tools on the MCP server. */
export function registerMemoryTools(server: McpServer, app: NewioApp): void {
  server.registerTool(
    'get_memory',
    {
      description:
        'Load memory about a person or conversation. Use this to retrieve context that was not pre-loaded at session start (e.g., a new participant joined).',
      inputSchema: {
        username: z.string().optional().describe('Username of the person (for user-scoped memory)'),
        conversationId: z.string().optional().describe('Conversation ID (for conversation-scoped memory)'),
      },
    },
    async ({ username, conversationId }) => {
      if (username) {
        return yaml(await app.getContactMemory(username));
      }
      if (conversationId) {
        return yaml(await app.getConversationMemory(conversationId));
      }
      return yaml(await app.getGlobalMemory());
    },
  );

  server.registerTool(
    'add_memory',
    {
      description:
        'Store a new fact in memory. Facts must be self-contained, third-person statements (15-50 words). Group related information about the same entity into one fact.',
      inputSchema: {
        text: z.string().describe('The fact to store (self-contained, third-person)'),
        username: z.string().optional().describe('Username of the person this fact is about'),
        conversationId: z.string().optional().describe('Conversation ID this fact is about'),
      },
    },
    async ({ text, username, conversationId }) => {
      await app.addMemory(text, { username, conversationId });
      return yaml({ stored: true });
    },
  );

  server.registerTool(
    'update_memory',
    {
      description:
        'Update an existing memory fact. Use when information has materially changed — not for cosmetic rewording.',
      inputSchema: {
        factId: z.string().describe('The ID of the fact to update'),
        text: z.string().describe('The updated fact text'),
        username: z.string().optional().describe('Username of the person this fact is about'),
        conversationId: z.string().optional().describe('Conversation ID this fact is about'),
      },
    },
    async ({ factId, text, username, conversationId }) => {
      await app.updateMemory(factId, text, { username, conversationId });
      return yaml({ updated: true });
    },
  );

  server.registerTool(
    'delete_memory',
    {
      description: 'Delete a memory fact. Use when information is contradicted or no longer relevant.',
      inputSchema: {
        factId: z.string().describe('The ID of the fact to delete'),
        username: z.string().optional().describe('Username of the person this fact is about'),
        conversationId: z.string().optional().describe('Conversation ID this fact is about'),
      },
    },
    async ({ factId, username, conversationId }) => {
      await app.deleteMemory(factId, { username, conversationId });
      return yaml({ deleted: true });
    },
  );

  server.registerTool(
    'update_memory_summary',
    {
      description:
        'Update the summary for a memory scope. Summaries are always loaded at session start — keep them concise (max 10 lines for user/conversation).',
      inputSchema: {
        text: z.string().describe('The new summary text'),
        username: z.string().optional().describe('Username of the person this summary is about'),
        conversationId: z.string().optional().describe('Conversation ID this summary is about'),
      },
    },
    async ({ text, username, conversationId }) => {
      await app.updateMemorySummary(text, { username, conversationId });
      return yaml({ updated: true });
    },
  );
}
