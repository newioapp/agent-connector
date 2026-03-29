/**
 * Generic IPC registration — wires ipcMain.handle to handler methods
 * using a channel map.
 */
import { ipcMain } from 'electron';
import type { IpcApi } from '../shared/ipc-api';
import { IPC_CHANNELS } from '../shared/ipc-api';

/**
 * Register all IpcApi methods with ipcMain.handle.
 * Each channel invokes the corresponding method on the handler,
 * forwarding all arguments from the renderer.
 */
export function registerIpcHandlers(handler: IpcApi): void {
  for (const [method, channel] of Object.entries(IPC_CHANNELS)) {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => {
      return (handler[method as keyof IpcApi] as (...a: unknown[]) => unknown)(...args);
    });
  }
}
