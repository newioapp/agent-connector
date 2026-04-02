/**
 * Kiro CLI agent instance — manages multiple KiroCliSession instances.
 *
 * Each session is a separate kiro-cli ACP process with its own context window.
 * Session routing, idle cleanup, and the message processing loop are handled
 * by BaseAgentInstance. This class provides session creation and greeting logic.
 */
import { BaseAgentInstance } from './base-agent-instance';
import { KiroCliSession } from './kiro-cli-session';
import type { AgentSession } from '../agent-session';
import { Logger } from '../logger';

const log = new Logger('kiro-cli-instance');

export class KiroCliInstance extends BaseAgentInstance {
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected async onConnected(): Promise<void> {
    this.requireApp();
    if (!this.config.kiroCli) {
      throw new Error('Kiro CLI config missing');
    }
    await this.sendGreeting();
  }

  protected onStopped(): void {
    // All session cleanup handled by BaseAgentInstance.stop()
  }

  // ---------------------------------------------------------------------------
  // Session factory
  // ---------------------------------------------------------------------------

  protected async createSession(): Promise<AgentSession> {
    if (!this.config.kiroCli) {
      throw new Error('Kiro CLI config missing');
    }

    const session = await KiroCliSession.create(this.config.kiroCli);

    // Send Newio instruction as the first prompt so the session has context
    const instruction = this.requireApp().buildNewioInstruction();
    await session.prompt(instruction);

    return session;
  }

  protected async resumeSession(correlationId: string): Promise<AgentSession> {
    if (!this.config.kiroCli) {
      throw new Error('Kiro CLI config missing');
    }
    return KiroCliSession.resume(this.config.kiroCli, correlationId);
  }

  // ---------------------------------------------------------------------------
  // Greeting
  // ---------------------------------------------------------------------------

  private async sendGreeting(): Promise<void> {
    const app = this.requireApp();
    if (!app.identity.ownerId) {
      return;
    }

    // Find or create DM with owner
    const ownerDmConversationId = await app.getOwnerDmConversationId();
    if (!ownerDmConversationId) {
      return;
    }

    // Get or create the session for the owner DM
    const session = await this.getOrCreateSession(ownerDmConversationId);

    const ownerName = app.getOwnerDisplayName() ?? 'your owner';
    const prompt = `You just connected to the Newio messaging platform. Send a brief, friendly greeting to ${ownerName} to let them know you are online and ready. Keep it to 1-2 sentences.`;

    let greeting: string | undefined;
    try {
      greeting = await session.prompt(prompt);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new Error(`Kiro CLI connection test failed: ${message}`);
    }

    if (!greeting || greeting.trim().length === 0) {
      throw new Error('Kiro CLI test failed: agent returned an empty response');
    }

    await app.sendMessage(ownerDmConversationId, greeting.trim());
    log.info('Greeting sent to owner');
  }
}
