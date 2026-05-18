/**
 * User discovery tools — search users, get profiles.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import type { ToolCallHook } from '../types.js';
import type { ToolDescriptions } from '../tool-descriptions.js';

const json = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] });

/** Register user discovery tools on the MCP server. */
export function registerUsersTools(
  server: McpServer,
  app: NewioApp,
  desc: ToolDescriptions,
  onToolCall?: ToolCallHook,
): void {
  const myProfile = desc.getMyProfile();
  server.registerTool('get_my_profile', { description: myProfile.description }, async () => {
    onToolCall?.('get_my_profile', {});
    const me = await app.client.getMe({});
    return json(me);
  });

  const search = desc.searchUsers();
  server.registerTool(
    'search_users',
    {
      description: search.description,
      inputSchema: { query: z.string().describe(search.params.query) },
    },
    async ({ query }) => {
      onToolCall?.('search_users', { query });
      const resp = await app.client.searchUsers({ query });
      return json(resp.users);
    },
  );

  const getProfile = desc.getUserProfile();
  server.registerTool(
    'get_user_profile',
    {
      description: getProfile.description,
      inputSchema: { username: z.string().describe(getProfile.params.username) },
    },
    async ({ username }) => {
      onToolCall?.('get_user_profile', { username });
      const user = await app.client.getUserByUsername({ username });
      return json(user);
    },
  );
}
