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
import type { SessionStreamSegment } from './session-stream';
import { Logger } from '../logger';

const log = new Logger('kiro-cli-instance');

export class KiroCliInstance extends BaseAgentInstance {
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected async onConnected(): Promise<void> {
    log.info('Kiro CLI instance connected, preparing greeting...');
    this.requireApp();
    if (!this.config.kiroCli) {
      throw new Error('Kiro CLI config missing');
    }
    await this.sendGreeting();
  }

  protected onStopped(): void {
    log.info('Kiro CLI instance stopped');
  }

  // ---------------------------------------------------------------------------
  // Session factory
  // ---------------------------------------------------------------------------

  protected async createSession(): Promise<AgentSession> {
    if (!this.config.kiroCli) {
      throw new Error('Kiro CLI config missing');
    }

    log.info('Creating new Kiro CLI session...');
    const session = await KiroCliSession.create(this.config.kiroCli);
    log.info(`Session created: ${session.correlationId}`);

    // Send Newio instruction as the first prompt so the session has context
    log.debug(`[${session.correlationId}] Sending Newio instruction to new session`);
    const instruction = this.requireApp().buildNewioInstruction();
    // Drain the generator — we don't need the instruction response
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of session.prompt(instruction)) {
      // discard
    }
    log.debug(`[${session.correlationId}] Newio instruction delivered`);

    return session;
  }

  protected async resumeSession(correlationId: string): Promise<AgentSession> {
    if (!this.config.kiroCli) {
      throw new Error('Kiro CLI config missing');
    }
    log.info(`Resuming Kiro CLI session: ${correlationId}`);
    return KiroCliSession.resume(this.config.kiroCli, correlationId);
  }

  // ---------------------------------------------------------------------------
  // Greeting
  // ---------------------------------------------------------------------------

  private async sendGreeting(): Promise<void> {
    const app = this.requireApp();
    if (!app.identity.ownerId) {
      log.warn('No ownerId set, skipping greeting');
      return;
    }

    // Find or create DM with owner
    log.debug('Finding or creating DM with owner...');
    const ownerDmConversationId = await app.getOwnerDmConversationId();
    if (!ownerDmConversationId) {
      log.warn('Could not get owner DM conversation, skipping greeting');
      return;
    }
    log.debug(`Owner DM conversation: ${ownerDmConversationId}`);

    this.setStatus('greeting');
    // Get or create the session for the owner DM
    const session = await this.getOrCreateSession(ownerDmConversationId);
    log.debug(`[${session.correlationId}] Generating greeting for owner...`);

    const ownerName = app.getOwnerDisplayName() ?? 'your owner';
    const prompt =
      `Context: You are running as an ACP (Agent Client Protocol) agent inside the Newio Agent Connector. ` +
      `The connector has already handled authentication and connected you to the Newio messaging platform on your behalf — you do not need to do anything to connect. ` +
      `This is a startup test to verify the connection is working. ` +
      `Your response will be sent as a message to ${ownerName} in your DM conversation.\n\n` +
      `Task: Write a brief, friendly greeting (1-2 sentences) to let ${ownerName} know you are online and ready. ` +
      `Just output the greeting text, nothing else.`;

    let greeting: string | undefined;
    try {
      greeting = await collectAgentMessage(session.prompt(prompt));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.error(`[${session.correlationId}] Greeting prompt failed: ${message}`);
      throw new Error(`Kiro CLI connection test failed: ${message}`);
    }

    if (!greeting || greeting.trim().length === 0) {
      log.error(`[${session.correlationId}] Agent returned empty greeting`);
      throw new Error('Kiro CLI test failed: agent returned an empty response');
    }

    await app.sendMessage(ownerDmConversationId, greeting.trim());
    log.info(`[${session.correlationId}] Greeting sent to owner`);
  }
}

/** Drain a prompt generator and return concatenated agent_message text. */
async function collectAgentMessage(gen: AsyncGenerator<SessionStreamSegment>): Promise<string | undefined> {
  const parts: string[] = [];
  for await (const segment of gen) {
    if (segment.type === 'agent_message_chunk') {
      parts.push(segment.text);
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}
