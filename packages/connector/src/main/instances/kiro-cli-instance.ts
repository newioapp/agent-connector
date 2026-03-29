/**
 * Kiro CLI agent instance — spawns a kiro-cli process and bridges with Newio.
 *
 * C5 will implement the actual process spawning and ACP bridging. For now,
 * this is a stub that connects to Newio and logs that it's ready.
 */
import { BaseAgentInstance } from './base-agent-instance';

export class KiroCliInstance extends BaseAgentInstance {
  protected async onConnected(): Promise<void> {
    // C5: Spawn kiro-cli chat --agent <name>, bridge via ACP
  }

  protected async onStopped(): Promise<void> {
    // C5: Kill kiro-cli process
  }
}
