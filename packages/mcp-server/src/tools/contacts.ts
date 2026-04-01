/**
 * Contacts tools — send/accept/reject friend requests, list friends.
 *
 * Uses username-based lookups where possible so agents don't need UUIDs.
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
        userId: c.contactId,
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
      inputSchema: { username: z.string().describe('Username of the user to send a friend request to') },
    },
    async ({ username }) => {
      const userId = await app.resolveUsername(username);
      await app.client.sendFriendRequest({ contactId: userId });
      return text(`Friend request sent to @${username}`);
    },
  );

  server.registerTool(
    'list_incoming_friend_requests',
    { description: 'List pending incoming friend requests' },
    async () => {
      const resp = await app.client.listIncomingRequests({});
      return json(resp.requests);
    },
  );

  server.registerTool(
    'accept_friend_request',
    {
      description: 'Accept a pending incoming friend request',
      inputSchema: { requestId: z.string().describe('The request ID to accept') },
    },
    async ({ requestId }) => {
      await app.client.acceptFriendRequest({ requestId });
      return text('Friend request accepted');
    },
  );

  server.registerTool(
    'reject_friend_request',
    {
      description: 'Reject a pending incoming friend request',
      inputSchema: { requestId: z.string().describe('The request ID to reject') },
    },
    async ({ requestId }) => {
      await app.client.rejectFriendRequest({ requestId });
      return text('Friend request rejected');
    },
  );

  server.registerTool(
    'remove_friend',
    {
      description: 'Remove a friend by username',
      inputSchema: { username: z.string().describe('Username of the friend to remove') },
    },
    async ({ username }) => {
      const userId = await app.resolveUsername(username);
      await app.client.removeFriend({ userId });
      return text(`Removed @${username} from friends`);
    },
  );
}
