/**
 * Type-safe push events from main process → renderer process.
 *
 * These are one-way events sent via webContents.send / ipcRenderer.on.
 * Separate from the request/response IPC API in ipc-api.ts.
 */
import type { AgentRuntimeStatus, AgentConfig } from './types';

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
  readonly 'agent-config-updated': {
    readonly agentId: string;
    readonly config: AgentConfig;
  };
}

/** All push event channel names. */
export const EVENT_CHANNELS: { readonly [K in keyof MainToRendererEvents]: K } = {
  'agent-status-changed': 'agent-status-changed',
  'agent-approval-url': 'agent-approval-url',
  'agent-config-updated': 'agent-config-updated',
};
