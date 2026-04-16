/**
 * InspectorAPI — the shape of `window.api` exposed to the renderer.
 */
import type { IpcApi } from '../shared/ipc-api';
import type { MainToRendererEvents } from '../shared/ipc-events';

export interface InspectorAPI extends IpcApi {
  onConnectionStatus(callback: (data: MainToRendererEvents['connection-status']) => void): () => void;
  onProtocolMessage(callback: (data: MainToRendererEvents['protocol-message']) => void): () => void;
  onSessionUpdate(callback: (data: MainToRendererEvents['session-update']) => void): () => void;
  onPermissionRequest(callback: (data: MainToRendererEvents['permission-request']) => void): () => void;
  onPromptDone(callback: (data: MainToRendererEvents['prompt-done']) => void): () => void;
}

declare global {
  interface Window {
    api: InspectorAPI;
  }
}
