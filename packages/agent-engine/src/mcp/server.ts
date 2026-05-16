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
import type { NewioApp } from '@newio/agent-sdk';
import { registerContactsTools } from './tools/contacts.js';
import { registerConversationsTools } from './tools/conversations.js';
import { registerCronTools } from './tools/cron.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerUsersTools } from './tools/users.js';
import { registerMediaTools } from './tools/media.js';
import { registerMemoryTools } from './tools/memory.js';
import { IdGetter } from './types.js';
import { AgentInstance } from '../agent-instance.js';

/**
 * Session mode controls which messaging tools are available:
 * - 'isolated': One session per conversation. Uses `initiate_conversation` for cross-conversation
 *   delegation. `send_dm` and `dm_owner` are blocked.
 * - 'shared': Single session serves all conversations. Uses `send_dm` and `dm_owner` directly.
 *   `initiate_conversation` is not available.
 */
export type SessionMode = 'isolated' | 'shared';

/**
 * MCP server that exposes Newio tools to agent sessions.
 *
 * @example
 * ```ts
 * const mcpServer = new NewioMcpServer(app, agent, 'isolated');
 * await mcpServer.connect(transport);
 * ```
 */

export class NewioMcpServer {
  private readonly server: McpServer;
  private getCurrentConversationId: IdGetter;

  constructor(app: NewioApp, agent: AgentInstance, sessionMode: SessionMode = 'isolated') {
    this.server = new McpServer({
      name: 'newio-mcp-server',
      version: '0.1.0',
    });

    this.getCurrentConversationId = () => undefined;
    registerContactsTools(this.server, app);
    registerConversationsTools(this.server, app);
    registerCronTools(this.server, app);
    registerMessagingTools(this.server, app, agent, () => this.getCurrentConversationId(), sessionMode);
    registerUsersTools(this.server, app);
    registerMediaTools(this.server, app, () => this.getCurrentConversationId());
    registerMemoryTools(this.server, app);
  }

  setCurrentConversationIdGetter(idGetter: IdGetter): void {
    this.getCurrentConversationId = idGetter;
  }

  /** Connect to a transport. */
  connect(transport: Transport): Promise<void> {
    return this.server.connect(transport);
  }
}

export type { Transport };
