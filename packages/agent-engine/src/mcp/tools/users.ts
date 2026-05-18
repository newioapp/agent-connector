/**
 * User discovery tools — search users, get profiles.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import type { ToolCallHook } from '../types.js';
import type { ToolDescriptions } from '../tool-descriptions.js';

const json = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] });

export function registerUsersTools(
  server: McpServer,
  app: NewioApp,
  desc: ToolDescriptions,
  onToolCall?: ToolCallHook,
): void {
  const mp = desc.getMyProfile();
  server.registerTool(mp.toolName, { description: mp.description }, async () => {
    onToolCall?.(mp.toolName, {});
    return json(await app.client.getMe({}));
  });

  const su = desc.searchUsers();
  server.registerTool(
    su.toolName,
    { description: su.description, inputSchema: { query: z.string().describe(su.params.query) } },
    async ({ query }) => {
      onToolCall?.(su.toolName, { query });
      const resp = await app.client.searchUsers({ query });
      return json(resp.users);
    },
  );

  const gup = desc.getUserProfile();
  server.registerTool(
    gup.toolName,
    { description: gup.description, inputSchema: { username: z.string().describe(gup.params.username) } },
    async ({ username }) => {
      onToolCall?.(gup.toolName, { username });
      const user = await app.client.getUserByUsername({ username });
      return json(user);
    },
  );
}
