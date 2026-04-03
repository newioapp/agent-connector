/**
 * UDS server for hosting an MCP server over a Unix domain socket.
 *
 * Used by the Agent Connector to expose an in-process MCP server
 * that the stdio bridge connects to.
 */
import { createServer, type Server, type Socket } from 'net';
import { unlinkSync } from 'fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface UdsServerOptions {
  /** Path to the Unix domain socket. */
  readonly socketPath: string;
  /** Called for each new connection with a Transport to pass to `mcpServer.connect()`. */
  readonly onConnection: (transport: Transport) => void;
}

/**
 * Start a UDS server that creates MCP transports for incoming connections.
 * Returns the `net.Server` for lifecycle management.
 */
export function startUdsServer(opts: UdsServerOptions): Server {
  // Clean up stale socket file
  try {
    unlinkSync(opts.socketPath);
  } catch {
    // doesn't exist, fine
  }

  const server = createServer((socket: Socket) => {
    const transport = new StdioServerTransport(socket, socket);
    socket.on('close', () => {
      void transport.close();
    });
    opts.onConnection(transport);
  });

  server.listen(opts.socketPath);
  return server;
}
