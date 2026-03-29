/**
 * Claude agent instance — bridges Newio messages with Claude via the Anthropic Agent SDK.
 *
 * C4 will implement the actual Claude bridging. For now, this is a stub that
 * connects to Newio and logs that it's ready.
 */
import { BaseAgentInstance } from './base-agent-instance';

export class ClaudeInstance extends BaseAgentInstance {
  protected async onConnected(): Promise<void> {
    // C4: Initialize Claude Agent SDK, register MCP tools, bridge messages
  }

  protected async onStopped(): Promise<void> {
    // C4: Shut down Claude session
  }
}
