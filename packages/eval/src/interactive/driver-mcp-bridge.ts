#!/usr/bin/env node
/**
 * Driver MCP stdio bridge.
 *
 * Connects to a DriverMcpServer hosted on a Unix domain socket and relays
 * JSON-RPC messages between stdio and the socket. Reuses the same bridge
 * pattern as the standard Newio MCP server.
 *
 * Usage: driver-mcp-bridge <socket-path>
 */
import { connect } from 'net';
import { createInterface } from 'readline';

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write('Usage: driver-mcp-bridge <socket-path>\n');
  process.exit(1);
}

const socket = connect(socketPath);
let connected = false;

socket.on('connect', () => {
  connected = true;
  process.stderr.write(`[driver-mcp-bridge] Connected to ${socketPath}\n`);
});

socket.on('error', (err) => {
  process.stderr.write(`[driver-mcp-bridge] Socket error: ${err.message}\n`);
  process.exit(1);
});

socket.on('close', () => {
  process.stderr.write('[driver-mcp-bridge] Socket closed\n');
  process.exit(0);
});

// stdin (from agent) → socket (to driver server)
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (connected) {
    socket.write(line + '\n');
  }
});
rl.on('close', () => {
  socket.end();
});

// socket (from driver server) → stdout (to agent)
const socketRl = createInterface({ input: socket, crlfDelay: Infinity });
socketRl.on('line', (line) => {
  process.stdout.write(line + '\n');
});
