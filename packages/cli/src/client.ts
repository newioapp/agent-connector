/**
 * DaemonClient — JSON-RPC 2.0 transport over Unix domain socket.
 *
 * Handles framing, request/response correlation, and push notification dispatch.
 * Application-level API lives in DaemonConnector.
 */
import { createConnection, type Socket } from 'net';
import type { AgentConfig, AgentRuntimeStatus, AgentInfo } from '@newio/agent-engine';

const AGENT_RUNTIME_STATUSES: readonly AgentRuntimeStatus[] = [
  'stopped',
  'stopping',
  'starting',
  'awaiting_approval',
  'initializing',
  'greeting',
  'running',
  'error',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentRuntimeStatus(value: unknown): value is AgentRuntimeStatus {
  return typeof value === 'string' && AGENT_RUNTIME_STATUSES.some((s) => s === value);
}

// The daemon is trusted (same protocol version, verified at connect), so these
// payload guards are lightweight shape checks — enough to drop a malformed frame
// rather than deliver a mistyped object to handlers.
function isAgentConfig(value: unknown): value is AgentConfig {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string';
}

function isAgentInfo(value: unknown): value is AgentInfo {
  return isRecord(value) && value.protocol === 'acp';
}

export interface DaemonNotificationHandlers {
  onStatusChanged?(agentId: string, status: AgentRuntimeStatus, error?: string): void;
  onApprovalUrl?(agentId: string, approvalUrl: string): void;
  onPollAttempt?(agentId: string): void;
  onConfigUpdated?(agentId: string, config: AgentConfig): void;
  onAgentInfo?(agentId: string, info: AgentInfo): void;
  onReloaded?(): void;
  /** Fired when the socket closes unexpectedly (daemon stopped/restarted), not on an explicit disconnect(). */
  onDisconnect?(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class DaemonClient {
  private socket: Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buf = '';
  private handlers: DaemonNotificationHandlers = {};

  connect(socketPath: string, handlers: DaemonNotificationHandlers = {}): Promise<void> {
    // Tear down any prior socket first, so its late data/close/error events can't
    // disturb the new connection (supports reconnecting clients like the desktop).
    this.disconnect();
    this.handlers = handlers;
    this.buf = '';
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.setEncoding('utf8');

      socket.once('connect', () => {
        this.socket = socket;
        resolve();
      });
      socket.once('error', reject);

      // Every handler below guards on `socket === this.socket`: once a socket has
      // been superseded (by disconnect() or a newer connect()) its events are
      // inert and must not touch shared state or fire onDisconnect.
      socket.on('data', (chunk: string) => {
        if (socket !== this.socket) {
          return;
        }
        this.buf += chunk;
        const lines = this.buf.split('\n');
        this.buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this.handleMessage(line);
        }
      });

      socket.on('close', () => {
        if (socket !== this.socket) {
          return;
        }
        this.socket = null;
        for (const [, pending] of this.pending) {
          pending.reject(new Error('Daemon connection closed'));
        }
        this.pending.clear();
        // The current socket dropping is a genuine, unexpected disconnect — an
        // explicit disconnect() nulls this.socket first, so we never reach here.
        this.handlers.onDisconnect?.();
      });

      socket.on('error', (err) => {
        if (socket !== this.socket) {
          return;
        }
        for (const [, pending] of this.pending) {
          pending.reject(err);
        }
        this.pending.clear();
      });
    });
  }

  disconnect(): void {
    // Null the field before destroying so the (async) close handler sees this
    // socket as superseded and stays silent — an explicit disconnect isn't a drop.
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    const msg = parsed;

    // Notification (no id).
    if (!('id' in msg)) {
      const method = msg.method;
      if (typeof method === 'string') {
        this.handleNotification(method, msg.params);
      }
      return;
    }

    // Response — correlate by id.
    const id = msg.id;
    if (typeof id !== 'number') {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);

    if ('error' in msg) {
      const message = isRecord(msg.error) && typeof msg.error.message === 'string' ? msg.error.message : 'RPC error';
      pending.reject(new Error(message));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (!isRecord(params)) {
      return;
    }
    const agentId = params.agentId;
    if (typeof agentId !== 'string') {
      // Every notification below is agent-scoped; drop malformed frames.
      if (method === 'daemon.reloaded') {
        this.handlers.onReloaded?.();
      }
      return;
    }

    switch (method) {
      case 'agent.statusChanged': {
        if (isAgentRuntimeStatus(params.status)) {
          const error = typeof params.error === 'string' ? params.error : undefined;
          this.handlers.onStatusChanged?.(agentId, params.status, error);
        }
        break;
      }
      case 'agent.approvalUrl':
        if (typeof params.approvalUrl === 'string') {
          this.handlers.onApprovalUrl?.(agentId, params.approvalUrl);
        }
        break;
      case 'agent.pollAttempt':
        this.handlers.onPollAttempt?.(agentId);
        break;
      case 'agent.configUpdated':
        if (isAgentConfig(params.config)) {
          this.handlers.onConfigUpdated?.(agentId, params.config);
        }
        break;
      case 'agent.acpInfo':
        if (isAgentInfo(params.info)) {
          this.handlers.onAgentInfo?.(agentId, params.info);
        }
        break;
    }
  }

  call<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      if (!this.socket) throw new Error('Not connected to daemon');
      this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
}
