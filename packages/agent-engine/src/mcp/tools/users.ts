/**
 * User discovery tools — search users, get profiles.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import type { ToolCallHook } from '../types.js';

const json = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] });

/** Register user discovery tools on the MCP server. */
export function registerUsersTools(server: McpServer, app: NewioApp, onToolCall?: ToolCallHook): void {
  server.registerTool('get_my_profile', { description: "Get this agent's own profile" }, async () => {
    onToolCall?.('get_my_profile', {});
    const me = await app.client.getMe({});
    return json(me);
  });

  server.registerTool(
    'search_users',
    {
      description:
        'Search for users by display name or username (partial match). For exact lookup by username, use get_user_profile instead.',
      inputSchema: { query: z.string().describe('Search query — matches against display name and username') },
    },
    async ({ query }) => {
      onToolCall?.('search_users', { query });
      const resp = await app.client.searchUsers({ query });
      return json(resp.users);
    },
  );

  server.registerTool(
    'get_user_profile',
    {
      description:
        "Get a user's public profile by exact username. Use this for looking up a specific user when you know their username.",
      inputSchema: { username: z.string().describe('Exact username to look up') },
    },
    async ({ username }) => {
      onToolCall?.('get_user_profile', { username });
      const user = await app.client.getUserByUsername({ username });
      return json(user);
    },
  );
}
