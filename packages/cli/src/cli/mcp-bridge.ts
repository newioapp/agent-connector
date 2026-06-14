/**
 * MCP stdio-to-UDS bridge — CLI-owned implementation.
 *
 * Run as `newio mcp-bridge <socket-path>`. An ACP agent (e.g. Kiro CLI) spawns
 * this as a stdio MCP server; it connects to the daemon's in-process MCP server
 * over a Unix domain socket and relays newline-delimited JSON-RPC messages
 * bidirectionally.
 *
 * This lives in the CLI package (not agent-engine) so the published, binary-only
 * `@newio/cli` never has to resolve the unpublished agent-engine bridge subpath
 * at runtime — that package is not installed for npm consumers. Keep this
 * dependency-free
 * (node built-ins only): the ACP agent launches it via `process.execPath`, so it
 * must run with nothing but the CLI's own files on disk.
 *
 * stdout is the MCP channel back to the agent — only relayed socket bytes go
 * there; all status/diagnostics go to stderr.
 */
import { connect } from 'net';
import { createInterface } from 'readline';

/**
 * Connect to `socketPath` and relay stdin↔socket until either side closes.
 * Exits the process on socket error (1) or socket close (0).
 */
export function runMcpBridge(socketPath: string): void {
  const socket = connect(socketPath);
  let connected = false;
  // Lines the agent sends before the (async) socket connect resolves. An MCP
  // client writes its `initialize` request the moment the bridge starts, which
  // can race ahead of the 'connect' event — buffer those and flush on connect so
  // the first request is never silently dropped (which would hang the agent).
  const pending: string[] = [];

  socket.on('connect', () => {
    connected = true;
    for (const line of pending) {
      socket.write(line + '\n');
    }
    pending.length = 0;
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

  // stdin (from agent) → socket (to daemon)
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (connected) {
      socket.write(line + '\n');
    } else {
      pending.push(line);
    }
  });
  rl.on('close', () => {
    socket.end();
  });

  // socket (from daemon) → stdout (to agent)
  const socketRl = createInterface({ input: socket, crlfDelay: Infinity });
  socketRl.on('line', (line) => {
    process.stdout.write(line + '\n');
  });
}
