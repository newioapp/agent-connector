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

const yaml = (obj: unknown) => ({ content: [{ type: 'text' as const, text: stringify(obj) }] });
const err = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true as const });

/** Register memory tools on the MCP server. */
export function registerMemoryTools(server: McpServer, app: NewioApp, onToolCall?: ToolCallHook): void {
  /** Reject if the agent passes its own username — that's global scope. */
  function validateNotSelf(username?: string): void {
    if (username && username.toLowerCase() === app.identity.username.toLowerCase()) {
      throw new Error('To update your own memory, omit the username field. Per-user memory is for other people.');
    }
  }

  server.registerTool(
    'get_memory',
    {
      description:
        'Load memory about a person or conversation that was not pre-loaded at session start (e.g., a new participant joined). Requires either a username or conversationId.',
      inputSchema: {
        username: z.string().optional().describe('Username of the person'),
        conversationId: z.string().optional().describe('Conversation ID'),
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

  server.registerTool(
    'add_memory',
    {
      description:
        'Store a new fact in memory. Facts must be self-contained, third-person statements (15-50 words). Omit username and conversationId to store about yourself.',
      inputSchema: {
        text: z.string().describe('The fact to store (self-contained, third-person)'),
        username: z.string().optional().describe('Username of the person this fact is about (omit for self)'),
        conversationId: z.string().optional().describe('Conversation ID this fact is about (omit for self)'),
      },
    },
    async ({ text, username, conversationId }) => {
      onToolCall?.('add_memory', { text, username, conversationId });
      validateNotSelf(username);
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
        username: z.string().optional().describe('Username of the person this fact is about (omit for self)'),
        conversationId: z.string().optional().describe('Conversation ID this fact is about (omit for self)'),
      },
    },
    async ({ factId, text, username, conversationId }) => {
      onToolCall?.('update_memory', { factId, text, username, conversationId });
      validateNotSelf(username);
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
        username: z.string().optional().describe('Username of the person this fact is about (omit for self)'),
        conversationId: z.string().optional().describe('Conversation ID this fact is about (omit for self)'),
      },
    },
    async ({ factId, username, conversationId }) => {
      onToolCall?.('delete_memory', { factId, username, conversationId });
      validateNotSelf(username);
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
        username: z.string().optional().describe('Username of the person this summary is about (omit for self)'),
        conversationId: z.string().optional().describe('Conversation ID this summary is about (omit for self)'),
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
