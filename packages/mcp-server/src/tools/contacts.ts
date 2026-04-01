/**
 * Contacts tools — thin MCP wrappers over NewioApp contact methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/sdk';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/** Register contacts tools on the MCP server. */
export function registerContactsTools(server: McpServer, app: NewioApp): void {
  server.registerTool('list_friends', { description: 'List all friends (contacts) of this agent' }, () => {
    return json(
      app.getAllContacts().map((c) => ({
        username: c.friendUsername,
        displayName: c.friendDisplayName,
        accountType: c.friendAccountType,
      })),
    );
  });

  server.registerTool(
    'send_friend_request',
    {
      description: 'Send a friend request to a user by username',
      inputSchema: {
        username: z.string().describe('Username of the user to send a friend request to'),
        note: z.string().optional().describe('Optional note to include with the request'),
      },
    },
    async ({ username, note }) => {
      await app.sendFriendRequestByUsername(username, note);
      return text(`Friend request sent to @${username}`);
    },
  );

  server.registerTool(
    'list_incoming_friend_requests',
    { description: 'List pending incoming friend requests' },
    async () => {
      const requests = await app.listIncomingFriendRequests();
      return json(
        requests.map((r) => ({
          username: r.friendUsername,
          displayName: r.friendDisplayName,
          accountType: r.friendAccountType,
          note: r.note,
        })),
      );
    },
  );

  server.registerTool(
    'accept_friend_request',
    {
      description: 'Accept a pending incoming friend request by username',
      inputSchema: { username: z.string().describe('Username of the person who sent the request') },
    },
    async ({ username }) => {
      await app.acceptFriendRequestByUsername(username);
      return text(`Friend request from @${username} accepted`);
    },
  );

  server.registerTool(
    'reject_friend_request',
    {
      description: 'Reject a pending incoming friend request by username',
      inputSchema: { username: z.string().describe('Username of the person who sent the request') },
    },
    async ({ username }) => {
      await app.rejectFriendRequestByUsername(username);
      return text(`Friend request from @${username} rejected`);
    },
  );

  server.registerTool(
    'remove_friend',
    {
      description: 'Remove a friend by username',
      inputSchema: { username: z.string().describe('Username of the friend to remove') },
    },
    async ({ username }) => {
      await app.removeFriendByUsername(username);
      return text(`Removed @${username} from friends`);
    },
  );
}
