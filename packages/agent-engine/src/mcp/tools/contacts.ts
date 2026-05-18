/**
 * Contacts tools — thin MCP wrappers over NewioApp contact methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import type { ToolCallHook } from '../types.js';
import type { ToolDescriptions } from '../tool-descriptions.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/** Register contacts tools on the MCP server. */
export function registerContactsTools(
  server: McpServer,
  app: NewioApp,
  desc: ToolDescriptions,
  onToolCall?: ToolCallHook,
): void {
  const listFriends = desc.listFriends();
  server.registerTool('list_friends', { description: listFriends.description }, () => {
    onToolCall?.('list_friends', {});
    return json(app.getAllContacts());
  });

  const sendReq = desc.sendFriendRequest();
  server.registerTool(
    'send_friend_request',
    {
      description: sendReq.description,
      inputSchema: {
        username: z.string().describe(sendReq.params.username),
        note: z.string().optional().describe(sendReq.params.note),
      },
    },
    async ({ username, note }) => {
      onToolCall?.('send_friend_request', { username, note });
      await app.sendFriendRequestByUsername(username, note);
      return text(`Friend request sent to @${username}`);
    },
  );

  const listIncoming = desc.listIncomingFriendRequests();
  server.registerTool('list_incoming_friend_requests', { description: listIncoming.description }, () => {
    onToolCall?.('list_incoming_friend_requests', {});
    return json(app.listIncomingFriendRequests());
  });

  const acceptReq = desc.acceptFriendRequest();
  server.registerTool(
    'accept_friend_request',
    {
      description: acceptReq.description,
      inputSchema: { username: z.string().describe(acceptReq.params.username) },
    },
    async ({ username }) => {
      onToolCall?.('accept_friend_request', { username });
      await app.acceptFriendRequestByUsername(username);
      return text(`Friend request from @${username} accepted`);
    },
  );

  const rejectReq = desc.rejectFriendRequest();
  server.registerTool(
    'reject_friend_request',
    {
      description: rejectReq.description,
      inputSchema: { username: z.string().describe(rejectReq.params.username) },
    },
    async ({ username }) => {
      onToolCall?.('reject_friend_request', { username });
      await app.rejectFriendRequestByUsername(username);
      return text(`Friend request from @${username} rejected`);
    },
  );

  const removeFriend = desc.removeFriend();
  server.registerTool(
    'remove_friend',
    {
      description: removeFriend.description,
      inputSchema: { username: z.string().describe(removeFriend.params.username) },
    },
    async ({ username }) => {
      onToolCall?.('remove_friend', { username });
      await app.removeFriendByUsername(username);
      return text(`Removed @${username} from friends`);
    },
  );
}
