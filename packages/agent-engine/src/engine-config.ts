/**
 * EngineConfig — runtime configuration for the agent engine.
 *
 * Replaces build-time defines (__API_BASE_URL__, __WS_BASE_URL__, etc.).
 * Consumers construct this from their own config sources (env vars, build-time defines, etc.)
 * and pass it when initializing the engine.
 */

export interface EngineConfig {
  /** Newio REST API base URL (e.g. "https://api.newio.app"). */
  readonly apiBaseUrl: string;
  /** Newio WebSocket URL (e.g. "wss://ws.newio.app"). */
  readonly wsUrl: string;
  /** Deployment stage. */
  readonly stage: 'dev' | 'integ' | 'prod';
  /** Display name of the host application (e.g. "Newio Connector"). */
  readonly appDisplayName: string;
  /** Version of the host application (e.g. "1.2.3"). */
  readonly appVersion: string;
  /** Directory for persistent data (config, tokens). Typically ~/.newio/connector/ or similar. */
  readonly dataDir: string;
  /**
   * Command an ACP agent runs to launch the Newio MCP bridge (a stdio↔UDS relay).
   * Typically `process.execPath` (the running Node binary).
   */
  readonly mcpBridgeCommand: string;
  /**
   * Args placed before the MCP socket path when launching the bridge. The socket
   * path is appended at session creation, so the final argv is
   * `[...mcpBridgeArgsPrefix, mcpSocketPath]`. Typically
   * `[<absolute-cli-entry>, 'mcp-bridge']`.
   */
  readonly mcpBridgeArgsPrefix: readonly string[];
  /** Override the proactive WebSocket reconnect interval in ms (default: 1h50m). */
  readonly wsProactiveReconnectMs?: number;
}
