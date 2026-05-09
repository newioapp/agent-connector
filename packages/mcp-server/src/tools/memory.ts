/**
 * Memory tools — read and write agent memory scopes.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp, MemoryScope } from '@newio/agent-sdk';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

const scopeEnum = z
  .enum(['global', 'user', 'conversation'])
  .describe('Memory scope: global (agent-wide), user (per-person), or conversation (per-conversation)');

/** Register memory tools on the MCP server. */
export function registerMemoryTools(server: McpServer, app: NewioApp): void {
  const agentId = app.identity.userId;

  server.registerTool(
    'memory_get_scope',
    {
      description:
        'Load memory for a specific scope (user or conversation). Use this to retrieve context about a person or conversation that was not pre-loaded at session start.',
      inputSchema: {
        scope: scopeEnum,
        scopeId: z.string().describe('The userId or conversationId. Use "_" for global scope.'),
      },
    },
    async ({ scope, scopeId }) => {
      const result = await app.client.getMemory({ agentId, scope: scope as MemoryScope, scopeId });
      return json(result.data);
    },
  );

  server.registerTool(
    'memory_add',
    {
      description:
        'Add a new fact to memory. Facts must be self-contained, third-person statements. Group related information about the same entity into one fact.',
      inputSchema: {
        scope: scopeEnum,
        scopeId: z.string().describe('The userId or conversationId. Use "_" for global scope.'),
        text: z.string().describe('The fact to store (self-contained, third-person, 15-50 words)'),
      },
    },
    async ({ scope, scopeId, text: factText }) => {
      const result = await app.client.batchUpdateMemory({
        agentId,
        operations: [{ op: 'add', scope: scope as MemoryScope, scopeId, text: factText }],
      });
      return json({ stored: true, applied: result.applied });
    },
  );

  server.registerTool(
    'memory_update',
    {
      description: 'Update an existing memory fact. Use when information has materially changed. Preserves the factId.',
      inputSchema: {
        scope: scopeEnum,
        scopeId: z.string().describe('The userId or conversationId. Use "_" for global scope.'),
        factId: z.string().describe('The ID of the fact to update'),
        text: z.string().describe('The updated fact text'),
      },
    },
    async ({ scope, scopeId, factId, text: factText }) => {
      const result = await app.client.batchUpdateMemory({
        agentId,
        operations: [{ op: 'update', scope: scope as MemoryScope, scopeId, factId, text: factText }],
      });
      return json({ updated: true, applied: result.applied });
    },
  );

  server.registerTool(
    'memory_delete',
    {
      description: 'Delete a memory fact. Use when information is contradicted or no longer relevant.',
      inputSchema: {
        scope: scopeEnum,
        scopeId: z.string().describe('The userId or conversationId. Use "_" for global scope.'),
        factId: z.string().describe('The ID of the fact to delete'),
      },
    },
    async ({ scope, scopeId, factId }) => {
      const result = await app.client.batchUpdateMemory({
        agentId,
        operations: [{ op: 'delete', scope: scope as MemoryScope, scopeId, factId }],
      });
      return json({ deleted: true, applied: result.applied });
    },
  );

  server.registerTool(
    'memory_update_summary',
    {
      description:
        'Update the summary for a memory scope. Summaries are always loaded at session start and should be a concise overview (max 10 lines for user/conversation, unlimited for global).',
      inputSchema: {
        scope: scopeEnum,
        scopeId: z.string().describe('The userId or conversationId. Use "_" for global scope.'),
        text: z.string().describe('The new summary text'),
      },
    },
    async ({ scope, scopeId, text: summaryText }) => {
      const result = await app.client.batchUpdateMemory({
        agentId,
        operations: [{ op: 'update_summary', scope: scope as MemoryScope, scopeId, text: summaryText }],
      });
      return json({ updated: true, applied: result.applied });
    },
  );
}
