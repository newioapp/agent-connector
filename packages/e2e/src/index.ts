/**
 * @newio/e2e — platform end-to-end test harness.
 *
 * Exports the building blocks: the owner-side REST client and the connector
 * runtime harness. Tests compose these with a {@link PuppetDriver} from
 * `@newio/acp-puppet` to drive deterministic, full-vertical scenarios
 * (human ↔ backend ↔ connector ↔ agent) without a real LLM agent.
 */
export { OwnerBackend } from './backend.js';
export type {
  OwnerTokens,
  AgentCredentials,
  ConversationSummary,
  MessageSummary,
  ActionRequestSummary,
  ActionOptionSummary,
} from './backend.js';
export { ConnectorHarness } from './connector-harness.js';
export type { ConnectorHarnessOptions } from './connector-harness.js';
export { DaemonHarness } from './daemon-harness.js';
export type { DaemonHarnessOptions } from './daemon-harness.js';
export { DaemonSandbox } from './daemon-sandbox.js';
export type { DaemonSandboxOptions, CliResult } from './daemon-sandbox.js';
export { resolveBackendUrls } from './config.js';
export type { BackendUrls } from './config.js';
