/**
 * @newio/acp-puppet — a deterministic, test-driven ACP agent for platform
 * end-to-end tests.
 *
 * The library entry exports the test-facing PuppetDriver and the control
 * protocol types. The executable (`./bin`) is what the connector spawns as a
 * `custom` agent; it is not imported, only launched.
 */
export { PuppetDriver } from './driver.js';
export type { PuppetPrompt, PromptHandler, PromptHandlerResult, PuppetDriverOptions } from './driver.js';
export { PuppetAgent } from './agent.js';
export { DefaultControl, SocketControl } from './control.js';
export type { PuppetControl } from './control.js';
export type {
  TurnAction,
  TurnInstruction,
  PuppetStopReason,
  PromptEvent,
  PuppetLifecycleEvent,
  PuppetMessage,
  DriverMessage,
} from './protocol.js';
