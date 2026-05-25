/**
 * Contacts tools — thin MCP wrappers over NewioApp contact methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioAppForMcp, ToolCallHook } from '../types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/** Register contacts tools on the MCP server. */
export function registerContactsTools(server: McpServer, app: NewioAppForMcp, onToolCall?: ToolCallHook): void {
  server.registerTool(
    'list_contacts',
    {
      description:
        "List all your contacts. These are the only users you can message or create DMs with. Use this to find the correct username when you know someone's display name. Returns username, displayName, and accountType for each contact.",
    },
    () => {
      onToolCall?.('list_contacts', {});
      return json(app.getAllContacts());
    },
  );

  server.registerTool(
    'send_friend_request',
    {
      description:
        'Send a friend request to a user by their exact username (not display name). Use search_users first if you only know their display name.',
      inputSchema: {
        username: z.string().describe('Exact username of the user, NOT their display name'),
        note: z.string().optional().describe('Optional note to include with the request'),
      },
    },
    async ({ username, note }) => {
      onToolCall?.('send_friend_request', { username, note });
      await app.sendFriendRequestByUsername(username, note);
      return text(`Friend request sent to @${username}`);
    },
  );

  server.registerTool('list_incoming_friend_requests', { description: 'List pending incoming friend requests' }, () => {
    onToolCall?.('list_incoming_friend_requests', {});
    return json(app.listIncomingFriendRequests());
  });

  server.registerTool(
    'accept_friend_request',
    {
      description: "Accept a pending incoming friend request by the sender's exact username (not display name).",
      inputSchema: {
        username: z.string().describe('Exact username of the person who sent the request, NOT their display name'),
      },
    },
    async ({ username }) => {
      onToolCall?.('accept_friend_request', { username });
      await app.acceptFriendRequestByUsername(username);
      return text(`Friend request from @${username} accepted`);
    },
  );

  server.registerTool(
    'reject_friend_request',
    {
      description: "Reject a pending incoming friend request by the sender's exact username (not display name).",
      inputSchema: {
        username: z.string().describe('Exact username of the person who sent the request, NOT their display name'),
      },
    },
    async ({ username }) => {
      onToolCall?.('reject_friend_request', { username });
      await app.rejectFriendRequestByUsername(username);
      return text(`Friend request from @${username} rejected`);
    },
  );

  server.registerTool(
    'remove_friend',
    {
      description:
        'Remove a friend by their exact username. Use list_contacts to find the correct username if you only know their display name.',
      inputSchema: { username: z.string().describe('Exact username of the friend to remove, NOT their display name') },
    },
    async ({ username }) => {
      onToolCall?.('remove_friend', { username });
      await app.removeFriendByUsername(username);
      return text(`Removed @${username} from friends`);
    },
  );
}
