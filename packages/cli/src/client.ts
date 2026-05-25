/**
 * DaemonClient — JSON-RPC 2.0 transport over Unix domain socket.
 *
 * Handles framing, request/response correlation, and push notification dispatch.
 * Application-level API lives in DaemonConnector.
 */
import { createConnection, type Socket } from 'net';
import type { AgentConfig, AgentRuntimeStatus, AgentInfo } from '@newio/agent-engine';

export interface DaemonNotificationHandlers {
  onStatusChanged?(agentId: string, status: AgentRuntimeStatus, error?: string): void;
  onApprovalUrl?(agentId: string, approvalUrl: string): void;
  onPollAttempt?(agentId: string): void;
  onConfigUpdated?(agentId: string, config: AgentConfig): void;
  onAgentInfo?(agentId: string, info: AgentInfo): void;
  onReloaded?(): void;
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
    this.handlers = handlers;
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.setEncoding('utf8');

      socket.once('connect', () => {
        this.socket = socket;
        resolve();
      });
      socket.once('error', reject);

      socket.on('data', (chunk: string) => {
        this.buf += chunk;
        const lines = this.buf.split('\n');
        this.buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this.handleMessage(line);
        }
      });

      socket.on('close', () => {
        this.socket = null;
        // Reject all pending requests
        for (const [, pending] of this.pending) {
          pending.reject(new Error('Daemon connection closed'));
        }
        this.pending.clear();
      });

      socket.on('error', (err) => {
        for (const [, pending] of this.pending) {
          pending.reject(err);
        }
        this.pending.clear();
      });
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    // Notification (no id)
    if (!('id' in msg)) {
      this.handleNotification(msg.method as string, msg.params);
      return;
    }

    // Response
    const pending = this.pending.get(msg.id as number);
    if (!pending) return;
    this.pending.delete(msg.id as number);

    if ('error' in msg) {
      const err = msg.error as { message: string };
      pending.reject(new Error(err.message));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    switch (method) {
      case 'agent.statusChanged':
        this.handlers.onStatusChanged?.(
          p.agentId as string,
          p.status as AgentRuntimeStatus,
          p.error as string | undefined,
        );
        break;
      case 'agent.approvalUrl':
        this.handlers.onApprovalUrl?.(p.agentId as string, p.approvalUrl as string);
        break;
      case 'agent.pollAttempt':
        this.handlers.onPollAttempt?.(p.agentId as string);
        break;
      case 'agent.configUpdated':
        this.handlers.onConfigUpdated?.(p.agentId as string, p.config as AgentConfig);
        break;
      case 'agent.acpInfo':
        this.handlers.onAgentInfo?.(p.agentId as string, p.info as AgentInfo);
        break;
      case 'daemon.reloaded':
        this.handlers.onReloaded?.();
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
