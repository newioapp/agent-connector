/**
 * NewioMcpServer — MCP server for the Newio messaging platform.
 *
 * Wraps a {@link NewioApp} instance and exposes developer-friendly MCP tools
 * with username-based lookups instead of UUIDs. Transport-agnostic — callers
 * provide the transport (stdio, socket, etc.).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { NewioApp } from '@newio/sdk';
import { registerContactsTools } from './tools/contacts.js';
import { registerConversationsTools } from './tools/conversations.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerUsersTools } from './tools/users.js';
import { registerMediaTools } from './tools/media.js';

/**
 * Create and configure a Newio MCP server.
 *
 * @param app - A fully initialized {@link NewioApp} instance (pre-authenticated).
 * @returns An {@link McpServer} with all Newio tools registered.
 *
 * @example
 * ```ts
 * import { NewioApp } from '@newio/sdk';
 * import { createMcpServer } from '@newio/mcp-server';
 * import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
 *
 * const app = await NewioApp.create({ ... });
 * const server = createMcpServer(app);
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function createMcpServer(app: NewioApp): McpServer {
  const server = new McpServer({
    name: `newio-mcp-server`,
    version: '0.1.0',
  });

  registerContactsTools(server, app);
  registerConversationsTools(server, app);
  registerMessagingTools(server, app);
  registerUsersTools(server, app);
  registerMediaTools(server, app);

  return server;
}

export type { Transport };
