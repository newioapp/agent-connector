#!/usr/bin/env node
/**
 * MCP stdio-to-UDS bridge.
 *
 * Spawned by an ACP agent (e.g., Kiro CLI) as a stdio MCP server.
 * Connects to the Agent Connector's in-process MCP server via
 * a Unix domain socket and relays JSON-RPC messages bidirectionally.
 *
 * Usage: newio-mcp-bridge <socket-path>
 */
import { connect } from 'net';
import { createInterface } from 'readline';

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write('Usage: newio-mcp-bridge <socket-path>\n');
  process.exit(1);
}

const socket = connect(socketPath);
let connected = false;

socket.on('connect', () => {
  connected = true;
  process.stderr.write(`[newio-mcp-bridge] Connected to ${socketPath}\n`);
});

socket.on('error', (err) => {
  process.stderr.write(`[newio-mcp-bridge] Socket error: ${err.message}\n`);
  process.exit(1);
});

socket.on('close', () => {
  process.stderr.write('[newio-mcp-bridge] Socket closed\n');
  process.exit(0);
});

// stdin (from agent) → socket (to connector)
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (connected) {
    socket.write(line + '\n');
  }
});
rl.on('close', () => {
  socket.end();
});

// socket (from connector) → stdout (to agent)
const socketRl = createInterface({ input: socket, crlfDelay: Infinity });
socketRl.on('line', (line) => {
  process.stdout.write(line + '\n');
});
