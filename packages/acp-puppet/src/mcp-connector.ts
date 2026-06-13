/**
 * MCP client layer for the puppet.
 *
 * A real ACP agent connects to the MCP servers the connector hands it at session
 * setup and calls their tools. The puppet does the same so it can drive
 * cross-conversation and memory flows (`send_message`, `send_dm`, `add_memory`, …).
 *
 * The behavior is behind a small {@link McpConnector} interface so tests can
 * inject a fake (no subprocess); production uses {@link StdioMcpConnector}, which
 * spawns the connector-provided bridge command and speaks MCP over its stdio.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type * as acp from '@agentclientprotocol/sdk';

export interface McpToolResult {
  readonly isError: boolean;
  readonly text: string;
}

/** A live connection to one MCP server. */
export interface McpConnection {
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

/** Establishes {@link McpConnection}s from the ACP-provided server specs. */
export interface McpConnector {
  connect(server: acp.McpServer): Promise<McpConnection>;
}

/** Array.isArray widens to `any[]`; this guard keeps elements as `unknown`. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Pull the text out of an MCP tool result's content blocks. */
function resultText(content: unknown): string {
  if (!isUnknownArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'text' in block) {
      const value: unknown = block.text;
      if (typeof value === 'string') {
        parts.push(value);
      }
    }
  }
  return parts.join('');
}

class StdioMcpConnection implements McpConnection {
  constructor(private readonly client: Client) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.client.callTool({ name, arguments: args });
    return { isError: result.isError === true, text: resultText(result.content) };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** Default connector: spawns the bridge command and speaks MCP over stdio. */
export class StdioMcpConnector implements McpConnector {
  async connect(server: acp.McpServer): Promise<McpConnection> {
    if (!('command' in server)) {
      throw new Error(`MCP server "${server.name}" is not a stdio server`);
    }
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    for (const pair of server.env) {
      env[pair.name] = pair.value;
    }
    const transport = new StdioClientTransport({ command: server.command, args: server.args, env });
    const client = new Client({ name: 'newio-acp-puppet', version: '0.1.0' });
    await client.connect(transport);
    return new StdioMcpConnection(client);
  }
}
