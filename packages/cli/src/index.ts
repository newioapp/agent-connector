export { DaemonClient } from './client.js';
export { DaemonConnector } from './connector.js';
export type { DaemonHandshake } from './connector.js';
export type { DaemonNotificationHandlers } from './client.js';
export { RPC_PROTOCOL_VERSION } from './daemon/rpc.js';
// Path + stage resolution, so the desktop can locate the per-stage daemon socket.
export { getDaemonPaths, resolveStage } from './paths.js';
export type { Stage, DaemonPaths } from './paths.js';
