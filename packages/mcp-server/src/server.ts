/**
 * NewioMcpServer — MCP server for the Newio messaging platform.
 *
 * Wraps a {@link NewioApp} instance and exposes developer-friendly MCP tools
 * with username-based lookups instead of UUIDs. Transport-agnostic — callers
 * provide the transport (stdio, socket, etc.).
 *
 * Supports a mutable `sessionId` that is injected after construction, allowing
 * conversation-creation tools to inherit the agent's current session context.
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
 * MCP server that exposes Newio tools to agent sessions.
 *
 * The `sessionId` is set after construction — conversation-creation tools
 * read it lazily at call time so the value is always up to date.
 *
 * @example
 * ```ts
 * const mcpServer = new NewioMcpServer(app);
 * await mcpServer.connect(transport);
 * // Later, after the agent session is launched:
 * mcpServer.setSessionId('session-abc');
 * ```
 */
export class NewioMcpServer {
  private readonly server: McpServer;
  private sessionId: string | undefined;

  constructor(app: NewioApp) {
    this.server = new McpServer({
      name: 'newio-mcp-server',
      version: '0.1.0',
    });

    registerContactsTools(this.server, app);
    registerConversationsTools(this.server, app, () => this.sessionId);
    registerMessagingTools(this.server, app);
    registerUsersTools(this.server, app);
    registerMediaTools(this.server, app);
  }

  /** Set the Newio session ID for this MCP connection. */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** Get the current Newio session ID, if set. */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Connect to a transport. */
  connect(transport: Transport): Promise<void> {
    return this.server.connect(transport);
  }
}

export type { Transport };
