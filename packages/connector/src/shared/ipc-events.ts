/**
 * Type-safe push events from main process → renderer process.
 *
 * These are one-way events sent via webContents.send / ipcRenderer.on.
 * Separate from the request/response IPC API in ipc-api.ts.
 */
import type { AgentRuntimeStatus } from './types';

export interface MainToRendererEvents {
  readonly 'agent-status-changed': {
    readonly agentId: string;
    readonly status: AgentRuntimeStatus;
    readonly error?: string;
  };
}

/** All push event channel names. */
export const EVENT_CHANNELS: { readonly [K in keyof MainToRendererEvents]: K } = {
  'agent-status-changed': 'agent-status-changed',
};
