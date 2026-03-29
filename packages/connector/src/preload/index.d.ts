/**
 * ConnectorAPI — the shape of `window.api` exposed to the renderer.
 */
import type { IpcApi } from '../shared/ipc-api';

export interface ConnectorAPI extends IpcApi {}

declare global {
  interface Window {
    api: ConnectorAPI;
  }
}
