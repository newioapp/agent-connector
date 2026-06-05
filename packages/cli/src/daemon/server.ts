/**
 * DaemonServer — JSON-RPC 2.0 transport over Unix domain socket.
 *
 * Handles framing, request/response routing, and push notification broadcast.
 * Application logic lives in DaemonHandler.
 */
import { createServer, type Server, type Socket } from 'net';
import { getLogger } from '@newio/agent-sdk';
import { RpcError, JsonRpcErrorCode } from './rpc.js';

const log = getLogger('daemon-server');

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params: unknown[];
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

function assertJsonRpcRequest(obj: unknown): asserts obj is JsonRpcRequest {
  if (
    typeof obj !== 'object' ||
    obj === null ||
    (obj as Record<string, unknown>)['jsonrpc'] !== '2.0' ||
    typeof (obj as Record<string, unknown>)['method'] !== 'string' ||
    !('id' in (obj as Record<string, unknown>))
  ) {
    throw new Error('Invalid JSON-RPC request');
  }
}

export interface RequestHandler {
  handle(method: string, params: unknown[]): Promise<unknown>;
}

export class DaemonServer {
  private readonly server: Server;
  private readonly clients = new Set<Socket>();
  private readonly handler: RequestHandler;

  constructor(handler: RequestHandler) {
    this.handler = handler;
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(socketPath, () => {
        this.server.off('error', reject);
        log.info(`Listening on ${socketPath}`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Broadcast a JSON-RPC notification to all connected clients. */
  notify(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params } satisfies JsonRpcNotification) + '\n';
    for (const client of this.clients) {
      client.write(msg);
    }
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    log.info(`Client connected (${this.clients.size} total)`);

    let buf = '';
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) void this.handleMessage(socket, line);
      }
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      log.info(`Client disconnected (${this.clients.size} remaining)`);
    });

    socket.on('error', (err) => {
      log.error('Socket error', err);
      this.clients.delete(socket);
    });
  }

  private async handleMessage(socket: Socket, raw: string): Promise<void> {
    let req: unknown;
    try {
      req = JSON.parse(raw);
      assertJsonRpcRequest(req);
    } catch {
      this.send(socket, {
        jsonrpc: '2.0',
        id: null,
        error: { code: JsonRpcErrorCode.ParseError, message: 'Parse error' },
      });
      return;
    }

    try {
      const result = await this.handler.handle(req.method, req.params);
      this.send(socket, { jsonrpc: '2.0', id: req.id, result });
    } catch (err) {
      // Preserve a typed RpcError's code; default unexpected errors to AppError.
      const code = err instanceof RpcError ? err.code : JsonRpcErrorCode.AppError;
      const message = err instanceof Error ? err.message : String(err);
      this.send(socket, { jsonrpc: '2.0', id: req.id, error: { code, message } });
    }
  }

  private send(socket: Socket, msg: JsonRpcSuccess | JsonRpcError): void {
    socket.write(JSON.stringify(msg) + '\n');
  }
}
