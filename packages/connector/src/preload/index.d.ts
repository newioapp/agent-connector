/**
 * ConnectorAPI — the shape of `window.api` exposed to the renderer.
 */
import type { IpcApi } from '../shared/ipc-api';
import type { MainToRendererEvents } from '../shared/ipc-events';

export interface ConnectorAPI extends IpcApi {
  onAgentStatusChanged(callback: (data: MainToRendererEvents['agent-status-changed']) => void): () => void;
  onAgentApprovalUrl(callback: (data: MainToRendererEvents['agent-approval-url']) => void): () => void;
  onAgentConfigUpdated(callback: (data: MainToRendererEvents['agent-config-updated']) => void): () => void;
}

declare global {
  interface Window {
    api: ConnectorAPI;
  }
}
