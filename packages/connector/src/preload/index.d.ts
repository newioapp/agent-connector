/**
 * ConnectorAPI — the shape of `window.api` exposed to the renderer.
 */
import type { IpcApi } from '../shared/ipc-api';
import type { MainToRendererEvents } from '../shared/ipc-events';

export interface ConnectorAPI extends IpcApi {
  /** The host OS platform (NodeJS.Platform, e.g. 'darwin' | 'win32' | 'linux'). Static; no IPC. */
  readonly platform: NodeJS.Platform;

  onAgentStatusChanged(callback: (data: MainToRendererEvents['agent-status-changed']) => void): () => void;
  onAgentApprovalUrl(callback: (data: MainToRendererEvents['agent-approval-url']) => void): () => void;
  onAgentPollAttempt(callback: (data: MainToRendererEvents['agent-poll-attempt']) => void): () => void;
  onAgentConfigUpdated(callback: (data: MainToRendererEvents['agent-config-updated']) => void): () => void;
  onAgentAcpInfo(callback: (data: MainToRendererEvents['agent-acp-info']) => void): () => void;
  onDaemonConnectionChanged(callback: (data: MainToRendererEvents['daemon-connection-changed']) => void): () => void;
  onAccountApprovalUrl(callback: (data: MainToRendererEvents['account-approval-url']) => void): () => void;
}

declare global {
  interface Window {
    api: ConnectorAPI;
  }
}
