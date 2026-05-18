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
import type { IdGetter, ToolCallHook } from './types.js';
import type { SessionMode } from '../types.js';
import { DefaultToolDescriptions, type ToolDescriptions } from './tool-descriptions.js';

export interface NewioMcpServerOptions {
  readonly app: NewioApp;
  readonly initiateConversation: (convId: string, context: string) => void;
  readonly sessionMode: SessionMode;
  /** Optional hook called before each tool invocation. */
  readonly onToolCall?: ToolCallHook;
  /** Optional custom tool descriptions. Defaults to DefaultToolDescriptions. */
  readonly toolDescriptions?: ToolDescriptions;
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

export class NewioMcpServer {
  private readonly server: McpServer;
  private getCurrentConversationId: IdGetter;

  constructor(opts: NewioMcpServerOptions) {
    this.server = new McpServer({
      name: 'newio-mcp-server',
      version: '0.1.0',
    });

    const { app, initiateConversation, sessionMode, onToolCall } = opts;
    const descriptions = opts.toolDescriptions ?? new DefaultToolDescriptions();

    this.getCurrentConversationId = () => undefined;
    registerContactsTools(this.server, app, descriptions, onToolCall);
    registerConversationsTools(this.server, app, descriptions, onToolCall);
    registerCronTools(this.server, app, descriptions, onToolCall);
    registerMessagingTools(
      this.server,
      app,
      descriptions,
      initiateConversation,
      () => this.getCurrentConversationId(),
      sessionMode,
      onToolCall,
    );
    registerUsersTools(this.server, app, descriptions, onToolCall);
    registerMediaTools(this.server, app, descriptions, () => this.getCurrentConversationId(), onToolCall);
    registerMemoryTools(this.server, app, descriptions, onToolCall);
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
