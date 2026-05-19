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
  const lf = desc.listFriends();
  server.registerTool(lf.toolName, { description: lf.description }, () => {
    onToolCall?.(lf.toolName, {});
    return json(app.getAllContacts());
  });

  const sfr = desc.sendFriendRequest();
  server.registerTool(
    sfr.toolName,
    {
      description: sfr.description,
      inputSchema: {
        username: z.string().describe(sfr.params.username),
        note: z.string().optional().describe(sfr.params.note),
      },
    },
    async ({ username, note }) => {
      onToolCall?.(sfr.toolName, { username, note });
      await app.sendFriendRequestByUsername(username, note);
      return text(`Friend request sent to @${username}`);
    },
  );

  const lifr = desc.listIncomingFriendRequests();
  server.registerTool(lifr.toolName, { description: lifr.description }, () => {
    onToolCall?.(lifr.toolName, {});
    return json(app.listIncomingFriendRequests());
  });

  const afr = desc.acceptFriendRequest();
  server.registerTool(
    afr.toolName,
    {
      description: afr.description,
      inputSchema: { username: z.string().describe(afr.params.username) },
    },
    async ({ username }) => {
      onToolCall?.(afr.toolName, { username });
      await app.acceptFriendRequestByUsername(username);
      return text(`Friend request from @${username} accepted`);
    },
  );

  const rfr = desc.rejectFriendRequest();
  server.registerTool(
    rfr.toolName,
    {
      description: rfr.description,
      inputSchema: { username: z.string().describe(rfr.params.username) },
    },
    async ({ username }) => {
      onToolCall?.(rfr.toolName, { username });
      await app.rejectFriendRequestByUsername(username);
      return text(`Friend request from @${username} rejected`);
    },
  );

  const rf = desc.removeFriend();
  server.registerTool(
    rf.toolName,
    {
      description: rf.description,
      inputSchema: { username: z.string().describe(rf.params.username) },
    },
    async ({ username }) => {
      onToolCall?.(rf.toolName, { username });
      await app.removeFriendByUsername(username);
      return text(`Removed @${username} from friends`);
    },
  );
}
