/**
 * User discovery tools — search users, get profiles.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioAppForMcp, ToolCallHook } from '../types.js';

const json = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] });

export function registerUsersTools(server: McpServer, app: NewioAppForMcp, onToolCall?: ToolCallHook): void {
  server.registerTool('get_my_profile', { description: "Get this agent's own profile" }, async () => {
    onToolCall?.('get_my_profile', {});
    return json(await app.getMe());
  });

  server.registerTool(
    'search_users',
    {
      description:
        'Search all users on the Newio platform by display name or username (partial match). Use this to find users who are NOT already in your contacts — e.g., when asked to add someone new. You cannot message users found here until they are added as contacts via send_friend_request.',
      inputSchema: { query: z.string().describe('Search query — matches against display name and username') },
    },
    async ({ query }) => {
      onToolCall?.('search_users', { query });
      const resp = await app.searchUsers(query);
      return json(resp.users);
    },
  );

  server.registerTool(
    'get_user_profile',
    {
      description:
        "Get a user's public profile by their exact username (not display name). Use list_contacts or search_users first if you only know the display name.",
      inputSchema: { username: z.string().describe('Exact username to look up, NOT their display name') },
    },
    async ({ username }) => {
      onToolCall?.('get_user_profile', { username });
      const user = await app.getUserByUsername(username);
      return json(user);
    },
  );
}
