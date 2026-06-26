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
import { registerContactsTools } from './tools/contacts.js';
import { registerConversationsTools } from './tools/conversations.js';
import { registerCronTools } from './tools/cron.js';
import { registerMessagingTools, type MessagingProfile } from './tools/messaging.js';
export type { MessagingProfile } from './tools/messaging.js';
import { registerUsersTools } from './tools/users.js';
import { registerMediaTools } from './tools/media.js';
import { registerMemoryTools } from './tools/memory.js';
import type { IdGetter, NewioAppForMcp, NewioMcpServerInterface, ToolCallHook } from './types.js';

export interface NewioMcpServerOptions {
  readonly app: NewioAppForMcp;
  /** Hand context to another of the agent's sessions (share_context tool). The target absorbs it. */
  readonly shareContext: (convId: string, context: string) => void;
  /** Which messaging tools this session gets, decided per session (not agent-wide). */
  readonly profile: MessagingProfile;
  /** For a share_context 'to-hub' profile: the chat hub (owner DM) conversation context is handed to. */
  readonly hubConversationId?: string;
  /** Whether the agent has long-term memory enabled. When false, the memory tools are not registered. */
  readonly memoryEnabled: boolean;
  /** Optional hook called before each tool invocation. */
  readonly onToolCall?: ToolCallHook;
}

/**
 * MCP server that exposes Newio tools to agent sessions.
 *
 * @example
 * ```ts
 * const mcpServer = new NewioMcpServer({ app, agent, sessionMode: 'isolated' });
 * await mcpServer.connect(transport);
 * ```
 */

export class NewioMcpServer implements NewioMcpServerInterface {
  private readonly server: McpServer;
  private getCurrentConversationId: IdGetter;

  constructor(opts: NewioMcpServerOptions) {
    this.server = new McpServer({
      name: 'newio-mcp-server',
      version: '0.1.0',
    });

    const { app, shareContext, profile, hubConversationId, memoryEnabled, onToolCall } = opts;

    this.getCurrentConversationId = () => undefined;
    registerContactsTools(this.server, app, onToolCall);
    registerConversationsTools(this.server, app, onToolCall);
    registerCronTools(this.server, app, onToolCall);
    registerMessagingTools(
      this.server,
      app,
      shareContext,
      () => this.getCurrentConversationId(),
      profile,
      hubConversationId,
      onToolCall,
    );
    registerUsersTools(this.server, app, onToolCall);
    registerMediaTools(this.server, app, () => this.getCurrentConversationId(), onToolCall);
    if (memoryEnabled) {
      registerMemoryTools(this.server, app, onToolCall);
    }
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
