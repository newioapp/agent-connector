/**
 * Memory tools — read and write agent memory.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { stringify } from 'yaml';
import type { NewioAppForMcp, ToolCallHook } from '../types.js';
import type { ToolDescriptions } from '../tool-descriptions.js';

const yaml = (obj: unknown) => ({ content: [{ type: 'text' as const, text: stringify(obj) }] });
const err = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true as const });

export function registerMemoryTools(
  server: McpServer,
  app: NewioAppForMcp,
  desc: ToolDescriptions,
  onToolCall?: ToolCallHook,
): void {
  function validateNotSelf(username?: string): void {
    if (username && username.toLowerCase() === app.identity.username.toLowerCase()) {
      throw new Error('To update your own memory, omit the username field. Per-user memory is for other people.');
    }
  }

  const gm = desc.getMemory();
  server.registerTool(
    gm.toolName,
    {
      description: gm.description,
      inputSchema: {
        username: z.string().optional().describe(gm.params.username),
        conversationId: z.string().optional().describe(gm.params.conversationId),
      },
    },
    async ({ username, conversationId }) => {
      onToolCall?.(gm.toolName, { username, conversationId });
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

  const am = desc.addMemory();
  server.registerTool(
    am.toolName,
    {
      description: am.description,
      inputSchema: {
        text: z.string().describe(am.params.text),
        username: z.string().optional().describe(am.params.username),
        conversationId: z.string().optional().describe(am.params.conversationId),
      },
    },
    async ({ text, username, conversationId }) => {
      onToolCall?.(am.toolName, { text, username, conversationId });
      validateNotSelf(username);
      await app.addMemory(text, { username, conversationId });
      return { content: [{ type: 'text' as const, text: 'Memory fact stored.' }] };
    },
  );

  const um = desc.updateMemory();
  server.registerTool(
    um.toolName,
    {
      description: um.description,
      inputSchema: {
        factId: z.string().describe(um.params.factId),
        text: z.string().describe(um.params.text),
        username: z.string().optional().describe(um.params.username),
        conversationId: z.string().optional().describe(um.params.conversationId),
      },
    },
    async ({ factId, text, username, conversationId }) => {
      onToolCall?.(um.toolName, { factId, text, username, conversationId });
      validateNotSelf(username);
      await app.updateMemory(factId, text, { username, conversationId });
      return { content: [{ type: 'text' as const, text: 'Memory fact updated.' }] };
    },
  );

  const dm = desc.deleteMemory();
  server.registerTool(
    dm.toolName,
    {
      description: dm.description,
      inputSchema: {
        factId: z.string().describe(dm.params.factId),
        username: z.string().optional().describe(dm.params.username),
        conversationId: z.string().optional().describe(dm.params.conversationId),
      },
    },
    async ({ factId, username, conversationId }) => {
      onToolCall?.(dm.toolName, { factId, username, conversationId });
      validateNotSelf(username);
      await app.deleteMemory(factId, { username, conversationId });
      return { content: [{ type: 'text' as const, text: 'Memory fact deleted.' }] };
    },
  );

  const ums = desc.updateMemorySummary();
  server.registerTool(
    ums.toolName,
    {
      description: ums.description,
      inputSchema: {
        text: z.string().describe(ums.params.text),
        username: z.string().optional().describe(ums.params.username),
        conversationId: z.string().optional().describe(ums.params.conversationId),
      },
    },
    async ({ text, username, conversationId }) => {
      onToolCall?.(ums.toolName, { text, username, conversationId });
      validateNotSelf(username);
      await app.updateMemorySummary(text, { username, conversationId });
      return { content: [{ type: 'text' as const, text: 'Memory summary updated.' }] };
    },
  );
}
