/**
 * Type-safe push events from main process → renderer process.
 *
 * These are one-way events sent via webContents.send / ipcRenderer.on.
 * Separate from the request/response IPC API in ipc-api.ts.
 */
import type { AgentRuntimeStatus, AgentConfig, AgentInfo } from './types';

/**
 * State of the connection to the daemon (the runtime the desktop is a thin client
 * of). The desktop attaches to the per-stage daemon over a Unix socket.
 */
export type DaemonConnectionStatus =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected'; readonly daemonVersion: string; readonly stage: string; readonly apiBaseUrl: string }
  /** The daemon isn't running (socket unreachable) or the connection dropped. */
  | { readonly kind: 'unreachable' }
  /** The daemon's RPC protocol major doesn't match the desktop's — one side needs updating. */
  | { readonly kind: 'protocol-mismatch'; readonly daemonProtocol: number; readonly clientProtocol: number };

export interface MainToRendererEvents {
  readonly 'agent-status-changed': {
    readonly agentId: string;
    readonly status: AgentRuntimeStatus;
    readonly error?: string;
  };
  readonly 'agent-approval-url': {
    readonly agentId: string;
    readonly approvalUrl: string;
  };
  readonly 'agent-poll-attempt': {
    readonly agentId: string;
  };
  readonly 'agent-config-updated': {
    readonly agentId: string;
    readonly config: AgentConfig;
  };
  readonly 'agent-acp-info': {
    readonly agentId: string;
    readonly info: AgentInfo;
  };
  readonly 'daemon-connection-changed': DaemonConnectionStatus;
  /** Approval URL for an in-progress create-account flow, so the UI can show a link. */
  readonly 'account-approval-url': {
    readonly url: string;
  };
}

/** All push event channel names. */
export const EVENT_CHANNELS: { readonly [K in keyof MainToRendererEvents]: K } = {
  'agent-status-changed': 'agent-status-changed',
  'agent-approval-url': 'agent-approval-url',
  'agent-poll-attempt': 'agent-poll-attempt',
  'agent-config-updated': 'agent-config-updated',
  'agent-acp-info': 'agent-acp-info',
  'daemon-connection-changed': 'daemon-connection-changed',
  'account-approval-url': 'account-approval-url',
};
