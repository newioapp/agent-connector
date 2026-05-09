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
import type { NewioApp, MemoryScope } from '@newio/agent-sdk';
import { stringify } from 'yaml';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const yaml = (obj: unknown) => text(stringify(obj));

function resolveScope(username?: string, conversationId?: string): { scope: MemoryScope; scopeId: string } {
  if (username && conversationId) {
    throw new Error('Provide either username or conversationId, not both.');
  }
  if (username) {
    return { scope: 'user', scopeId: username }; // placeholder — resolved to userId below
  }
  if (conversationId) {
    return { scope: 'conversation', scopeId: conversationId };
  }
  return { scope: 'global', scopeId: '_' };
}

/** Register memory tools on the MCP server. */
export function registerMemoryTools(server: McpServer, app: NewioApp): void {
  const agentId = app.identity.userId;

  /** Resolve username to userId if scope is user. */
  async function resolveScopeId(
    username?: string,
    conversationId?: string,
  ): Promise<{ scope: MemoryScope; scopeId: string }> {
    const { scope, scopeId } = resolveScope(username, conversationId);
    if (scope === 'user') {
      const userId = await app.resolveUsername(scopeId);
      return { scope, scopeId: userId };
    }
    return { scope, scopeId };
  }

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
      const { scope, scopeId } = await resolveScopeId(username, conversationId);
      const result = await app.client.getMemory({ agentId, scope, scopeId });
      return yaml(result.data);
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
    async ({ text: factText, username, conversationId }) => {
      const { scope, scopeId } = await resolveScopeId(username, conversationId);
      const result = await app.client.batchUpdateMemory({
        agentId,
        operations: [{ op: 'add', scope, scopeId, text: factText }],
      });
      return yaml({ stored: true, applied: result.applied });
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
    async ({ factId, text: factText, username, conversationId }) => {
      const { scope, scopeId } = await resolveScopeId(username, conversationId);
      const result = await app.client.batchUpdateMemory({
        agentId,
        operations: [{ op: 'update', scope, scopeId, factId, text: factText }],
      });
      return yaml({ updated: true, applied: result.applied });
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
      const { scope, scopeId } = await resolveScopeId(username, conversationId);
      const result = await app.client.batchUpdateMemory({
        agentId,
        operations: [{ op: 'delete', scope, scopeId, factId }],
      });
      return yaml({ deleted: true, applied: result.applied });
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
    async ({ text: summaryText, username, conversationId }) => {
      const { scope, scopeId } = await resolveScopeId(username, conversationId);
      const result = await app.client.batchUpdateMemory({
        agentId,
        operations: [{ op: 'update_summary', scope, scopeId, text: summaryText }],
      });
      return yaml({ updated: true, applied: result.applied });
    },
  );
}
